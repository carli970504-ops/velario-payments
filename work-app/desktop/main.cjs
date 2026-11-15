const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { createBilling } = require('./billing.cjs');
const { registerMarket } = require('./market.cjs');
const config = require('./billing.config.json');

const localFile = path.join(__dirname, 'index.html');
const errorFile = path.join(__dirname, 'error.html');
const warningFile = path.join(__dirname, 'boot-warning.js');
const localUrl = pathToFileURL(localFile).href;
const errorUrl = pathToFileURL(errorFile).href;

if (process.env.VELARIO_TEST_DATA && !app.isPackaged) app.setPath('userData', path.resolve(process.env.VELARIO_TEST_DATA));
const accountFile = () => path.join(app.getPath('userData'), 'purchase-account.bin');
const logFile = () => path.join(app.getPath('userData'), 'velario.log');
const pendingBoot = () => path.join(app.getPath('userData'), 'arranque-pendiente');
const crashCount = () => path.join(app.getPath('userData'), 'arranque-fallos');
function crashCountValue() {
  try { return Number(fs.readFileSync(crashCount(), 'utf8')) || 0; } catch (error) { return 0; }
}

// Registro propio: arranque, CSP, red y errores de JavaScript quedan en disco para poder
// diagnosticar una pantalla en blanco sin depender de la consola de DevTools.
function logLine(scope, text) {
  try {
    const file = logFile();
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, new Date().toISOString() + ' [' + scope + '] ' + String(text == null ? '' : text).replace(/\s+$/, '') + '\n');
  } catch (error) {
    // El registro nunca debe tumbar la aplicación.
  }
}
process.on('uncaughtException', error => logLine('main', error && error.stack || String(error)));
process.on('unhandledRejection', error => logLine('main', error && error.stack || String(error)));

// --- Protección contra el arranque doble y contra bucles de caída -------------------
// Una segunda instancia sobre el mismo perfil es una causa conocida de cierres
// anómalos con 0x80000003: se enfoca la ventana existente en lugar de arrancar otra.
const instanciaUnica = app.requestSingleInstanceLock();
if (instanciaUnica) {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// Si la ejecución anterior no llegó a pintar la interfaz, esta vez se arranca sin GPU:
// un driver gráfico inestable es la causa más habitual del breakpoint 0x80000003.
let modoSeguro = false;
try {
  if (fs.existsSync(pendingBoot())) {
    modoSeguro = true;
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
  }
} catch (error) {
  // sin modo seguro si el perfil no se puede leer
}

const billing = createBilling({
  baseUrl: process.env.VELARIO_API_URL || config.apiBaseUrl,
  readAccount: async () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return JSON.parse(safeStorage.decryptString(await fsp.readFile(accountFile())));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('No se pudo leer la cuenta de compras guardada.');
    }
  },
  writeAccount: async value => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('El almacenamiento seguro de Windows no está disponible.');
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    const temporary = accountFile() + '.tmp';
    await fsp.writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)));
    await fsp.rename(temporary, accountFile());
  },
  // VELARIO_OPEN_SINK existe solo para pruebas automatizadas: apunta el pago a un archivo
  // en lugar de abrir el navegador del usuario.
  openExternal: async url => {
    if (process.env.VELARIO_OPEN_SINK) {
      fs.appendFileSync(process.env.VELARIO_OPEN_SINK, url + '\n');
      return;
    }
    await shell.openExternal(url);
  }
});

function fromPage(event) {
  return Boolean(event.senderFrame) && event.senderFrame === event.sender.mainFrame
    && [localUrl, errorUrl].some(base => event.senderFrame.url.split('#')[0] === base);
}

function showError(win, code) {
  if (win.isDestroyed()) return;
  const intentos = (win.__errorAttempts || 0) + 1;
  win.__errorAttempts = intentos;
  logLine('arranque', 'pantalla de error: ' + code + (intentos > 1 ? ' (intento ' + intentos + ')' : ''));
  // El motor puede tardar unos milisegundos en aceptar una página nueva tras la caída:
  // se reintenta una vez en lugar de dejar la ventana vacía.
  win.loadFile(errorFile, { query: { code: String(code) } }).catch(error => {
    logLine('arranque', 'no se pudo abrir error.html: ' + error.message);
    if (intentos < 3 && !win.isDestroyed()) setTimeout(() => showError(win, code), 600);
  });
}

// Si nadie avisa que la interfaz está lista, se pinta un aviso dentro de la página.
// Funciona incluso cuando la CSP bloqueó el script de la app (executeJavaScript no la obedece).
function showWarning(win) {
  try {
    const script = fs.readFileSync(warningFile, 'utf8').replace('__LOG_PATH__', JSON.stringify(logFile()));
    win.webContents.executeJavaScript(script, true).catch(error => logLine('arranque', 'aviso no inyectado: ' + error.message));
  } catch (error) {
    logLine('arranque', 'no se pudo leer boot-warning.js: ' + error.message);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 560, height: 900, minWidth: 360, minHeight: 640,
    title: 'Velario', backgroundColor: '#eef1f6', autoHideMenuBar: true, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  let watchdog = null;
  const stop = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const base = url.split('#')[0];
    if (base !== localUrl && base !== errorUrl) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL();
    logLine('carga', 'página lista: ' + url);
    if (url.includes('index.html')) { win.__crashHandled = false; win.__errorAttempts = 0; }
    stop();
    watchdog = setTimeout(() => {
      if (win.__velarioBooted || win.isDestroyed()) return;
      logLine('arranque', 'la interfaz no avisó "lista" en 12 s');
      showWarning(win);
    }, 12000);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    logLine('carga', code + ' ' + description + ' ' + url);
    if (isMainFrame && !String(url).includes('error.html')) showError(win, code);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logLine('preload', preloadPath + ': ' + (error && error.stack || error));
  });
  // 0x80000003 (exitCode -2147483645) llega aquí: el proceso de la ventana se rompe.
  // La primera vez se reinicia automáticamente sin GPU; si vuelve a caer, se explica.
  win.webContents.on('render-process-gone', (_event, details) => {
    // Un mismo fallo puede avisar dos veces: se atiende solo la primera.
    if (win.__crashHandled) return;
    win.__crashHandled = true;
    const motivo = (details && details.reason) || 'desconocido';
    logLine('proceso', 'el proceso de la ventana terminó: ' + JSON.stringify(details));
    const fallos = crashCountValue() + 1;
    try { fs.writeFileSync(crashCount(), String(fallos)); } catch (error) { /* sin contador */ }
    try { fs.writeFileSync(pendingBoot(), String(Date.now())); } catch (error) { /* sin marca */ }
    if (['crashed', 'oom', 'abnormal-exit'].includes(motivo) && fallos < 2) {
      logLine('arranque', 'reinicio automático en modo seguro tras la caída');
      app.relaunch();
      app.exit(0);
      return;
    }
    // Se deja respirar al motor: cargar justo en el instante de la caída falla a menudo.
    setTimeout(() => showError(win, 'render-' + motivo), 350);
  });
  win.on('unresponsive', () => logLine('proceso', 'ventana sin responder'));
  win.on('responsive', () => logLine('proceso', 'ventana responde de nuevo'));
  win.webContents.on('console-message', (event, level, message) => {
    const detail = event && typeof event === 'object' && 'message' in event ? event : null;
    const text = String((detail ? detail.message : message) || '').slice(0, 1500);
    const lvl = detail ? detail.level : level;
    if (!text) return;
    logLine(/Content Security Policy|Refused to/i.test(text) ? 'csp' : 'consola', '[' + lvl + '] ' + text);
  });
  win.on('closed', () => { stop(); logLine('ventana', 'cerrada'); });

  win.loadFile(localFile).catch(error => {
    logLine('carga', 'index.html no cargó: ' + error.message);
    showError(win, 'index');
  });
}

app.whenReady().then(() => {
  if (!instanciaUnica) return;
  logLine('arranque', 'Velario ' + app.getVersion() + ' · Electron ' + process.versions.electron + ' · ' + process.platform + (modoSeguro ? ' · modo seguro (sin GPU)' : ''));
  try { fs.writeFileSync(pendingBoot(), String(Date.now())); } catch (error) { /* el aviso no es imprescindible */ }
  // Un arranque normal (no en modo seguro) significa que el anterior terminó bien.
  if (!modoSeguro) { try { fs.unlinkSync(crashCount()); } catch (error) { /* no había contador */ } }
  app.on('child-process-gone', (_event, details) => logLine('proceso', 'proceso auxiliar terminado: ' + JSON.stringify(details)));
  // Puente de diagnóstico del renderer: errores, aviso de "lista" y acceso al registro.
  ipcMain.on('app:log', (event, kind, text) => {
    if (!fromPage(event)) return;
    logLine('render:' + String(kind || 'error').slice(0, 24), String(text == null ? '' : text).slice(0, 4000));
  });
  ipcMain.on('app:boot-ok', event => {
    if (!fromPage(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) { win.__velarioBooted = true; logLine('arranque', 'interfaz lista' + (modoSeguro ? ' (modo seguro)' : '')); }
    // Arranque correcto: la próxima vez ya no hace falta el modo seguro.
    try { fs.unlinkSync(pendingBoot()); } catch (error) { /* ya no estaba */ }
  });
  ipcMain.handle('app:paths', event => { if (!fromPage(event)) throw new Error('Origen no permitido.'); return { logs: logFile(), version: app.getVersion() }; });
  ipcMain.handle('app:open-logs', async event => {
    if (!fromPage(event)) throw new Error('Origen no permitido.');
    try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(logFile(), ''); } catch (error) { /* nada */ }
    const result = await shell.openPath(logFile());
    if (result) await shell.openPath(app.getPath('userData'));
    return logFile();
  });

  ipcMain.handle('billing:status', event => { if (!fromPage(event)) throw new Error('Origen no permitido.'); return billing.getStatus(); });
  ipcMain.handle('billing:purchase', (event, method) => {
    if (!fromPage(event) || typeof method !== 'string' || !/^[a-z][a-z_]{1,23}$/.test(method)) throw new Error('Compra no permitida.');
    return billing.purchase(method);
  });
  ipcMain.handle('billing:manage', event => { if (!fromPage(event)) throw new Error('Origen no permitido.'); return billing.manage(); });
  ipcMain.handle('billing:credit-checkout', (event, mode) => {
    if (!fromPage(event)) throw new Error('Origen no permitido.');
    // Los modos son cripto, acciones, etf y opciones: el más corto tiene 3 letras.
    if (typeof mode !== 'string' || !/^[a-z]{3,12}$/.test(mode)) throw new Error('Modo no válido.');
    return billing.creditCheckout(mode);
  });
  ipcMain.handle('billing:credit-claim', (event, session) => {
    if (!fromPage(event)) throw new Error('Origen no permitido.');
    if (typeof session !== 'string' || session.length > 200) throw new Error('Compra no válida.');
    return billing.creditClaim(session);
  });
  ipcMain.handle('billing:reward', (event, mode, amount) => {
    if (!fromPage(event)) throw new Error('Origen no permitido.');
    if (typeof mode !== 'string' || !/^[a-z]{3,12}$/.test(mode)) throw new Error('Modo no válido.');
    return billing.claimReward(mode, amount);
  });
  registerMarket(ipcMain, fromPage);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { logLine('ventana', 'todas cerradas'); if (process.platform !== 'darwin') app.quit(); });
if (!instanciaUnica) app.quit();
