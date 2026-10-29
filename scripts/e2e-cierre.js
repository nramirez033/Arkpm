// Prueba de la confirmación al cerrar (escritorio). xvfb-run -a node_modules/.bin/electron --no-sandbox --disable-gpu scripts/e2e-cierre.js
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
fs.rmSync(path.join(__dirname, '..', 'data'), { recursive: true, force: true });
const calls = []; let next = { response: 1, checkboxChecked: false };
dialog.showMessageBox = async (_w, o) => { calls.push(o); return next; };
let quit = false, expectQuit = false; const bad = [];
app.on('before-quit', () => { quit = true; if (expectQuit) { console.log('✔ «Salir de Arkpm» cierra la aplicación'); console.log(bad.length ? '\nFALLOS:\n- ' + bad.join('\n- ') : '\nTODO OK'); } });
require('../electron/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (c, w) => { console.log(c ? '✔' : '✖', w); if (!c) bad.push(w); };
app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const desktopFile = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'desktop.json'), 'utf8'));

  // 1) sin segundo plano: pregunta; Cancelar no cierra
  next = { response: 1, checkboxChecked: false }; win.close(); await sleep(500);
  check(calls.length === 1 && calls[0].buttons.join('|') === 'Cerrar Arkpm|Cancelar' && win.isVisible() && !quit, 'sin segundo plano: pregunta «Cerrar Arkpm / Cancelar» y Cancelar mantiene la ventana');

  // 2) con segundo plano: tres opciones; «Pasar a segundo plano» oculta y la app sigue viva
  await js(`window.electronAPI.monitorConfigure({ enabled: true, background: true, interval: 30, events: {}, servers: [] })`); await sleep(400);
  calls.length = 0; next = { response: 0, checkboxChecked: false }; win.close(); await sleep(600);
  check(calls.length === 1 && calls[0].buttons.join('|') === 'Pasar a segundo plano|Salir de Arkpm|Cancelar' && !win.isVisible() && !quit, 'con segundo plano: ofrece pasar a segundo plano / salir / cancelar y oculta la ventana');
  win.show(); await sleep(200);

  // 3) «No volver a preguntar» se guarda y después ya no pregunta (pasa a segundo plano directamente)
  calls.length = 0; next = { response: 0, checkboxChecked: true }; win.close(); await sleep(600);
  check(desktopFile().confirmClose === false, '«No volver a preguntar» queda guardado');
  win.show(); await sleep(200); calls.length = 0; win.close(); await sleep(500);
  check(calls.length === 0 && !win.isVisible() && !quit, 'con la confirmación desactivada ya no pregunta');
  win.show(); await sleep(200);

  // 4) se reactiva desde los ajustes y «Salir de Arkpm» cierra del todo
  await js(`window.electronAPI.desktopSet({ confirmClose: true })`); await sleep(200);
  calls.length = 0; expectQuit = true; next = { response: 1, checkboxChecked: false }; win.close(); await sleep(1500);
  app.exit(1);   // si llegó aquí no se cerró
});
