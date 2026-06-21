const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    saveFile: (data) => ipcRenderer.invoke('save-file', data),
    startWatch: (filePath) => ipcRenderer.invoke('start-watch', filePath),
    stopWatch: () => ipcRenderer.invoke('stop-watch'),
    revalidateFile: () => ipcRenderer.invoke('revalidate-file'),
    setTitle: (title) => ipcRenderer.send('set-title', title),
    onMenuAction: (callback) => ipcRenderer.on('menu-action', (event, action) => callback(action)),
    onFileChanged: (callback) => ipcRenderer.on('file-changed', (event, data) => callback(data))
});
