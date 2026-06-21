const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ズームを常に1.0（100%）に固定
webFrame.setZoomFactor(1.0);

contextBridge.exposeInMainWorld('electronAPI', {
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    saveFile: (data) => ipcRenderer.invoke('save-file', data),
    startWatch: (filePath) => ipcRenderer.invoke('start-watch', filePath),
    stopWatch: () => ipcRenderer.invoke('stop-watch'),
    revalidateFile: () => ipcRenderer.invoke('revalidate-file'),
    setTitle: (title) => ipcRenderer.send('set-title', title),
    onMenuAction: (callback) => ipcRenderer.on('menu-action', (event, action) => callback(action)),
    onFileChanged: (callback) => ipcRenderer.on('file-changed', (event, data) => callback(data)),
    openFontSettings: (currentSettings) => ipcRenderer.send('open-font-settings', currentSettings),
    onFontSettingsApplied: (callback) => ipcRenderer.on('font-settings-applied', (event, settings) => callback(settings)),
    loadFontConfig: () => ipcRenderer.invoke('load-font-config'),
    onFontSettingsInit: (callback) => ipcRenderer.on('font-settings-init', (event, data) => callback(data)),
    applyFontSettings: (settings) => ipcRenderer.send('font-settings-apply', settings),
    saveFontConfig: (settings) => ipcRenderer.send('save-font-config', settings),
    onApplyDialogFont: (callback) => ipcRenderer.on('apply-dialog-font', (event, data) => callback(data))
});
