const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('velarioDesktop', { platform: process.platform, version: '1.1.0' });
contextBridge.exposeInMainWorld('velarioNative', {
  platform: 'windows',
  getStatus: () => ipcRenderer.invoke('billing:status'),
  restore: () => ipcRenderer.invoke('billing:status'),
  purchase: method => ipcRenderer.invoke('billing:purchase', method),
  manage: () => ipcRenderer.invoke('billing:manage')
});
