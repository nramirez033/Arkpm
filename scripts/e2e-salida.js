// Arnés de la prueba de salida: abre la app, crea conexiones SSH reales (UI + vigilante + logs en vivo) y sale por el camino indicado.
// Lo ejecuta scripts/test-cierre-procesos.js. Modos: dialog | quit | sigterm
const { app, dialog, safeStorage, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const MODE = process.argv[process.argv.length - 1];
// Linux sin llavero: el almacén seguro se simula para que el vigilante pueda leer la contraseña
safeStorage.isEncryptionAvailable = () => true; safeStorage.encryptString = (s) => Buffer.from(s); safeStorage.decryptString = (b) => Buffer.from(b).toString();
dialog.showMessageBox = async (_w, o) => ({ response: o.buttons.indexOf('Salir de Arkpm') >= 0 ? o.buttons.indexOf('Salir de Arkpm') : 0, checkboxChecked: false });
fs.rmSync(path.join(__dirname, '..', 'data'), { recursive: true, force: true });
require('../electron/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const o = { host: '127.0.0.1', port: +process.env.ARKPM_TEST_PORT, username: process.env.ARKPM_TEST_USER, password: process.env.ARKPM_TEST_PASS };
  const fp = (await js(`window.electronAPI.sshConnect(${JSON.stringify(o)})`)).fingerprint;
  const c = await js(`window.electronAPI.sshConnect(${JSON.stringify({ ...o, expectedFingerprint: fp })})`);
  if (!c.ok) { console.error('no conectó', c); app.exit(2); return; }
  await js(`window.electronAPI.sshStreamStart(${JSON.stringify(c.sessionId)}, 'tail -F /dev/null', { pty: true })`);      // log en vivo abierto
  await js(`window.electronAPI.sshStreamStart(${JSON.stringify(c.sessionId)}, 'sleep 300', { pty: false })`);              // comando largo sin pty
  await js(`window.electronAPI.secretSave('s1', ${JSON.stringify(JSON.stringify({ password: o.password }))})`);
  await js(`window.electronAPI.monitorConfigure(${JSON.stringify({ enabled: true, background: true, interval: 2, events: {}, servers: [{ id: 's1', name: 'T', host: o.host, port: o.port, username: o.username, auth: 'password', pm2Cmd: 'pm2', shellInit: '', fingerprint: fp, notify: true }] })})`);
  for (let i = 0; i < 40; i++) { const st = await js('window.electronAPI.monitorStatus()'); if (st[0] && st[0].state === 'up') break; await sleep(250); }
  fs.writeFileSync('/tmp/arkpm-salida.pid', String(process.pid));
  console.log('LISTO');
  await sleep(1500);
  if (MODE === 'dialog') win.close();            // cerrar la ventana → «Salir de Arkpm»
  else if (MODE === 'quit') app.quit();
  else if (MODE === 'sigterm') process.kill(process.pid, 'SIGTERM');
});
