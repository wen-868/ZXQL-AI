const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

let win = null;

function createWindow() {
  // file:// 页面请求 AI 底座时移除 Origin 头，避免 CORS 白名单拦截（桌面端标准做法）
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.requestHeaders.Origin && /^file:/i.test(details.requestHeaders.Origin)) {
      delete details.requestHeaders.Origin;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    frame: false,              // 无边框：去掉 Windows 原生标题栏/边框（Codex 同款）
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

ipcMain.on('win-control', (_e, action) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
