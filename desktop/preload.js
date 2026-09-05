const { contextBridge, ipcRenderer } = require('electron');

// 窗口控制桥：页面右上角 — □ ✕ 三个自绘按钮走这里
contextBridge.exposeInMainWorld('zxqlWindow', {
  minimize: () => ipcRenderer.send('win-control', 'minimize'),
  maximize: () => ipcRenderer.send('win-control', 'maximize'),
  close:    () => ipcRenderer.send('win-control', 'close')
});
