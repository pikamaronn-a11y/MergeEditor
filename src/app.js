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

    editor.changeViewZones(function (accessor) {
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            var panelHeight = 220;

            // ViewZone（空白領域）を作成
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

            // ContentWidget（インタラクティブUI）を作成して同じ位置に配置
            var widget = createConflictWidget(b.blockIndex, b.endLine, panelHeight, b.hunk);
            editor.addContentWidget(widget);
            conflictWidgets.push({ widget: widget, blockIndex: b.blockIndex });
        }
    });

    // Widget追加後に幅をエディタ全体に広げる
    updateConflictWidgetWidths();
}

function createConflictWidget(blockIndex, afterLine, panelHeight, hunk) {
    var widgetId = 'conflict-widget-' + blockIndex;
    var domNode = document.createElement('div');
    domNode.className = 'conflict-panel-wrapper';
    domNode.style.overflow = 'visible';
    domNode.style.pointerEvents = 'auto';

    var innerNode = document.createElement('div');
    innerNode.className = 'conflict-panel';
    innerNode.style.height = panelHeight + 'px';
    innerNode.style.overflow = 'hidden';

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

// エディタのレイアウト変更時にWidgetの幅を更新
function updateConflictWidgetWidths() {
    if (!editor || conflictWidgets.length === 0) return;
    var width = editor.getLayoutInfo().contentWidth;
    for (var i = 0; i < conflictWidgets.length; i++) {
        conflictWidgets[i].widget._domNode.style.width = width + 'px';
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
        automaticLayout: true, fontSize: 14, lineHeight: 21,
        minimap: { enabled: true, maxColumn: 80 }, scrollBeyondLastLine: false,
        roundedSelection: true, padding: { top: 12 }, smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on', tabSize: 4, wordWrap: 'off',
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

    function updateWrapStatus() {
        statusWrap.textContent = '折り返し: ' + (isWrapped ? 'ON' : 'OFF');
        statusWrap.title = '右端で折り返し: ' + (isWrapped ? 'ON' : 'OFF');
    }

    /* ─── ステータスバー ────────────────────────── */
    var statusCursor = document.getElementById('status-cursor');
    var statusInfo = document.getElementById('status-info');

    function updateStatusBar() {
        var pos = editor.getPosition();
        statusCursor.textContent = '行 ' + pos.lineNumber + ', 列 ' + pos.column;
        var model = editor.getModel();
        statusInfo.textContent = '行数: ' + model.getLineCount() + ' | 文字数: ' + model.getValueLength();
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

    /* ─── ファイル操作 ──────────────────────────── */
    async function openFile() {
        try {
            var result = await window.electronAPI.openFile(null);
            if (!result) return;
            currentFilePath = result.path;
            isDirty = false;
            lastKnownFileContent = result.content;
            pendingFileChange = null;
            blockChoices = [];
            isApplyingFileChange = true;
            editor.setValue(result.content);
            isApplyingFileChange = false;
            clearChangeHighlights();
            hidePendingCollisionIndicator();
            hideConflictToolbar();

            var ext = result.path.split('.').pop().toLowerCase();
            var langMap = { js:'javascript', ts:'typescript', html:'html', css:'css', json:'json', py:'python', md:'markdown', txt:'plaintext' };
            var lang = langMap[ext] || 'plaintext';
            currentLanguage = lang;
            monaco.editor.setModelLanguage(editor.getModel(), lang);
            statusLanguage.textContent = langLabels[lang] || lang;
            updateFileName();
            updateStatusBar();
            window.electronAPI.startWatch(result.path);
        } catch (err) { console.error('Open file error:', err); }
    }

    async function saveFile(saveAs) {
        try {
            var content = editor.getValue();
            var filePath = saveAs ? null : currentFilePath;
            var savedPath = await window.electronAPI.saveFile({ filePath: filePath, content: content });
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
            }
        } catch (err) { console.error('Save file error:', err); }
    }

    /* ─── メニューアクション ────────────────────── */
    window.electronAPI.onMenuAction(function (action) {
        switch (action) {
            case 'open': openFile(); break;
            case 'save': saveFile(false); break;
            case 'save-as': saveFile(true); break;
            case 'revalidate': revalidateConflicts(); break;
            case 'minimap-on': editor.updateOptions({ minimap: { enabled: true } }); break;
            case 'minimap-off': editor.updateOptions({ minimap: { enabled: false } }); break;
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
            case 'wrap-on': isWrapped = true; editor.updateOptions({ wordWrap: 'on' }); updateWrapStatus(); break;
            case 'wrap-off': isWrapped = false; editor.updateOptions({ wordWrap: 'off' }); updateWrapStatus(); break;
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

    /* ─── ステータスバー ────────────────────────── */
    statusChangeIndicator.addEventListener('click', function () { scrollToFirstHighlight(); });
    statusPendingCollision.addEventListener('click', function () { scrollToFirstHighlight(); });

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

    console.log('MergeEditor initialized with ContentWidget conflict panels.');
});
