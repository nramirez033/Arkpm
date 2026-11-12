// Prueba de las pestañas Terminal y Notas.
// xvfb-run -a node_modules/.bin/electron --no-sandbox --disable-gpu scripts/e2e-terminal-notas.js
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const OUT = process.env.ARKPM_E2E_OUT || '/tmp/arkpm-shots3';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/tmp'] });
if (process.env.ARKPM_START_HIDDEN) { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '..', 'data', 'desktop.json'), JSON.stringify({ startHidden: true })); }
require('../electron/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
app.whenReady().then(async () => {
  await sleep(1200);
  const win = BrowserWindow.getAllWindows()[0];
  if (process.env.ARKPM_START_HIDDEN) {
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


  const term = async (cmd) => {
    await type('app-terminal-tab input.mono', cmd);
    await safe(`document.querySelector('app-terminal-tab input.mono').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  };
  const waitIdle = async () => { for (let i = 0; i < 60; i++) { if (!(await safe(`!!document.querySelector('app-terminal-tab .spin-dots')`))) return; await sleep(200); } };
  await step('preparar', async () => {
    await addServer('Servidor A', 'deploy'); await connect('Servidor A');
    await safe(`document.querySelector('button[aria-label="Agregar app"]').click()`); await expect('miapp', 'miapp disponible'); await click('miapp', '.modal'); await expect('Tiempo activa', 'detalle');
    const labels = await safe(`[...document.querySelectorAll('.tabs button')].map(b => b.textContent.trim()).join(' · ')`);
    check(/Terminal · Notas · Logs$/.test(labels), 'pestañas: ' + labels);
  });
  await step('terminal', async () => {
    await click('Terminal', '.tabs'); await expect('Escribe un comando', 'terminal lista');
    await term('pwd'); await waitIdle(); await expect('/home/deploy/miapp', 'pwd ejecuta en la carpeta de la app');
    await term('cd uploads'); await waitIdle(); await term('pwd'); await waitIdle(); await expect('/home/deploy/miapp/uploads', 'el cd se mantiene entre comandos');
    check((await safe(`document.querySelector('app-terminal-tab .prompt .ps').textContent`)).includes('~/miapp/uploads'), 'el prompt muestra la carpeta actual (~/miapp/uploads)');
    await term('ls no-existe'); await waitIdle(); await expect('código de salida', 'un comando con error muestra su código de salida');
    await term('echo hola mundo | tr a-z A-Z'); await waitIdle(); await expect('HOLA MUNDO', 'tuberías y comandos del servidor');
    await term('read x; echo fin'); await waitIdle(); await expect('fin', 'un comando que espera teclado no se cuelga');
    await term('sleep 30'); await sleep(700); check(await safe(`!!document.querySelector('app-terminal-tab .spin-dots')`), 'un comando largo queda en ejecución');
    await click('Detener', 'app-terminal-tab'); await waitIdle(); await expect('comando detenido', 'se puede detener un comando en curso');
    await term('rm -rf carpeta-inexistente'); await expect('Comando delicado', 'comandos riesgosos piden confirmación'); await click('Cancelar', '.modal'); await sleep(300);
    check(!(await text()).includes('~/miapp/uploads$ rm -rf'), 'si se cancela, el comando riesgoso no se ejecuta');
    await click('Carpeta de la app', 'app-terminal-tab'); await term('ls'); await waitIdle(); await expect('server.js', 'volver a la carpeta de la app');
    await shot('01-terminal');
  });
  await step('notas', async () => {
    await click('Notas', '.tabs'); await expect('Todavía no hay notas', 'sin notas al principio');
    await safe(`document.querySelector('app-notes-tab button[aria-label="Nueva nota"]').click()`); await sleep(300);
    await type('app-notes-tab textarea.note', 'Deploy de producción\nPrimero avisar al equipo y correr npm ci.'); await expect('Guardado', 'la nota se guarda sola');
    await safe(`document.querySelector('app-notes-tab button[aria-label="Nueva nota"]').click()`); await sleep(300);
    await type('app-notes-tab textarea.note', 'Contactos\nSoporte: 555-0100'); await expect('Guardado', 'segunda nota guardada');
    await shot('02-notas');
    const lista = await safe(`[...document.querySelectorAll('app-notes-tab .nl .item .t')].map(e => e.textContent.trim()).join('|')`);
    check(lista.includes('Contactos') && lista.includes('Deploy de producción'), 'lista de notas: ' + lista);
  });
  await step('notas-otro-usuario', async () => {
    await safe(`(() => { const b = [...document.querySelectorAll('app-server-list .item')].find(e => e.textContent.includes('Servidor A')).querySelector('button'); b.click(); })()`);
    await click('Editar'); await sleep(300); await type('.modal input[placeholder="ubuntu"]', 'otro-usuario'); await click('Guardar', '.modal'); await sleep(500);
    await click('miapp', 'app-app-list'); await sleep(500); await click('Notas', '.tabs'); await sleep(400);
    const l1 = await safe(`[...document.querySelectorAll('app-notes-tab .nl .item .t')].map(e => e.textContent.trim()).join('|')`);
    check(l1.includes('Contactos') && l1.includes('Deploy de producción'), 'las notas se conservan al cambiar el usuario SSH');
    await addServer('Servidor B', 'deploy'); await connect('Servidor B');
    await safe(`document.querySelector('button[aria-label="Agregar app"]').click()`); await expect('miapp', 'miapp en el perfil B'); await click('miapp', '.modal'); await expect('Tiempo activa', 'detalle');
    await click('Notas', '.tabs'); await sleep(400);
    const l2 = await safe(`[...document.querySelectorAll('app-notes-tab .nl .item')].map(e => e.textContent.trim()).join('|')`);
    check(l2.includes('Contactos') && l2.includes('Deploy de producción'), 'otro perfil del mismo servidor ve las mismas notas');
    check(l2.includes('otro-usuario') || l2.includes('deploy'), 'cada nota muestra quién la editó: ' + l2.slice(0, 120));
    await type('app-notes-tab textarea.note', 'Contactos\nSoporte: 555-0100\nEditado desde el perfil B'); await expect('Guardado', 'edita una nota desde otro perfil');
    await shot('03-notas-perfil-b');
  });
  await step('telefono', async () => {
    win.setSize(400, 820); await sleep(900);
    await shot('04-telefono-notas-lista'); await click('Contactos', 'app-notes-tab'); await sleep(400); await shot('05-telefono-notas-editor');
    await safe(`document.querySelector('app-notes-tab .editor button[aria-label="Volver"]').click()`); await sleep(300);
    const tabs = await safe(`[...document.querySelectorAll('.bottom button')].map(b => b.textContent.trim()).join('|')`);
    check(tabs === 'Estado|Archivos|Deploy|Backup|Terminal|Notas|Logs', 'barra inferior del teléfono con las 7 pestañas: ' + tabs);
    await click('Terminal', '.bottom'); await sleep(500); await term('pwd'); await waitIdle(); await shot('06-telefono-terminal');
  });
  console.log(failures.length ? '\nFALLOS:\n- ' + failures.join('\n- ') : '\nTODO OK');
  app.exit(failures.length ? 1 : 0);
});
