const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { createBilling } = require('./billing.cjs');
const { registerMarket } = require('./market.cjs');
const config = require('./billing.config.json');
const localFile = path.join(__dirname, 'index.html');
const localUrl = pathToFileURL(localFile).href;

if (process.env.VELARIO_TEST_DATA && !app.isPackaged) app.setPath('userData', path.resolve(process.env.VELARIO_TEST_DATA));
const accountFile = () => path.join(app.getPath('userData'), 'purchase-account.bin');

const billing = createBilling({
  baseUrl: process.env.VELARIO_API_URL || config.apiBaseUrl,
  readAccount: async () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return JSON.parse(safeStorage.decryptString(await fs.readFile(accountFile())));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('No se pudo leer la cuenta de compras guardada.');
    }
  },
  writeAccount: async value => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('El almacenamiento seguro de Windows no está disponible.');
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    const temporary = accountFile() + '.tmp';
    await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)));
    await fs.rename(temporary, accountFile());
  },
  openExternal: url => shell.openExternal(url)
});

function trusted(event) {
  return event.senderFrame && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.split('#')[0] === localUrl;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 560, height: 900, minWidth: 360, minHeight: 640,
    title: 'Velario', backgroundColor: '#eef1f6', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== localUrl) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.loadFile(localFile);
}

app.whenReady().then(() => {
  ipcMain.handle('billing:status', event => { if (!trusted(event)) throw new Error('Origen no permitido.'); return billing.getStatus(); });
  ipcMain.handle('billing:purchase', (event, method) => {
    if (!trusted(event) || typeof method !== 'string' || !/^[a-z][a-z_]{1,23}$/.test(method)) throw new Error('Compra no permitida.');
    return billing.purchase(method);
  });
  ipcMain.handle('billing:manage', event => { if (!trusted(event)) throw new Error('Origen no permitido.'); return billing.manage(); });
  registerMarket(ipcMain, trusted);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
