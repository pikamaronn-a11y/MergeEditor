/* ─── Monaco Environment ─────────────────────────── */
self.MonacoEnvironment = {
    getWorker: function (workerId, label) {
        const workerPath = new URL('../node_modules/monaco-editor/min/vs/base/worker/workerMain.js', document.baseURI).href;
        return new Worker(workerPath);
    }
};

require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });

/* ─── Global State ───────────────────────────────── */
let editor = null;
let currentFilePath = null;
let isDirty = false;
let lastKnownFileContent = '';
let isApplyingFileChange = false;
let highlightedRanges = [];          // [{startLine, endLine, blockIndex}]
let changeDecorationIds = [];        // デコレーションID配列
let pendingFileChange = null;
let currentLanguage = 'plaintext';
let currentFontFamily = 'Consolas';
let currentFontSize = 12;
let currentUiFontFamily = 'Segoe UI';
let currentUiFontSize = 10;
let currentEncoding = 'utf-8';
let blockChoices = [];               // null=未解決, 'mine'=自分, 'external'=外部
let conflictViewZoneIds = [];        // View Zone ID配列
let conflictWidgets = [];             // ContentWidget配列

/* ─── UI Elements ────────────────────────────────── */
const statusChangeIndicator = document.getElementById('status-change-indicator');
const statusPendingCollision = document.getElementById('status-pending-collision');
const conflictToolbar = document.getElementById('conflict-toolbar');
const conflictAcceptAllBtn = document.getElementById('conflict-accept-all-btn');
const conflictKeepAllBtn = document.getElementById('conflict-keep-all-btn');
const conflictToolbarInfo = conflictToolbar.querySelector('.conflict-toolbar-info');
const statusFont = document.getElementById('status-font');

/* ─── Utility Functions ──────────────────────────── */

function updateFileName() {
    const prefix = isDirty ? '● ' : '';
    var title;
    if (currentFilePath) {
        title = prefix + currentFilePath.split(/[\\/]/).pop();
    } else {
        title = prefix + '（新規ファイル）';
    }
    document.title = title;
    window.electronAPI.setTitle(title);
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Hunkベースの行diff（改行正規化 + 挿入優先バックトラック） */
function computeHunks(oldText, newText) {
    var oldNormalized = oldText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var newNormalized = newText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    var oldLines = oldNormalized.split('\n');
    var newLines = newNormalized.split('\n');
    var m = oldLines.length;
    var n = newLines.length;

    if (m > 2000 || n > 2000) {
        var prefix = 0;
        while (prefix < m && prefix < n && oldLines[prefix] === newLines[prefix]) prefix++;
        var oldSuf = m - 1, newSuf = n - 1;
        while (oldSuf >= prefix && newSuf >= prefix && oldLines[oldSuf] === newLines[newSuf]) { oldSuf--; newSuf--; }
        var fb = [];
        if (oldSuf >= prefix || newSuf >= prefix) {
            fb.push({
                oldStart: prefix + 1, oldEnd: oldSuf + 1,
                newStart: prefix + 1, newEnd: newSuf + 1,
                oldText: oldLines.slice(prefix, oldSuf + 1).join('\n'),
                newText: newLines.slice(prefix, newSuf + 1).join('\n'),
                oldLineCount: Math.max(0, oldSuf - prefix + 1),
                newLineCount: Math.max(0, newSuf - prefix + 1)
            });
        }
        return fb;
    }

    var dp = [];
    for (var i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
    for (var i2 = 1; i2 <= m; i2++) {
        for (var j = 1; j <= n; j++) {
            if (oldLines[i2 - 1] === newLines[j - 1]) dp[i2][j] = dp[i2 - 1][j - 1] + 1;
            else dp[i2][j] = Math.max(dp[i2 - 1][j], dp[i2][j - 1]);
        }
    }

    var ops = [];
    var bi = m, bj = n;
    while (bi > 0 && bj > 0) {
        if (oldLines[bi - 1] === newLines[bj - 1]) {
            ops.unshift({ type: 'match', oldIdx: bi - 1, newIdx: bj - 1, text: oldLines[bi - 1] });
            bi--; bj--;
        } else if (dp[bi][bj - 1] >= dp[bi - 1][bj]) {
            ops.unshift({ type: 'insert', newIdx: bj - 1, text: newLines[bj - 1] });
            bj--;
        } else {
            ops.unshift({ type: 'delete', oldIdx: bi - 1, text: oldLines[bi - 1] });
            bi--;
        }
    }
    while (bi > 0) { ops.unshift({ type: 'delete', oldIdx: bi - 1, text: oldLines[bi - 1] }); bi--; }
    while (bj > 0) { ops.unshift({ type: 'insert', newIdx: bj - 1, text: newLines[bj - 1] }); bj--; }

    var hunks = [];
    var cur = null;
    var oldPos = 0, newPos = 0;

    for (var k = 0; k < ops.length; k++) {
        var op = ops[k];
        if (op.type === 'match') {
            if (cur) { hunks.push(cur); cur = null; }
            oldPos = op.oldIdx + 1;
            newPos = op.newIdx + 1;
        } else {
            if (!cur) { cur = { oldStart0: oldPos, newStart0: newPos, oldTexts: [], newTexts: [] }; }
            if (op.type === 'delete') { cur.oldTexts.push(op.text); oldPos++; }
            else { cur.newTexts.push(op.text); newPos++; }
        }
    }
    if (cur) hunks.push(cur);

    return hunks.map(function (h) {
        return {
            oldStart: h.oldStart0 + 1, oldEnd: h.oldStart0 + h.oldTexts.length,
            newStart: h.newStart0 + 1, newEnd: h.newStart0 + h.newTexts.length,
            oldText: h.oldTexts.join('\n'), newText: h.newTexts.join('\n'),
            oldLineCount: h.oldTexts.length, newLineCount: h.newTexts.length
        };
    });
}

/* ─── Highlight Management ───────────────────────── */

function clearChangeHighlights() {
    highlightedRanges = [];
    if (changeDecorationIds.length > 0 && editor) {
        changeDecorationIds = editor.deltaDecorations(changeDecorationIds, []);
    }
    removeAllConflictWidgets();
    updateChangeIndicator();
}

function rebuildDecorations() {
    if (!editor) return;
    var decorations = highlightedRanges.map(function (r) {
        return {
            range: new monaco.Range(r.startLine, 1, r.endLine, 1),
            options: {
                isWholeLine: true,
                className: 'line-modified-background',
                glyphMarginClassName: 'modified-glyph-margin',
                glyphMarginHoverMessage: { value: '外部で更新された行' },
                minimap: {
                    color: '#ffaa00',
                    position: monaco.editor.MinimapPosition.Inline
                }
            }
        };
    });
    changeDecorationIds = editor.deltaDecorations(changeDecorationIds, decorations);
}

function updateChangeIndicator() {
    if (highlightedRanges.length > 0) {
        var totalLines = highlightedRanges.reduce(function (sum, r) { return sum + (r.endLine - r.startLine + 1); }, 0);
        statusChangeIndicator.textContent = '⚠️ 外部更新: ' + totalLines + '行';
        statusChangeIndicator.classList.remove('hidden');
    } else {
        statusChangeIndicator.classList.add('hidden');
    }
}

/* ─── ContentWidget Management ───────────────────── */

/**
 * ViewZoneで空白を作り、同じ位置にContentWidgetを配置して
 * インタラクティブなパネルを表示する（Monacoの仕様対策 [1]）
 */
function addConflictPanelsForBlocks(blocks) {
    if (!editor || !pendingFileChange) return;

    // 一旦仮の高さでViewZoneとWidgetを作成
    editor.changeViewZones(function (accessor) {
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            var panelHeight = 180; // 仮の高さ

            var zoneDomNode = document.createElement('div');
            zoneDomNode.className = 'conflict-viewzone-spacer';
            zoneDomNode.style.width = '100%';
            zoneDomNode.style.height = panelHeight + 'px';

            var zoneId = accessor.addZone({
                afterLineNumber: b.endLine,
                heightInPx: panelHeight,
                domNode: zoneDomNode
            });
            conflictViewZoneIds.push({ zoneId: zoneId, blockIndex: b.blockIndex });

            var widget = createConflictWidget(b.blockIndex, b.endLine, b.hunk);
            editor.addContentWidget(widget);
            conflictWidgets.push({ widget: widget, blockIndex: b.blockIndex, zoneId: zoneId });
        }
    });

    updateConflictWidgetWidths();

    // 実際の高さを測定してViewZoneを更新
    setTimeout(function () {
        if (!editor || conflictWidgets.length === 0) return;
        editor.changeViewZones(function (accessor) {
            for (var i = 0; i < conflictWidgets.length; i++) {
                var w = conflictWidgets[i];
                var actualHeight = w.widget._domNode.offsetHeight;
                if (actualHeight > 0) {
                    accessor.removeZone(w.zoneId);
                    var zoneDomNode = document.createElement('div');
                    zoneDomNode.className = 'conflict-viewzone-spacer';
                    zoneDomNode.style.width = '100%';
                    zoneDomNode.style.height = actualHeight + 'px';
                    var newZoneId = accessor.addZone({
                        afterLineNumber: w.widget._afterLine,
                        heightInPx: actualHeight,
                        domNode: zoneDomNode
                    });
                    for (var j = 0; j < conflictViewZoneIds.length; j++) {
                        if (conflictViewZoneIds[j].zoneId === w.zoneId) {
                            conflictViewZoneIds[j].zoneId = newZoneId;
                            break;
                        }
                    }
                    w.zoneId = newZoneId;
                }
            }
        });
    }, 50);
}

function createConflictWidget(blockIndex, afterLine, hunk) {
    var widgetId = 'conflict-widget-' + blockIndex;
    var domNode = document.createElement('div');
    domNode.className = 'conflict-panel-wrapper';
    domNode.style.overflow = 'visible';
    domNode.style.pointerEvents = 'auto';

    var innerNode = document.createElement('div');
    innerNode.className = 'conflict-panel';

    buildConflictPanelContent(innerNode, blockIndex, hunk);

    domNode.appendChild(innerNode);

    return {
        _id: widgetId,
        _afterLine: afterLine,
        _domNode: domNode,
        _innerNode: innerNode,

        getId: function () { return this._id; },
        getDomNode: function () { return this._domNode; },
        getPosition: function () {
            var pref = monaco.editor.ContentWidgetPositionPreference;
            return {
                position: { lineNumber: this._afterLine, column: 1 },
                preference: [pref.BELOW]
            };
        }
    };
}

// エディタのレイアウト変更時にWidgetの幅を更新（ミニマップ領域を除外）
function updateConflictWidgetWidths() {
    if (!editor || conflictWidgets.length === 0) return;

    var layoutInfo = editor.getLayoutInfo();

    // ContentWidget は getPosition() の column: 1 により、Monaco側で本文開始位置へ配置される。
    // そのため左位置は動かさず、幅だけを「本文開始位置〜ミニマップ手前」に制限する。
    var widgetLeft = layoutInfo.contentLeft;
    var width = layoutInfo.contentWidth;

    if (layoutInfo.minimap && layoutInfo.minimap.minimapWidth > 0 && layoutInfo.minimap.minimapLeft > widgetLeft) {
        width = Math.min(width, layoutInfo.minimap.minimapLeft - widgetLeft - 8);
    } else {
        width = Math.min(width, layoutInfo.width - widgetLeft - layoutInfo.verticalScrollbarWidth - 8);
    }

    width = Math.max(100, width);

    for (var i = 0; i < conflictWidgets.length; i++) {
        conflictWidgets[i].widget._domNode.style.width = width + 'px';
        conflictWidgets[i].widget._domNode.style.maxWidth = width + 'px';
        conflictWidgets[i].widget._domNode.style.marginLeft = '0';
    }
}

function buildConflictPanelContent(domNode, blockIdx, hunk) {
    var total = pendingFileChange.hunks.length;
    var header = document.createElement('div');
    header.className = 'conflict-panel-header';
    var oldRangeStr = hunk.oldLineCount > 0 ? ('行' + hunk.oldStart + '-' + hunk.oldEnd) : '（追加）';
    var newRangeStr = hunk.newLineCount > 0 ? ('行' + hunk.newStart + '-' + hunk.newEnd) : '（削除）';
    header.innerHTML = '<span>ブロック ' + (blockIdx + 1) + ' / ' + total +
        ' （自分: ' + oldRangeStr + ' ｜ 外部: ' + newRangeStr + '）</span>';

    var panels = document.createElement('div');
    panels.className = 'conflict-panel-panels';

    var leftSide = document.createElement('div');
    leftSide.className = 'conflict-panel-side conflict-panel-side-left';
    leftSide.innerHTML =
        '<div class="conflict-panel-side-title">📝 自分の編集</div>' +
        '<div class="conflict-panel-side-content">' + (hunk.oldText ? escapeHtml(hunk.oldText) : '（変更なし）') + '</div>';

    var rightSide = document.createElement('div');
    rightSide.className = 'conflict-panel-side conflict-panel-side-right';
    rightSide.innerHTML =
        '<div class="conflict-panel-side-title">📄 外部変更</div>' +
        '<div class="conflict-panel-side-content">' + (hunk.newText ? escapeHtml(hunk.newText) : '（変更なし）') + '</div>';

    panels.appendChild(leftSide);
    panels.appendChild(rightSide);

    var choice = document.createElement('div');
    choice.className = 'conflict-panel-choice';
    choice.innerHTML =
        '<button class="choice-btn choice-keep" data-block="' + blockIdx + '" data-choice="mine">✓ 自分を保持</button>' +
        '<button class="choice-btn choice-external" data-block="' + blockIdx + '" data-choice="external">↗ 外部を取り込む</button>';

    domNode.appendChild(header);
    domNode.appendChild(panels);
    domNode.appendChild(choice);

    var btns = choice.querySelectorAll('.choice-btn');
    for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var bIdx = parseInt(this.dataset.block);
            var ch = this.dataset.choice;
            resolveBlock(bIdx, ch);
        });
    }

    domNode.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    domNode.addEventListener('click', function (e) { e.stopPropagation(); });
}

function removeAllConflictWidgets() {
    if (!editor) return;
    // ViewZone削除
    if (conflictViewZoneIds.length > 0) {
        editor.changeViewZones(function (accessor) {
            for (var i = 0; i < conflictViewZoneIds.length; i++) {
                accessor.removeZone(conflictViewZoneIds[i].zoneId);
            }
        });
        conflictViewZoneIds = [];
    }
    // ContentWidget削除
    if (conflictWidgets.length > 0) {
        for (var j = 0; j < conflictWidgets.length; j++) {
            editor.removeContentWidget(conflictWidgets[j].widget);
        }
        conflictWidgets = [];
    }
}

/* ─── Conflict Resolution ────────────────────────── */

function showConflictToolbar() { conflictToolbar.classList.remove('hidden'); }
function hideConflictToolbar() { conflictToolbar.classList.add('hidden'); }

function updateToolbarInfo() {
    var unresolved = blockChoices.filter(function (c) { return c === null || c === undefined; }).length;
    var total = blockChoices.length;
    var resolved = total - unresolved;
    if (unresolved > 0) {
        conflictToolbarInfo.textContent = '⚠️ 衝突解決中: ' + resolved + '/' + total + ' ブロック解決済み';
    }
}

/**
 * 個別ブロック解決: ボタンクリックで即座にそのブロックを解決する
 */
function resolveBlock(blockIndex, choice) {
    if (!pendingFileChange || !editor) return;

    blockChoices[blockIndex] = choice;
    var model = editor.getModel();

    // 'external' の場合、エディタの該当範囲を外部テキストで置換
    if (choice === 'external') {
        for (var i = 0; i < highlightedRanges.length; i++) {
            if (highlightedRanges[i].blockIndex === blockIndex) {
                var range = model.getDecorationRange(changeDecorationIds[i]);
                if (range) {
                    var externalText = pendingFileChange.hunks[blockIndex].newText;
                    isApplyingFileChange = true;
                    editor.executeEdits('resolve-external', [{
                        range: new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber)),
                        text: externalText,
                        forceMoveMarkers: true
                    }]);
                    isApplyingFileChange = false;
                }
                break;
            }
        }
    }
    // 'mine' の場合はエディタ内容を変更しない

    // 解決後の表示を更新
    refreshConflictDisplay();
}

/**
 * 全ブロック一括解決
 */
function resolveAll(choice) {
    if (!pendingFileChange || !editor) return;

    for (var i = 0; i < blockChoices.length; i++) {
        blockChoices[i] = choice;
    }

    if (choice === 'external') {
        isApplyingFileChange = true;
        editor.executeEdits('resolve-all-external', [{
            range: editor.getModel().getFullModelRange(),
            text: pendingFileChange.newContent,
            forceMoveMarkers: true
        }]);
        isApplyingFileChange = false;

        highlightedRanges = pendingFileChange.newRanges.map(function (r, idx) {
            return { startLine: r.startLine, endLine: r.endLine, blockIndex: idx };
        });
    } else {
        highlightedRanges = [];
    }

    rebuildDecorations();
    updateChangeIndicator();
    removeAllConflictWidgets();

    lastKnownFileContent = pendingFileChange.newContent;
    isDirty = (choice === 'external');
    updateFileName();
    pendingFileChange = null;
    blockChoices = [];
    hideConflictToolbar();
    hidePendingCollisionIndicator();
    console.log('All blocks resolved as: ' + choice);
}

/**
 * 解決状態を反映してエディタ表示を更新
 */
function refreshConflictDisplay() {
    if (!pendingFileChange || !editor) return;
    var model = editor.getModel();

    var unresolvedBlocks = [];
    for (var i = 0; i < highlightedRanges.length; i++) {
        var bIdx = highlightedRanges[i].blockIndex;
        if (blockChoices[bIdx] === null || blockChoices[bIdx] === undefined) {
            var range = model.getDecorationRange(changeDecorationIds[i]);
            if (range) {
                unresolvedBlocks.push({
                    blockIndex: bIdx,
                    startLine: range.startLineNumber,
                    endLine: range.endLineNumber,
                    hunk: pendingFileChange.hunks[bIdx]
                });
            }
        }
    }

    highlightedRanges = unresolvedBlocks.map(function (b) {
        return { startLine: b.startLine, endLine: b.endLine, blockIndex: b.blockIndex };
    });
    rebuildDecorations();
    updateChangeIndicator();

    removeAllConflictWidgets();

    if (unresolvedBlocks.length === 0) {
        lastKnownFileContent = pendingFileChange.newContent;
        isDirty = true;
        updateFileName();
        pendingFileChange = null;
        blockChoices = [];
        hideConflictToolbar();
        hidePendingCollisionIndicator();
        console.log('All blocks resolved.');
    } else {
        addConflictPanelsForBlocks(unresolvedBlocks);
        updateToolbarInfo();
    }
}

/* ─── File Change Handler ────────────────────────── */

function handleFileChange(newContent) {
    if (!editor) return;
    if (newContent === lastKnownFileContent) return;
    if (newContent === editor.getValue()) { lastKnownFileContent = newContent; return; }

    var oldContent = editor.getValue();
    var cursorLine = editor.getPosition().lineNumber;

    var hunks = computeHunks(oldContent, newContent);
    if (hunks.length === 0) { lastKnownFileContent = newContent; return; }

    var oldRanges = [];
    for (var h = 0; h < hunks.length; h++) {
        if (hunks[h].oldLineCount > 0) {
            oldRanges.push({ startLine: hunks[h].oldStart, endLine: hunks[h].oldEnd, blockIndex: h });
        }
    }
    var newRanges = hunks.filter(function (h2) { return h2.newLineCount > 0; })
        .map(function (h2) { return { startLine: h2.newStart, endLine: h2.newEnd }; });

    var hasCollision = oldRanges.some(function (r) {
        return cursorLine >= r.startLine && cursorLine <= r.endLine;
    });
    if (pendingFileChange) {
        hasCollision = true;
    }

    clearChangeHighlights();

    if (hasCollision) {
        highlightedRanges = oldRanges;
        rebuildDecorations();
        updateChangeIndicator();

        pendingFileChange = {
            newContent: newContent, oldContent: oldContent,
            hunks: hunks, oldRanges: oldRanges, newRanges: newRanges
        };

        blockChoices = hunks.map(function () { return null; });

        var blocksForPanels = oldRanges.map(function (r) {
            return {
                blockIndex: r.blockIndex,
                startLine: r.startLine,
                endLine: r.endLine,
                hunk: hunks[r.blockIndex]
            };
        });
        addConflictPanelsForBlocks(blocksForPanels);

        showConflictToolbar();
        updateToolbarInfo();
        showPendingCollisionIndicator();

        lastKnownFileContent = newContent;
        console.log('Collision detected. ' + hunks.length + ' blocks. Inline widgets added on editor.');
    } else {
        isApplyingFileChange = true;
        var model = editor.getModel();
        editor.executeEdits('file-change', [{ range: model.getFullModelRange(), text: newContent, forceMoveMarkers: true }]);
        isApplyingFileChange = false;

        var lineCount = model.getLineCount();
        var targetLine = Math.min(cursorLine, lineCount);
        var targetColumn = Math.min(editor.getPosition().column, model.getLineMaxColumn(targetLine));
        editor.setPosition({ lineNumber: targetLine, column: targetColumn });

        highlightedRanges = newRanges;
        rebuildDecorations();
        updateChangeIndicator();

        lastKnownFileContent = newContent;
        isDirty = false;
        updateFileName();
    }
}

/* ─── Revalidate Conflicts ───────────────────────── */

/**
 * 現在のエディタ内容と外部変更内容を再比較し、衝突状態を再検証する。
 * ユーザーが編集した後にショートカットで実行することで、
 * 不要になった衝突ブロックを解決済みにしたり、ハイライトを更新したりする。
 */
async function revalidateConflicts() {
    if (!editor) return;

    // ファイルから最新内容を再読み込み
    var fileResult = await window.electronAPI.revalidateFile();
    if (!fileResult) {
        console.log('Revalidation: No file being watched.');
        return;
    }

    var currentContent = editor.getValue();
    var newContent = fileResult.content;

    // 差分がなければ何もしない（または既存の衝突解決中なら完了扱い）
    if (newContent === currentContent) {
        if (pendingFileChange) {
            clearChangeHighlights();
            lastKnownFileContent = newContent;
            isDirty = false;
            updateFileName();
            pendingFileChange = null;
            blockChoices = [];
            hideConflictToolbar();
            hidePendingCollisionIndicator();
        }
        console.log('Revalidation: No changes detected.');
        return;
    }

    // 再度diffを計算
    var hunks = computeHunks(currentContent, newContent);

    // 差分がなければ全て解決済み
    if (hunks.length === 0) {
        clearChangeHighlights();
        lastKnownFileContent = newContent;
        isDirty = true;
        updateFileName();
        pendingFileChange = null;
        blockChoices = [];
        hideConflictToolbar();
        hidePendingCollisionIndicator();
        console.log('Revalidation: No more conflicts. All resolved.');
        return;
    }

    // 差分がある場合、ハイライト範囲を再計算
    var oldRanges = [];
    for (var h = 0; h < hunks.length; h++) {
        if (hunks[h].oldLineCount > 0) {
            oldRanges.push({ startLine: hunks[h].oldStart, endLine: hunks[h].oldEnd, blockIndex: h });
        }
    }

    // 既存の選択状態を可能な限り引き継ぐ
    var newBlockChoices = hunks.map(function (h, idx) {
        // 古いblockIndexと新しいblockIndexの対応付けは難しいため、
        // 単純に未解決として再設定する（または内容が一致するものは引き継ぐ）
        return null;
    });

    // ハイライトとパネルを再構築
    removeAllConflictWidgets();
    highlightedRanges = oldRanges;
    rebuildDecorations();
    updateChangeIndicator();

    var newRanges = hunks.filter(function (h2) { return h2.newLineCount > 0; })
        .map(function (h2) { return { startLine: h2.newStart, endLine: h2.newEnd }; });

    // pendingFileChange が未初期化の場合は新規作成
    if (!pendingFileChange) {
        pendingFileChange = {};
    }
    pendingFileChange.oldContent = currentContent;
    pendingFileChange.newContent = newContent;
    pendingFileChange.hunks = hunks;
    pendingFileChange.oldRanges = oldRanges;
    pendingFileChange.newRanges = newRanges;

    blockChoices = newBlockChoices;

    var blocksForPanels = oldRanges.map(function (r) {
        return {
            blockIndex: r.blockIndex,
            startLine: r.startLine,
            endLine: r.endLine,
            hunk: hunks[r.blockIndex]
        };
    });
    addConflictPanelsForBlocks(blocksForPanels);
    updateToolbarInfo();

    console.log('Revalidation: ' + hunks.length + ' conflicts remaining.');
}

/* ─── Status Bar Helpers ─────────────────────────── */

function scrollToFirstHighlight() {
    if (highlightedRanges.length > 0 && editor) {
        var firstRange = highlightedRanges[0];
        editor.revealLineInCenter(firstRange.startLine);
        editor.setPosition({ lineNumber: firstRange.startLine, column: 1 });
        editor.focus();
    }
}

function showPendingCollisionIndicator() { statusPendingCollision.classList.remove('hidden'); }
function hidePendingCollisionIndicator() { statusPendingCollision.classList.add('hidden'); }

/* ─── Monaco Initialization ──────────────────────── */
require(['vs/editor/editor.main'], function () {

    var sampleCode = '';

    editor = monaco.editor.create(document.getElementById('container'), {
        value: sampleCode, language: 'plaintext', theme: 'vs-dark',
        automaticLayout: true, fontSize: 12, lineHeight: 18,
        minimap: { enabled: true, maxColumn: 80 }, scrollBeyondLastLine: false,
        roundedSelection: true, padding: { top: 12 }, smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on', tabSize: 4, wordWrap: 'off',
        wrappingStrategy: 'advanced',
        lineNumbers: 'on', glyphMargin: true, folding: true,
        renderWhitespace: 'selection', fontLigatures: true,
        formatOnPaste: true, formatOnType: true
    });

    // レイアウト変更時にConflict Widgetの幅を更新
    editor.onDidLayoutChange(function () {
        updateConflictWidgetWidths();
    });

    /* ─── 言語・テーマ・折り返し（メニューから操作） ─ */
    var statusLanguage = document.getElementById('status-language');
    var statusWrap = document.getElementById('status-wrap');
    var statusEncoding = document.getElementById('status-encoding');
    var isWrapped = false;

    var langLabels = {
        'plaintext': 'Plain Text', 'javascript': 'JavaScript', 'typescript': 'TypeScript',
        'html': 'HTML', 'css': 'CSS', 'json': 'JSON', 'python': 'Python', 'markdown': 'Markdown'
    };

    function setLanguage(lang) {
        currentLanguage = lang;
        monaco.editor.setModelLanguage(editor.getModel(), lang);
        statusLanguage.textContent = langLabels[lang] || lang;
    }

    /* ─── 文字コード（エンコーディング） ──────────── */
    var encodingLabels = {
        'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE',
        'shift_jis': 'Shift_JIS', 'euc-jp': 'EUC-JP'
    };
    var encodingCycle = ['utf-8', 'shift_jis', 'euc-jp', 'utf-16le', 'utf-16be'];

    function updateEncodingStatus() {
        if (!statusEncoding) return;
        statusEncoding.textContent = encodingLabels[currentEncoding] || currentEncoding;
        statusEncoding.title = '文字コード: ' + (encodingLabels[currentEncoding] || currentEncoding) + '（クリックで切り替え）';
    }

    async function setEncoding(enc) {
        currentEncoding = enc;
        updateEncodingStatus();
        // 開いているファイルがある場合は、新しい文字コードで再デコードして読み直す。
        // 未保存の変更がある場合は内容を保持し、保存時の文字コードのみ変更する。
        if (currentFilePath) {
            try {
                var result = await window.electronAPI.reopenWithEncoding(enc);
                if (result && !isDirty) {
                    isApplyingFileChange = true;
                    editor.setValue(result.content);
                    isApplyingFileChange = false;
                    lastKnownFileContent = result.content;
                    isDirty = false;
                    clearChangeHighlights();
                    hidePendingCollisionIndicator();
                    hideConflictToolbar();
                    pendingFileChange = null;
                    blockChoices = [];
                    updateFileName();
                    updateStatusBar();
                }
            } catch (err) { console.error('Reopen with encoding error:', err); }
        }
    }

    function updateWrapStatus() {
        statusWrap.textContent = '折り返し: ' + (isWrapped ? 'ON' : 'OFF');
        statusWrap.title = 'クリックで折り返しON/OFF（現在: ' + (isWrapped ? 'ON' : 'OFF') + '）';
    }

    function updateFontStatus() {
        statusFont.textContent = currentFontFamily + ' ' + currentFontSize + 'px';
        statusFont.title = 'エディターフォント: ' + currentFontFamily + ' ' + currentFontSize + 'px / UI: ' + currentUiFontFamily + ' ' + currentUiFontSize + 'px';
    }

    function setFontFamily(family) {
        currentFontFamily = family;
        editor.updateOptions({ fontFamily: family });
        updateFontStatus();
    }

    function applyUiFont() {
        document.documentElement.style.setProperty('--ui-font-family', "'" + currentUiFontFamily + "'");
        document.documentElement.style.setProperty('--ui-font-size', currentUiFontSize + 'px');
    }

    function changeFontSize(delta) {
        currentFontSize = Math.max(8, Math.min(48, currentFontSize + delta));
        editor.updateOptions({ fontSize: currentFontSize, lineHeight: Math.round(currentFontSize * 1.5) });
        updateFontStatus();
        saveFontConfigAll();
    }

    function resetFontSize() {
        currentFontSize = 12;
        editor.updateOptions({ fontSize: currentFontSize, lineHeight: Math.round(currentFontSize * 1.5) });
        updateFontStatus();
        saveFontConfigAll();
    }

    function saveFontConfigAll() {
        window.electronAPI.saveFontConfig({
            editor: { family: currentFontFamily, size: currentFontSize },
            ui: { family: currentUiFontFamily, size: currentUiFontSize }
        });
    }

    function openFontSettings() {
        window.electronAPI.openFontSettings({
            editor: { family: currentFontFamily, size: currentFontSize },
            ui: { family: currentUiFontFamily, size: currentUiFontSize }
        });
    }

    /* ─── ステータスバー ────────────────────────── */
    var statusCursor = document.getElementById('status-cursor');
    var statusInfo = document.getElementById('status-info');

    function updateStatusBar() {
        var pos = editor.getPosition();
        statusCursor.textContent = '行 ' + pos.lineNumber + ', 列 ' + pos.column;
        var model = editor.getModel();
        statusInfo.textContent = '行数: ' + model.getLineCount() + ' | 文字数: ' + model.getValueLength();
        checkStatusbarOverflow();
    }

    var statusbarContent = document.getElementById('statusbar-content');
    var isScrollEnabled = true;

    function checkStatusbarOverflow() {
        if (!statusbarContent) return;
        var overflow = statusbarContent.scrollWidth - document.getElementById('statusbar').clientWidth;
        if (overflow > 2) {
            statusbarContent.style.setProperty('--marquee-offset', -overflow + 'px');
            statusbarContent.classList.add('scroll-overflow');
        } else {
            statusbarContent.classList.remove('scroll-overflow');
            statusbarContent.style.removeProperty('--marquee-offset');
        }
        updateScrollAnimationState();
    }

    function updateScrollAnimationState() {
        if (isScrollEnabled && statusbarContent.classList.contains('scroll-overflow')) {
            statusbarContent.classList.add('scroll-active');
        } else {
            statusbarContent.classList.remove('scroll-active');
        }
    }

    function toggleStatusbarScroll() {
        isScrollEnabled = !isScrollEnabled;
        updateScrollAnimationState();
    }

    function markDirty() { if (!isDirty) { isDirty = true; updateFileName(); } }

    /* ─── 内容変更イベント ──────────────────────── */
    editor.onDidChangeCursorPosition(updateStatusBar);

    editor.onDidChangeModelContent(function (e) {
        updateStatusBar();
        if (isApplyingFileChange) return;
        markDirty();

        if (highlightedRanges.length > 0 && e.changes.length > 0 && pendingFileChange) {
            var resolvedByEdit = [];
            for (var i = 0; i < highlightedRanges.length; i++) {
                var overlaps = false;
                for (var c = 0; c < e.changes.length; c++) {
                    var ch = e.changes[c];
                    if (!(highlightedRanges[i].endLine < ch.range.startLineNumber ||
                          highlightedRanges[i].startLine > ch.range.endLineNumber)) {
                        overlaps = true;
                        break;
                    }
                }
                if (overlaps) {
                    resolvedByEdit.push(highlightedRanges[i].blockIndex);
                }
            }

            if (resolvedByEdit.length > 0) {
                for (var r = 0; r < resolvedByEdit.length; r++) {
                    blockChoices[resolvedByEdit[r]] = 'mine';
                }
                refreshConflictDisplay();
            }
        }
    });

    updateStatusBar();
    updateFontStatus();
    updateEncodingStatus();

    /* ─── 設定ファイルからフォント読み込み ────────── */
    window.electronAPI.loadFontConfig().then(function (config) {
        if (config) {
            if (config.editor) {
                currentFontFamily = config.editor.family;
                currentFontSize = config.editor.size;
                editor.updateOptions({ fontFamily: currentFontFamily, fontSize: currentFontSize, lineHeight: Math.round(currentFontSize * 1.5) });
            }
            if (config.ui) {
                currentUiFontFamily = config.ui.family;
                currentUiFontSize = config.ui.size;
                applyUiFont();
            }
            updateFontStatus();
        }
    });

    /* ─── ファイル操作 ──────────────────────────── */
    async function openFile() {
        try {
            var result = await window.electronAPI.openFile(null);
            if (!result) return;

            // エディタにテキストがある場合は新しいウィンドウで開く
            var currentContent = editor.getValue();
            if (currentContent && currentContent.trim().length > 0) {
                window.electronAPI.openFileInNewWindow(result.path);
                return;
            }

            loadFileContent(result.path, result.content, result.encoding);
        } catch (err) { console.error('Open file error:', err); }
    }

    function loadFileContent(filePath, content, encoding) {
        currentFilePath = filePath;
        currentEncoding = encoding || 'utf-8';
        updateEncodingStatus();
        isDirty = false;
        lastKnownFileContent = content;
        pendingFileChange = null;
        blockChoices = [];
        isApplyingFileChange = true;
        editor.setValue(content);
        isApplyingFileChange = false;
        clearChangeHighlights();
        hidePendingCollisionIndicator();
        hideConflictToolbar();

        var ext = filePath.split('.').pop().toLowerCase();
        var langMap = { js:'javascript', ts:'typescript', html:'html', css:'css', json:'json', py:'python', md:'markdown', txt:'plaintext' };
        var lang = langMap[ext] || 'plaintext';
        currentLanguage = lang;
        monaco.editor.setModelLanguage(editor.getModel(), lang);
        statusLanguage.textContent = langLabels[lang] || lang;
        updateFileName();
        updateStatusBar();
        window.electronAPI.startWatch(filePath);
    }

    async function saveFile(saveAs) {
        try {
            var content = editor.getValue();
            var filePath = saveAs ? null : currentFilePath;
            var savedPath = await window.electronAPI.saveFile({ filePath: filePath, content: content, language: currentLanguage, encoding: currentEncoding });
            if (savedPath) {
                currentFilePath = savedPath;
                isDirty = false;
                lastKnownFileContent = content;
                pendingFileChange = null;
                blockChoices = [];
                hidePendingCollisionIndicator();
                hideConflictToolbar();
                updateFileName();
                window.electronAPI.startWatch(savedPath);
                return true;
            }
            return false;
        } catch (err) { console.error('Save file error:', err); return false; }
    }

    /* ─── メニューアクション ────────────────────── */
    window.electronAPI.onMenuAction(function (action) {
        switch (action) {
            case 'open': openFile(); break;
            case 'save': saveFile(false); break;
            case 'save-as': saveFile(true); break;
            case 'revalidate': revalidateConflicts(); break;
            case 'minimap-on': editor.updateOptions({ minimap: { enabled: true } }); setTimeout(function() { editor.layout(); }, 50); break;
            case 'minimap-off': editor.updateOptions({ minimap: { enabled: false } }); setTimeout(function() { editor.layout(); }, 50); break;
            case 'set-language-plaintext': setLanguage('plaintext'); break;
            case 'set-language-javascript': setLanguage('javascript'); break;
            case 'set-language-typescript': setLanguage('typescript'); break;
            case 'set-language-html': setLanguage('html'); break;
            case 'set-language-css': setLanguage('css'); break;
            case 'set-language-json': setLanguage('json'); break;
            case 'set-language-python': setLanguage('python'); break;
            case 'set-language-markdown': setLanguage('markdown'); break;
            case 'set-theme-vs': monaco.editor.setTheme('vs'); break;
            case 'set-theme-vs-dark': monaco.editor.setTheme('vs-dark'); break;
            case 'set-theme-hc-black': monaco.editor.setTheme('hc-black'); break;
            case 'open-font-settings': openFontSettings(); break;
            case 'font-size-up': changeFontSize(1); break;
            case 'font-size-down': changeFontSize(-1); break;
            case 'font-size-reset': resetFontSize(); break;
            case 'wrap-on': isWrapped = true; editor.updateOptions({ wordWrap: 'on' }); setTimeout(function() { editor.layout(); }, 50); updateWrapStatus(); break;
            case 'wrap-off': isWrapped = false; editor.updateOptions({ wordWrap: 'off' }); setTimeout(function() { editor.layout(); }, 50); updateWrapStatus(); break;
            case 'set-encoding-utf-8': setEncoding('utf-8'); break;
            case 'set-encoding-utf-16le': setEncoding('utf-16le'); break;
            case 'set-encoding-utf-16be': setEncoding('utf-16be'); break;
            case 'set-encoding-shift_jis': setEncoding('shift_jis'); break;
            case 'set-encoding-euc-jp': setEncoding('euc-jp'); break;
        }
    });

    /* ─── ファイル変更イベント ────────────────────── */
    window.electronAPI.onFileChanged(function (data) {
        if (data.deleted) {
            clearChangeHighlights();
        } else {
            handleFileChange(data.content);
        }
    });

    /* ─── 新しいウィンドウで起動した場合のファイル読み込み ── */
    window.electronAPI.onOpenFileOnStartup(function (filePath) {
        window.electronAPI.openFile(filePath).then(function (result) {
            if (result) {
                loadFileContent(result.path, result.content, result.encoding);
            }
        });
    });

    /* ─── ウィンドウクローズ時の未保存確認 ────────── */
    window.electronAPI.onCloseRequested(async function () {
        if (!isDirty) {
            window.electronAPI.closeWindow();
            return;
        }
        var choice = await window.electronAPI.confirmClose();
        if (choice === 'save') {
            var saved = await saveFile(false);
            if (saved) {
                window.electronAPI.closeWindow();
            }
            // 保存がキャンセルされた場合はウィンドウを閉じない
        } else if (choice === 'discard') {
            window.electronAPI.closeWindow();
        }
        // 'cancel' の場合は何もしない（ウィンドウは閉じない）
    });

    /* ─── フォント設定適用 ──────────────────────── */
    window.electronAPI.onFontSettingsApplied(function (settings) {
        if (settings.editor) {
            currentFontFamily = settings.editor.family;
            currentFontSize = settings.editor.size;
            editor.updateOptions({ fontFamily: currentFontFamily, fontSize: currentFontSize, lineHeight: Math.round(currentFontSize * 1.5) });
        }
        if (settings.ui) {
            currentUiFontFamily = settings.ui.family;
            currentUiFontSize = settings.ui.size;
            applyUiFont();
        }
        updateFontStatus();
    });

    /* ─── ステータスバー ────────────────────────── */
    statusChangeIndicator.addEventListener('click', function (e) { e.stopPropagation(); scrollToFirstHighlight(); });
    statusPendingCollision.addEventListener('click', function (e) { e.stopPropagation(); scrollToFirstHighlight(); });

    var statusFontEl = document.getElementById('status-font');
    statusFontEl.addEventListener('click', function (e) {
        e.stopPropagation();
        openFontSettings();
    });

    var statusLanguageEl = document.getElementById('status-language');
    statusLanguageEl.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleStatusbarScroll();
    });

    var statusWrapEl = document.getElementById('status-wrap');
    statusWrapEl.addEventListener('click', function (e) {
        e.stopPropagation();
        isWrapped = !isWrapped;
        editor.updateOptions({ wordWrap: isWrapped ? 'on' : 'off' });
        setTimeout(function() { editor.layout(); }, 50);
        updateWrapStatus();
    });

    var statusEncodingEl = document.getElementById('status-encoding');
    if (statusEncodingEl) {
        statusEncodingEl.addEventListener('click', function (e) {
            e.stopPropagation();
            var idx = encodingCycle.indexOf(currentEncoding);
            var next = encodingCycle[(idx + 1) % encodingCycle.length];
            setEncoding(next);
        });
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(function () {
            var original = statusCursor.style.opacity;
            statusCursor.style.opacity = '0.5';
            statusInfo.style.opacity = '0.5';
            setTimeout(function () {
                statusCursor.style.opacity = original;
                statusInfo.style.opacity = '0.9';
            }, 200);
        });
    }

    statusCursor.addEventListener('click', function (e) {
        e.stopPropagation();
        copyToClipboard(statusCursor.textContent + ' | ' + statusInfo.textContent);
    });

    statusInfo.addEventListener('click', function (e) {
        e.stopPropagation();
        copyToClipboard(statusCursor.textContent + ' | ' + statusInfo.textContent);
    });

    window.addEventListener('resize', checkStatusbarOverflow);

    /* ─── 衝突解決ツールバー ボタン ──────────────── */
    conflictAcceptAllBtn.addEventListener('click', function () { resolveAll('external'); });
    conflictKeepAllBtn.addEventListener('click', function () { resolveAll('mine'); });

    /* ─── キーボードショートカット ──────────────── */
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () { saveFile(false); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, function () { saveFile(true); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, function () { openFile(); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, function () {
        editor.getAction('editor.action.formatDocument').run();
    });
    // 衝突の再検証はメニューの「編集 > 衝突を再検証」(Ctrl+Shift+R) から実行

    /* ─── Ctrl+マウスホイールでフォントサイズ変更 ──── */
    editor.getDomNode().addEventListener('wheel', function (e) {
        if (e.ctrlKey) {
            e.preventDefault();
            e.stopPropagation();
            if (e.deltaY > 0) {
                changeFontSize(1);
            } else if (e.deltaY < 0) {
                changeFontSize(-1);
            }
        }
    }, { passive: false });

    console.log('MergeEditor initialized with ContentWidget conflict panels.');
});
