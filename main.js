const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── ウィンドウごとの状態管理 ─────────────────────
// winId -> { fileWatcher, watchDebounceTimer, currentWatchedFile }
const windowStates = new Map();

function getWindowState(winId) {
    if (!windowStates.has(winId)) {
        windowStates.set(winId, { fileWatcher: null, watchDebounceTimer: null, currentWatchedFile: null });
    }
    return windowStates.get(winId);
}

// ─── ファイル監視（ウィンドウごと） ───────────────
function startFileWatch(winId, filePath) {
    stopFileWatch(winId);
    const state = getWindowState(winId);
    if (!filePath || !fs.existsSync(filePath)) return;
    state.currentWatchedFile = filePath;

    const win = BrowserWindow.fromId(winId);
    try {
        state.fileWatcher = fs.watch(filePath, { persistent: false }, (eventType) => {
            if (state.watchDebounceTimer) clearTimeout(state.watchDebounceTimer);
            state.watchDebounceTimer = setTimeout(() => {
                try {
                    if (!fs.existsSync(filePath)) {
                        if (win && !win.isDestroyed()) {
                            win.webContents.send('file-changed', {
                                path: filePath,
                                content: null,
                                deleted: true
                            });
                        }
                        stopFileWatch(winId);
                        return;
                    }
                    const content = fs.readFileSync(filePath, 'utf-8');
                    if (win && !win.isDestroyed()) {
                        win.webContents.send('file-changed', {
                            path: filePath,
                            content
                        });
                    }
                } catch (err) {
                    console.error('File watch read error:', err);
                }
            }, 300);
        });

        state.fileWatcher.on('error', (err) => {
            console.error('File watcher error:', err);
        });
    } catch (err) {
        console.error('Failed to start file watch:', err);
    }
}

function stopFileWatch(winId) {
    const state = getWindowState(winId);
    if (state.fileWatcher) {
        state.fileWatcher.close();
        state.fileWatcher = null;
    }
    if (state.watchDebounceTimer) {
        clearTimeout(state.watchDebounceTimer);
        state.watchDebounceTimer = null;
    }
    state.currentWatchedFile = null;
}

// ─── ウィンドウ作成 ───────────────────────────────
function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 600,
        minHeight: 400,
        title: 'MergeEditor',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    const winId = win.id;
    getWindowState(winId); // 状態を初期化

    win.loadFile(path.join(__dirname, 'src', 'index.html'));

    win.on('closed', () => {
        stopFileWatch(winId);
        windowStates.delete(winId);
    });

    return win;
}

// ─── メニューアクションヘルパ ─────────────────────
function sendAction(action) {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.send('menu-action', action);
}

// ─── メニュー構築 ─────────────────────────────────
function buildMenu() {
    const menuTemplate = [
        {
            label: 'ファイル(F)(&F)', accelerator: 'Alt+F',
            submenu: [
                { label: '新規', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
                { label: '開く...', accelerator: 'CmdOrCtrl+O', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.send('menu-action', 'open');
                }},
                { label: '上書き保存', accelerator: 'CmdOrCtrl+S', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.send('menu-action', 'save');
                }},
                { label: '名前を付けて保存...', accelerator: 'CmdOrCtrl+Shift+S', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.send('menu-action', 'save-as');
                }},
                { type: 'separator' },
                { label: '閉じる', accelerator: 'Alt+F4', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.close();
                }}
            ]
        },
        {
            label: '編集(E)(&E)', accelerator: 'Alt+E',
            submenu: [
                { label: '元に戻す', accelerator: 'CmdOrCtrl+Z', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.undo();
                }},
                { label: 'やり直し', accelerator: 'CmdOrCtrl+Y', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.redo();
                }},
                { type: 'separator' },
                { label: '切り取り', accelerator: 'CmdOrCtrl+X', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.cut();
                }},
                { label: 'コピー', accelerator: 'CmdOrCtrl+C', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.copy();
                }},
                { label: '貼り付け', accelerator: 'CmdOrCtrl+V', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.paste();
                }},
                { label: 'すべて選択', accelerator: 'CmdOrCtrl+A', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.selectAll();
                }},
                { type: 'separator' },
                { label: '衝突を再検証', accelerator: 'CmdOrCtrl+Shift+R', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.send('menu-action', 'revalidate');
                }}
            ]
        },
        {
            label: '表示(V)(&V)', accelerator: 'Alt+V',
            submenu: [
                {
                    label: '書式',
                    submenu: [
                        { label: 'Plain Text', type: 'radio', checked: true, click: () => sendAction('set-language-plaintext') },
                        { label: 'JavaScript', type: 'radio', click: () => sendAction('set-language-javascript') },
                        { label: 'TypeScript', type: 'radio', click: () => sendAction('set-language-typescript') },
                        { label: 'HTML', type: 'radio', click: () => sendAction('set-language-html') },
                        { label: 'CSS', type: 'radio', click: () => sendAction('set-language-css') },
                        { label: 'JSON', type: 'radio', click: () => sendAction('set-language-json') },
                        { label: 'Python', type: 'radio', click: () => sendAction('set-language-python') },
                        { label: 'Markdown', type: 'radio', click: () => sendAction('set-language-markdown') }
                    ]
                },
                {
                    label: 'テーマ',
                    submenu: [
                        { label: 'Light', type: 'radio', click: () => sendAction('set-theme-vs') },
                        { label: 'Dark', type: 'radio', checked: true, click: () => sendAction('set-theme-vs-dark') },
                        { label: 'High Contrast', type: 'radio', click: () => sendAction('set-theme-hc-black') }
                    ]
                },
                { label: '折り返し', type: 'checkbox', checked: false, accelerator: 'CmdOrCtrl+Shift+W', click: (menuItem) => sendAction(menuItem.checked ? 'wrap-on' : 'wrap-off') },
                { type: 'separator' },
                { label: 'ズームイン', accelerator: 'CmdOrCtrl+=', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.zoomFactor *= 1.2;
                }},
                { label: 'ズームアウト', accelerator: 'CmdOrCtrl+-', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.zoomFactor /= 1.2;
                }},
                { label: 'ズームリセット', accelerator: 'CmdOrCtrl+0', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.zoomFactor = 1.0;
                }},
                { type: 'separator' },
                { label: 'ミニマップ', type: 'checkbox', checked: true, accelerator: 'CmdOrCtrl+Shift+M', click: (menuItem) => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.webContents.send('menu-action', menuItem.checked ? 'minimap-on' : 'minimap-off');
                }},
                { type: 'separator' },
                { label: '全画面表示', accelerator: 'F11', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) win.setFullScreen(!win.isFullScreen());
                }},
            ]
        },
        {
            label: 'ヘルプ(H)(&H)', accelerator: 'Alt+H',
            submenu: [
                { label: 'バージョン情報', accelerator: 'F1', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) {
                        const aboutWin = new BrowserWindow({
                            width: 400,
                            height: 250,
                            parent: win,
                            modal: true,
                            title: 'バージョン情報',
                            resizable: false,
                            minimizable: false,
                            maximizable: false,
                            webPreferences: {
                                contextIsolation: true,
                                nodeIntegration: false
                            }
                        });
                        aboutWin.setMenuBarVisibility(false);
                        aboutWin.loadFile(path.join(__dirname, 'src', 'about.html'));
                    }
                }},
                { label: 'ライブラリライセンス', click: () => {
                    const win = BrowserWindow.getFocusedWindow();
                    if (win) {
                        const licenseWin = new BrowserWindow({
                            width: 700,
                            height: 600,
                            parent: win,
                            modal: true,
                            title: 'ライブラリライセンス',
                            webPreferences: {
                                contextIsolation: true,
                                nodeIntegration: false
                            }
                        });
                        licenseWin.setMenuBarVisibility(false);
                        licenseWin.loadFile(path.join(__dirname, 'src', 'licenses.html'));
                    }
                }}
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

app.whenReady().then(() => {
    buildMenu();
    createWindow();
});

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
    for (const winId of windowStates.keys()) {
        stopFileWatch(winId);
    }
});

// ─── タイトル設定 ─────────────────────────────────
ipcMain.on('set-title', (event, title) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setTitle(title);
});

// ─── IPC ハンドラー（ウィンドウごとに処理） ───────

ipcMain.handle('open-file', async (event, filePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!filePath) {
        const result = await dialog.showOpenDialog(win, {
            title: 'ファイルを開く',
            properties: ['openFile']
        });
        if (result.canceled) return null;
        filePath = result.filePaths[0];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { path: filePath, content };
});

ipcMain.handle('save-file', async (event, { filePath, content }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!filePath) {
        const result = await dialog.showSaveDialog(win, {
            title: '名前を付けて保存', defaultPath: 'untitled.txt',
            filters: [
                { name: 'すべてのファイル', extensions: ['*'] },
                { name: 'JavaScript', extensions: ['js'] },
                { name: 'TypeScript', extensions: ['ts'] },
                { name: 'HTML', extensions: ['html'] },
                { name: 'CSS', extensions: ['css'] },
                { name: 'JSON', extensions: ['json'] },
                { name: 'Python', extensions: ['py'] },
                { name: 'Markdown', extensions: ['md'] },
                { name: 'テキスト', extensions: ['txt'] }
            ]
        });
        if (result.canceled) return null;
        filePath = result.filePath;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
});

ipcMain.handle('start-watch', async (event, filePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    startFileWatch(win.id, filePath);
});

ipcMain.handle('stop-watch', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    stopFileWatch(win.id);
});

ipcMain.handle('revalidate-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const state = getWindowState(win.id);
    if (!state.currentWatchedFile) return null;
    try {
        if (!fs.existsSync(state.currentWatchedFile)) return null;
        const content = fs.readFileSync(state.currentWatchedFile, 'utf-8');
        return { path: state.currentWatchedFile, content };
    } catch (err) {
        console.error('Revalidate file read error:', err);
        return null;
    }
});
