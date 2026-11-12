const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage, safeStorage, Notification, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { SshManager, walkLocal } = require('./ssh');
const { openDb } = require('./db');
const { Monitor } = require('./monitor');

app.setAppUserModelId('com.ark.arkpm');   // necesario para las notificaciones de Windows

// Datos portables: todo (arkpm.db, secretos, caché de Chromium) vive en «data» junto al ejecutable.
const baseDir = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'));
try {
  const dataRoot = path.join(baseDir, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  app.setPath('userData', dataRoot);
  app.setPath('sessionData', path.join(dataRoot, 'session'));
} catch (e) { console.warn('No se pudo usar la carpeta junto al ejecutable; se usa la predeterminada:', e.message); }

let win = null;
let db = null;
let dbError = null;
let ssh = null;
let monitor = null;
let tray = null;
let quitting = false;

// ---- opciones de escritorio (inicio con el sistema, inicio oculto, minimizar a segundo plano) ----
let desktop = { autoStart: false, startHidden: false, minimizeToBackground: false, confirmClose: true };
const desktopFile = () => path.join(app.getPath('userData'), 'desktop.json');
const loginSupported = () => (process.platform === 'win32' || process.platform === 'darwin') && (app.isPackaged || !!process.env.PORTABLE_EXECUTABLE_FILE);
function loadDesktop() { try { desktop = { ...desktop, ...JSON.parse(fs.readFileSync(desktopFile(), 'utf8')) }; } catch { /* valores por defecto */ } }
function saveDesktop() { try { fs.writeFileSync(desktopFile(), JSON.stringify(desktop)); } catch (e) { console.warn('No se pudo guardar desktop.json:', e.message); } }
/** Registra (o quita) el inicio con Windows. En la versión portable se usa la ruta del .exe real, no la del descompresor temporal. */
function applyLoginItem() {
  if (!loginSupported()) return;
  try { app.setLoginItemSettings({ openAtLogin: !!desktop.autoStart, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [] }); }
  catch (e) { console.warn('No se pudo configurar el inicio con el sistema:', e.message); }
}

function findIcon() {
  for (const f of [path.join(process.resourcesPath || '', 'icon.png'), path.join(baseDir, 'resources', 'icon.png'), path.join(__dirname, '..', 'resources', 'icon.png'), path.join(__dirname, 'icon.png')]) {
    if (!fs.existsSync(f)) continue;
    const img = nativeImage.createFromPath(f);
    if (!img.isEmpty()) return img;
  }
  return undefined;
}

function initDb() {
  try { db = openDb(path.join(app.getPath('userData'), 'arkpm.db')); }
  catch (e) { db = null; dbError = String(e.message || e); console.error('SQLite no disponible:', dbError); }
}
const needDb = () => { if (!db) throw new Error('SQLite no disponible: ' + dbError); return db; };

// ---- secretos (contraseñas / claves privadas) cifrados con el almacén del sistema (DPAPI en Windows) ----
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch { return {}; } };
const writeSecrets = (o) => fs.writeFileSync(secretsFile(), JSON.stringify(o), { mode: 0o600 });


// ---- vigilante, notificaciones y segundo plano ----
const monitorFile = () => path.join(app.getPath('userData'), 'monitor.json');
const loadSecretFor = async (id) => {
  try { const v = readSecrets()[id]; return v ? JSON.parse(safeStorage.decryptString(Buffer.from(v, 'base64'))) : null; } catch { return null; }
};
const bgEnabled = () => !!(monitor && monitor.cfg.enabled && monitor.cfg.background);
const watchedCount = () => (monitor ? monitor.cfg.servers.filter((s) => s.notify).length : 0);

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide(); updateTray();
  notify({ title: 'Arkpm sigue en segundo plano', body: `Vigilando ${watchedCount()} servidor(es). Haz clic aquí o en el icono de la bandeja para abrirlo.`, serverId: '' });
}

let asking = false;
/** Pregunta antes de cerrar. Con segundo plano activo ofrece pasar a segundo plano, salir del todo o cancelar. */
async function askBeforeClosing() {
  if (asking || !win || win.isDestroyed()) return;
  asking = true;
  try {
    const bg = bgEnabled();
    const buttons = bg ? ['Pasar a segundo plano', 'Salir de Arkpm', 'Cancelar'] : ['Cerrar Arkpm', 'Cancelar'];
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true, title: 'Arkpm',
      message: bg ? '¿Qué quieres hacer con Arkpm?' : '¿Cerrar Arkpm?',
      detail: bg ? `Si pasa a segundo plano seguirá vigilando ${watchedCount()} servidor(es) desde la bandeja del sistema. Si sales, dejará de vigilar y de avisarte.` : 'Se cerrarán las conexiones con tus servidores.',
      checkboxLabel: 'No volver a preguntar', checkboxChecked: false,
    });
    const cancelled = r.response === buttons.length - 1;
    if (r.checkboxChecked && !cancelled) { desktop.confirmClose = false; saveDesktop(); }
    if (cancelled) return;
    if (bg && r.response === 0) hideToTray();
    else { quitting = true; app.quit(); }
  } finally { asking = false; }
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function notify(n) {
  if (!Notification.isSupported()) return;
  const nt = new Notification({ title: n.title, body: n.body, icon: findIcon(), silent: false });
  nt.on('click', () => { showWindow(); if (win && n.serverId) win.webContents.send('notify:click', { serverId: n.serverId, app: n.app || null }); });
  nt.show();
}

const wantTray = () => bgEnabled() || desktop.minimizeToBackground || desktop.startHidden;

function updateTray() {
  if (!wantTray()) { if (tray) { tray.destroy(); tray = null; } return; }
  if (!tray) {
    const img = findIcon();
    tray = new Tray(img ? img.resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
    tray.on('click', showWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir Arkpm', click: showWindow },
      { type: 'separator' },
      { label: 'Salir', click: () => { quitting = true; app.quit(); } },
    ]));
  }
  tray.setToolTip(bgEnabled() ? `Arkpm · vigilando ${watchedCount()} servidor(es)` : 'Arkpm');
}

function initMonitor() {
  monitor = new Monitor({ ssh: new SshManager(), notify, loadSecret: loadSecretFor, log: (...a) => console.warn('[monitor]', ...a) });
  try { monitor.configure(JSON.parse(fs.readFileSync(monitorFile(), 'utf8'))); } catch { /* aún sin configurar */ }
  updateTray();
}

function registerIpc() {
  // ---------- SSH ----------
  ssh = new SshManager((ch, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); });
  initMonitor();
  ipcMain.handle('monitor:configure', (_e, cfg) => {
    try { fs.writeFileSync(monitorFile(), JSON.stringify(cfg), { mode: 0o600 }); } catch (e) { console.warn('No se pudo guardar monitor.json:', e.message); }
    monitor.configure(cfg); updateTray();
  });
  ipcMain.handle('desktop:get', () => ({ ...desktop, supported: loginSupported(), platform: process.platform }));
  ipcMain.handle('desktop:set', (_e, patch) => {
    for (const k of ['autoStart', 'startHidden', 'minimizeToBackground', 'confirmClose']) if (typeof patch[k] === 'boolean') desktop[k] = patch[k];
    saveDesktop(); applyLoginItem(); updateTray();
    return { ...desktop, supported: loginSupported(), platform: process.platform };
  });
  ipcMain.handle('monitor:status', () => monitor.status());
  ipcMain.handle('monitor:mute', (_e, serverId, name) => monitor.mute(serverId, name));
  ipcMain.handle('notify:test', () => notify({ title: 'Arkpm', body: 'Así se verán los avisos de tus servidores.', serverId: '' }));
  ipcMain.handle('notify:permission', () => (Notification.isSupported() ? 'granted' : 'denied'));
  ipcMain.handle('ssh:connect', (_e, o) => ssh.connect(o));
  ipcMain.handle('ssh:disconnect', (_e, id) => ssh.disconnect(id));
  ipcMain.handle('ssh:exec', (_e, id, cmd, opts) => ssh.exec(id, cmd, opts || {}));
  ipcMain.handle('ssh:streamStart', (_e, id, cmd, opts) => ssh.streamStart(id, cmd, opts || {}));
  ipcMain.handle('ssh:streamStop', (_e, sid) => ssh.streamStop(sid));
  ipcMain.handle('ssh:list', (_e, id, p) => ssh.list(id, p));
  ipcMain.handle('ssh:stat', (_e, id, p) => ssh.stat(id, p));
  ipcMain.handle('ssh:readFile', (_e, id, p, max) => ssh.readFile(id, p, max));
  ipcMain.handle('ssh:writeFile', (_e, id, p, data) => ssh.writeFile(id, p, data));
  ipcMain.handle('ssh:uploadMany', (_e, id, job, items) => ssh.uploadMany(id, job, items.map((i) => ({ local: i.local, remote: i.remote, size: i.size }))));
  ipcMain.handle('ssh:download', (_e, id, job, remote, dir, name) => ssh.download(id, job, remote, dir, name));
  ipcMain.handle('ssh:cancelJob', (_e, job) => ssh.cancelJob(job));

  // ---------- archivos locales ----------
  ipcMain.handle('local:pickFiles', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(win, { title: opts.title || 'Elegir archivos', properties: ['openFile', ...(opts.multi === false ? [] : ['multiSelections'])], filters: opts.filters });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(async (p) => ({ ref: p, name: path.basename(p), size: (await fsp.stat(p)).size })));
  });
  ipcMain.handle('local:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Elegir carpeta', properties: ['openDirectory'] });
    return r.canceled ? null : { root: r.filePaths[0], name: path.basename(r.filePaths[0]) };
  });
  ipcMain.handle('local:pickSaveDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Carpeta de destino', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('local:walk', (_e, root, rules) => walkLocal(root, rules || []));
  ipcMain.handle('local:showItem', (_e, p) => { shell.showItemInFolder(p); });
  ipcMain.handle('local:openFolder', async (_e, p) => { const err = await shell.openPath(p); if (err) throw new Error(err); });
  ipcMain.handle('local:exists', (_e, p) => fs.existsSync(p));

  // ---------- secretos ----------
  ipcMain.handle('secret:save', (_e, id, value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('El sistema no ofrece almacenamiento seguro de contraseñas');
    const all = readSecrets();
    all[id] = safeStorage.encryptString(String(value)).toString('base64');
    writeSecrets(all);
  });
  ipcMain.handle('secret:load', (_e, id) => {
    try { const v = readSecrets()[id]; return v ? safeStorage.decryptString(Buffer.from(v, 'base64')) : null; } catch { return null; }
  });
  ipcMain.handle('secret:delete', (_e, id) => { const all = readSecrets(); delete all[id]; writeSecrets(all); });

  // ---------- SQLite ----------
  ipcMain.handle('db:exec', (_e, sql) => { needDb().exec(sql); });
  ipcMain.handle('db:run', (_e, sql, params = []) => { needDb().run(sql, ...params); });
  ipcMain.handle('db:all', (_e, sql, params = []) => needDb().all(sql, ...params));
  ipcMain.handle('db:tx', (_e, stmts) => { const d = needDb(); d.tx(() => { for (const s of stmts) d.run(s.sql, ...(s.params || [])); }); });

  // ---------- ventana ----------
  ipcMain.handle('win:minimize', () => win && win.minimize());
  ipcMain.handle('win:toggleMax', () => { if (!win) return false; if (win.isMaximized()) win.unmaximize(); else win.maximize(); return win.isMaximized(); });
  ipcMain.handle('win:close', () => win && win.close());
  ipcMain.handle('win:isMax', () => !!win && win.isMaximized());
  ipcMain.handle('app:platform', () => process.platform);
}

function createWindow() {
  Menu.setApplicationMenu(null);
  const isWin = process.platform === 'win32';
  const startHidden = desktop.startHidden || process.argv.includes('--hidden');
  win = new BrowserWindow({
    show: !startHidden,
    width: 1200, height: 780, minWidth: 820, minHeight: 560,
    backgroundColor: '#161717', autoHideMenuBar: true, icon: findIcon(),
    // Windows 11: botones nativos de la ventana (con diseños de ajuste al pasar sobre «maximizar») sobre nuestra barra
    ...(isWin ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1d1e1e', symbolColor: '#e9eaea', height: 38 } } : { frame: false }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.on('close', (e) => {
    if (quitting) return;
    // con «segundo plano» activo, cerrar la ventana solo la oculta: el vigilante sigue y la app queda en la bandeja
    if (!desktop.confirmClose) {
      if (bgEnabled()) { e.preventDefault(); hideToTray(); }
      return;
    }
    e.preventDefault();
    askBeforeClosing();
  });
  // «al minimizar, pasar a segundo plano»: la ventana se oculta (queda el icono de la bandeja) y una notificación lo avisa
  win.on('minimize', () => {
    if (quitting || !desktop.minimizeToBackground) return;
    setImmediate(() => {
      if (!win || win.isDestroyed()) return;
      win.hide(); updateTray();
      notify({ title: 'Arkpm pasó a segundo plano', body: bgEnabled() ? `Sigue vigilando ${watchedCount()} servidor(es). Haz clic aquí o en el icono de la bandeja para abrirlo.` : 'Está en la bandeja del sistema. Haz clic aquí o en su icono para abrirlo.', serverId: '' });
    });
  });
  if (startHidden) {
    updateTray();
    win.webContents.once('did-finish-load', () => notify({ title: 'Arkpm se inició en segundo plano', body: 'Está en la bandeja del sistema. Haz clic aquí o en su icono para abrir la ventana.', serverId: '' }));
  }
  win.on('session-end', () => { quitting = true; });   // apagado de Windows: no bloquear con el cierre a bandeja
  win.on('closed', () => { win = null; });
  const sendState = () => { if (win && !win.isDestroyed()) win.webContents.send('win:state', { maximized: win.isMaximized() }); };
  win.on('maximize', sendState); win.on('unmaximize', sendState);
  const devUrl = process.env.NG_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'app', 'browser', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => { loadDesktop(); applyLoginItem(); initDb(); registerIpc(); createWindow(); });
}
// ---- salida: al cerrar de verdad no debe quedar NADA corriendo (ventana, bandeja, vigilante, sesiones SSH, procesos hijos) ----
let forceExit = null;
app.on('before-quit', () => {
  quitting = true;
  try { monitor && monitor.shutdown(); } catch { /* nada */ }          // detiene el temporizador y cierra sus sesiones SSH
  try { ssh && ssh.disconnectAll(); } catch { /* nada */ }             // cierra las sesiones de la interfaz (los `tail -F` remotos mueren con su pty)
  try { if (tray) { tray.destroy(); tray = null; } } catch { /* nada */ }   // sin esto Windows deja el icono «fantasma» en la bandeja
  try { if (db) { db.close(); db = null; } } catch { /* nada */ }
  // red de seguridad: si algo impidiera terminar, se fuerza la salida (mata también a los procesos hijos de Electron)
  if (!forceExit) forceExit = setTimeout(() => app.exit(0), 3000);
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { quitting = true; app.quit(); });
app.on('window-all-closed', () => { if (!bgEnabled() || quitting) app.quit(); });
