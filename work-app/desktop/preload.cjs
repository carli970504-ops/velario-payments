const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('velarioDesktop', { platform: process.platform, version: '1.1.0' });
contextBridge.exposeInMainWorld('velarioMarket', {
  quotes: symbols => ipcRenderer.invoke('market:quotes', symbols),
  chart: (symbol, range, interval) => ipcRenderer.invoke('market:chart', symbol, range, interval)
});
contextBridge.exposeInMainWorld('velarioNative', {
  platform: 'windows',
  getStatus: () => ipcRenderer.invoke('billing:status'),
  restore: () => ipcRenderer.invoke('billing:status'),
  purchase: method => ipcRenderer.invoke('billing:purchase', method),
  manage: () => ipcRenderer.invoke('billing:manage'),
  topup: mode => ipcRenderer.invoke('billing:credit-checkout', mode),
  claimTopup: session => ipcRenderer.invoke('billing:credit-claim', session),
  claimReward: (mode, amount) => ipcRenderer.invoke('billing:reward', mode, amount)
});
