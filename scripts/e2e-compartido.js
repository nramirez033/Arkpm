// Prueba de que las notas y la configuración viven en el servidor (.arkpm) y se ven desde «otro dispositivo».
// Fase 1 crea datos; se borra la carpeta data/ (otro dispositivo / otra IP); fase 2 comprueba que todo reaparece. ARKPM_PHASE=1|2
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const OUT = process.env.ARKPM_E2E_OUT || '/tmp/arkpm-shots4';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/tmp'] });
if (false) { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '..', 'data', 'desktop.json'), JSON.stringify({ startHidden: true })); }
require('../electron/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
app.whenReady().then(async () => {
  await sleep(1200);
  const win = BrowserWindow.getAllWindows()[0];
  if (false) {
    const ok = !win.isVisible();
    console.log(ok ? '✔ «iniciar en segundo plano»: la ventana no se muestra al abrir' : '✖ la ventana se mostró');
    app.exit(ok ? 0 : 1); return;
  }
  win.setMinimumSize(300, 300); win.setSize(1280, 800); await sleep(400);
  const safe = async (code) => { const r = await win.webContents.executeJavaScript(`(() => { try { return (${code}); } catch (e) { return 'ERR:' + e.message; } })()`); if (typeof r === 'string' && r.startsWith('ERR:')) throw new Error(r.slice(4)); return r; };
  const text = () => win.webContents.executeJavaScript('document.body.innerText');
  const click = (t, ctx = '') => safe(`(() => { const root = ${ctx ? `document.querySelector(${JSON.stringify(ctx)})` : 'document'}; const els = [...root.querySelectorAll('button, .item, .seg button, .tabs button, .bottom button, .row-e')].filter(e => e.offsetParent !== null && e.textContent.trim().includes(${JSON.stringify(t)})); if (!els.length) throw new Error('no se encontró: ' + ${JSON.stringify(t)}); els[0].click(); return true; })()`);
  const type = (sel, v) => safe(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('sin campo ' + ${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const expect = async (frag, what) => { for (let i = 0; i < 60; i++) { if ((await text()).includes(frag)) { console.log('✔', what); return; } await sleep(250); } failures.push(what); console.log('✖', what, '— no apareció:', frag); };
  const check = (cond, what) => { if (cond) console.log('✔', what); else { failures.push(what); console.log('✖', what); } };
  const shot = async (n) => { await sleep(300); fs.writeFileSync(path.join(OUT, n + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { failures.push(name + ': ' + e.message); console.log('✖', name, e.message); await shot('error-' + name); } };
  const addServer = async (name, user) => {
    await safe(`document.querySelector('button[aria-label="Agregar servidor"]').click()`); await sleep(300);
    await type('.modal input[placeholder="Producción, VPS cliente…"]', name); await type('.modal input[placeholder="203.0.113.10"]', '127.0.0.1');
    await type('.modal input[type=number]', process.env.ARKPM_TEST_PORT || '2222'); await type('.modal input[placeholder="ubuntu"]', user);
    await safe(`(() => { const c = document.querySelector('.modal input[type=checkbox]'); if (c.checked) c.click(); })()`);
    await click('Guardar', '.modal'); await expect(name, 'servidor «' + name + '» guardado');
  };
  const connect = async (name) => {
    await click(name, '.srv, app-server-list'); await sleep(400);
    if ((await text()).includes('Verificar servidor')) await click('Confiar y conectar');
    await expect('Contraseña de', 'pide contraseña'); await type('.modal input[type=password]', process.env.ARKPM_TEST_PASS || 'Test1234'); await click('Conectar', '.modal');
    await expect('Sistema y hardware', 'conectado');
  };



  const SD = '/home/deploy/miapp/.arkpm';
  const PHASE = process.env.ARKPM_PHASE;
  const setup = async () => {
    await addServer('Servidor A', 'deploy'); await connect('Servidor A');
    await safe(`document.querySelector('button[aria-label="Agregar app"]').click()`); await expect('miapp', 'miapp disponible'); await click('miapp', '.modal'); await expect('Tiempo activa', 'detalle');
  };
  if (PHASE === '1') {
    await step('crear-datos', async () => {
      await setup();
      await click('Deploy', '.tabs'); await expect('Qué subir', 'pestaña deploy');
      await expect('se guardan en el servidor', 'aviso: la configuración se guarda en el servidor');
      await type('app-deploy-tab textarea[placeholder^=".env"]', '.env\nmi-carpeta-guardada\nuploads'); await sleep(1800);
      await click('Notas', '.tabs'); await expect('Todavía no hay notas', 'sin notas');
      await safe(`document.querySelector('app-notes-tab button[aria-label="Nueva nota"]').click()`); await sleep(300);
      await type('app-notes-tab textarea.note', 'Nota compartida\nlínea dos de la nota'); await expect('Guardado', 'nota guardada'); await sleep(800);
    });
    await step('archivos-en-el-servidor', async () => {
      const notes = fs.readdirSync(SD + '/notes');
      check(notes.length === 1, 'hay 1 archivo de nota en el servidor: ' + notes.join(','));
      const n = JSON.parse(fs.readFileSync(SD + '/notes/' + notes[0], 'utf8'));
      check(n.text.startsWith('Nota compartida') && n.author === 'deploy', 'la nota tiene su texto y su autor (' + n.author + ')');
      const c = JSON.parse(fs.readFileSync(SD + '/config.json', 'utf8'));
      check(c.deploy.preserve.includes('mi-carpeta-guardada') && c.rev >= 2 && c.updatedBy === 'deploy', 'config.json tiene la configuración del deploy (rev ' + c.rev + ')');
      check(!('saveDir' in c.backup) && !('saveDirLabel' in c.backup), 'la carpeta de destino del dispositivo no se sube al servidor');
      check((fs.statSync(SD + '/config.json').mode & 0o666) === 0o666, 'permisos abiertos para que otro usuario pueda editar');
    });
  } else {
    await step('otro-dispositivo', async () => {
      await setup();
      await click('Deploy', '.tabs'); await expect('Qué subir', 'pestaña deploy');
      for (let i = 0; i < 40 && !(await safe(`document.querySelector('app-deploy-tab textarea[placeholder^=".env"]').value`)).includes('mi-carpeta-guardada'); i++) await sleep(250);
      check((await safe(`document.querySelector('app-deploy-tab textarea[placeholder^=".env"]').value`)).includes('mi-carpeta-guardada'), 'otro dispositivo: la configuración del deploy viene del servidor');
      await click('Notas', '.tabs'); await expect('Nota compartida', 'otro dispositivo: la nota viene del servidor');
      await shot('01-otro-dispositivo');
    });
    await step('otro-usuario-edita', async () => {
      // otro usuario edita la nota directamente en el servidor
      const f = SD + '/notes/' + fs.readdirSync(SD + '/notes')[0];
      const n = JSON.parse(fs.readFileSync(f, 'utf8'));
      fs.writeFileSync(f, JSON.stringify({ ...n, text: 'Nota compartida\neditada por otro usuario', updatedAt: Date.now() + 5000, author: 'otro' }));
      await safe(`document.querySelector('app-notes-tab button[aria-label="Actualizar desde el servidor"]').click()`);
      await expect('editada por otro usuario', 'la edición de otro usuario aparece al actualizar');
      check((await text()).includes('otro'), 'se muestra quién la editó');
    });
    await step('conflicto', async () => {
      // yo empiezo a escribir; mientras, otro usuario guarda; al guardar yo se detecta el conflicto
      await type('app-notes-tab textarea.note', 'Nota compartida\nmi versión local'); await sleep(200);
      const f = SD + '/notes/' + fs.readdirSync(SD + '/notes')[0];
      const n = JSON.parse(fs.readFileSync(f, 'utf8'));
      fs.writeFileSync(f, JSON.stringify({ ...n, text: 'Nota compartida\nversión nueva del otro', updatedAt: Date.now() + 9000, author: 'otro2' }));
      await sleep(1400);
      await expect('cambió en el servidor', 'al guardar con edición ajena en medio se avisa del conflicto'); await shot('02-conflicto');
      await click('Descartar los míos'); await sleep(500);
      check((await safe(`document.querySelector('app-notes-tab textarea.note').value`)).includes('versión nueva del otro'), 'se carga la versión del servidor');
    });
    await step('eliminar', async () => {
      await safe(`document.querySelector('app-notes-tab button[aria-label="Eliminar nota"]').click()`); await click('Eliminar', '.modal footer'); await sleep(800);
      check(fs.readdirSync(SD + '/notes').length === 0, 'eliminar una nota la borra del servidor para todos');
    });
  }
  console.log(failures.length ? '\nFALLOS:\n- ' + failures.join('\n- ') : '\nTODO OK');
  app.exit(failures.length ? 1 : 0);
});
