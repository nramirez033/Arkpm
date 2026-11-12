// Prueba de los últimos cambios: iconos sin texto, orden de pestañas, configuración que sobrevive al usuario y opciones de escritorio.
// xvfb-run -a node_modules/.bin/electron --no-sandbox --disable-gpu scripts/e2e-cambios.js
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const OUT = process.env.ARKPM_E2E_OUT || '/tmp/arkpm-shots2';
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

  await step('iconos-listas', async () => {
    await addServer('Servidor A', 'deploy');
    check(!(await safe(`document.querySelector('button[aria-label="Agregar servidor"]').textContent.trim()`)), 'lista de servidores: el botón agregar es solo icono');
    await connect('Servidor A');
    check(!(await safe(`document.querySelector('button[aria-label="Agregar app"]').textContent.trim()`)), 'lista de apps: el botón agregar es solo icono');
    await click('App'.length ? '' : '', '.nothing').catch(() => {});
  });
  await step('agregar-app', async () => {
    await safe(`document.querySelector('button[aria-label="Agregar app"]').click()`); await expect('miapp', 'miapp disponible'); await click('miapp', '.modal'); await expect('Tiempo activa', 'detalle de la app');
  });
  await step('pestanas-y-estado', async () => {
    const labels = await safe(`[...document.querySelectorAll('.tabs button')].map(b => b.textContent.trim())`);
    check(JSON.stringify(labels) === JSON.stringify(['Estado', 'Archivos', 'Deploy', 'Backup', 'Terminal', 'Notas', 'Logs']), 'orden de pestañas: ' + labels.join(' · ') + ' (Terminal y Notas antes de Logs, Logs al final)');
    const t = await safe(`[...document.querySelectorAll('app-status-tab .card:first-child button')].map(b => b.textContent.trim()).join('|')`);
    check(!/Iniciar|Detener|Reiniciar/.test(t), 'estado: iniciar/detener/reiniciar sin texto');
    const titles = await safe(`[...document.querySelectorAll('app-status-tab .card:first-child button[title]')].map(b => b.title).join(',')`);
    check(/Iniciar/.test(titles) && /Detener/.test(titles) && /Reiniciar/.test(titles), 'los iconos conservan su descripción (tooltip): ' + titles);
    await shot('01-estado-iconos');
  });
  await step('archivos-iconos', async () => {
    await click('Archivos', '.tabs'); await expect('server.js', 'explorador');
    await safe(`document.querySelector('.row-e input[type=checkbox]').click()`); await sleep(300);
    const t = await safe(`[...document.querySelectorAll('app-files-tab .selbar button')].map(b => b.textContent.trim()).join('|')`);
    check(!/Descargar|Eliminar/.test(t) && /seleccionado/.test(await safe(`document.querySelector('app-files-tab .selbar').textContent`)), 'archivos: descargar y eliminar sin texto en la barra de selección');
    await shot('02-archivos-iconos');
    await safe(`document.querySelector('app-files-tab .selbar button').click()`);
    await click('server.js', 'app-files-tab'); await sleep(600);
    const f = await safe(`[...document.querySelectorAll('.modal footer button')].map(b => b.textContent.trim()).join('|')`);
    check(!/Descargar|Eliminar/.test(f) && /Renombrar/.test(f), 'archivos: descargar y eliminar sin texto en el visor');
    await safe(`document.querySelector('.modal header button').click()`);
  });
  await step('config-deploy-backup', async () => {
    await click('Deploy', '.tabs'); await expect('Qué subir', 'pestaña deploy');
    await type('app-deploy-tab textarea[placeholder^=".env"]', '.env\nmi-carpeta-guardada\nuploads'); await sleep(400);
    await click('Backup', '.tabs'); await expect('Qué incluir', 'pestaña backup');
    await type('app-backup-tab textarea[placeholder^="node_modules"]', 'node_modules\n*.tmp-persistente'); await sleep(400);
  });
  await step('cambiar-usuario', async () => {
    // se edita el servidor y se cambia el usuario SSH
    await safe(`(() => { const b = [...document.querySelectorAll('app-server-list .item')].find(e => e.textContent.includes('Servidor A')).querySelector('button'); b.click(); })()`);
    await click('Editar'); await sleep(300);
    await type('.modal input[placeholder="ubuntu"]', 'otro-usuario'); await click('Guardar', '.modal'); await sleep(500);
    await click('miapp', 'app-app-list'); await sleep(500);
    await click('Deploy', '.tabs');
    const v = await safe(`document.querySelector('app-deploy-tab textarea[placeholder^=".env"]').value`);
    check(v.includes('mi-carpeta-guardada'), 'deploy: la configuración se conserva al cambiar el usuario');
    await click('Backup', '.tabs');
    check((await safe(`document.querySelector('app-backup-tab textarea[placeholder^="node_modules"]').value`)).includes('*.tmp-persistente'), 'backup: la configuración se conserva al cambiar el usuario');
  });
  await step('otro-perfil-mismo-servidor', async () => {
    // el mismo servidor con otro perfil (otro nombre): al agregar la app se reutiliza su configuración
    await addServer('Servidor B', 'deploy'); await connect('Servidor B');
    await safe(`document.querySelector('button[aria-label="Agregar app"]').click()`); await expect('miapp', 'miapp disponible en el perfil B'); await click('miapp', '.modal'); await expect('Tiempo activa', 'detalle');
    await click('Deploy', '.tabs');
    check((await safe(`document.querySelector('app-deploy-tab textarea[placeholder^=".env"]').value`)).includes('mi-carpeta-guardada'), 'deploy: un perfil nuevo del mismo servidor hereda la configuración guardada');
    await click('Backup', '.tabs');
    check((await safe(`document.querySelector('app-backup-tab textarea[placeholder^="node_modules"]').value`)).includes('*.tmp-persistente'), 'backup: un perfil nuevo del mismo servidor hereda la configuración guardada');
  });
  await step('quitar-y-volver', async () => {
    // se quita la app de la lista y se vuelve a agregar: la configuración sigue ahí
    await click('Estado', '.tabs'); await sleep(300);
    await safe(`document.querySelector('app-status-tab .card:first-child button[aria-label="Más acciones"]').click()`); await click('Quitar de esta lista'); await click('Quitar', '.modal footer'); await sleep(500);
    await safe(`document.querySelector('button[aria-label="Agregar app"]').click()`); await expect('miapp', 'miapp disponible otra vez'); await click('miapp', '.modal'); await expect('Tiempo activa', 'detalle');
    await click('Deploy', '.tabs');
    check((await safe(`document.querySelector('app-deploy-tab textarea[placeholder^=".env"]').value`)).includes('mi-carpeta-guardada'), 'deploy: la configuración sobrevive a quitar y volver a agregar la app');
  });
  await step('ajustes-escritorio', async () => {
    await safe(`document.querySelector('button[aria-label="Notificaciones y segundo plano"]').click()`); await expect('Inicio y ventana (escritorio)', 'ajustes de escritorio visibles');
    await expect('Iniciar en segundo plano', 'opción: iniciar en segundo plano'); await expect('Al minimizar, pasar a segundo plano', 'opción: minimizar a segundo plano');
    check((await text()).includes('Iniciar con Windows') || (await text()).includes('Iniciar con macOS'), 'opción: iniciar con Windows');
    await safe(`[...document.querySelectorAll('.modal input[type=checkbox]')].find(c => c.closest('label').textContent.includes('Al minimizar')).click()`); await sleep(500);
    await shot('03-ajustes-escritorio'); await safe(`document.querySelector('.modal footer button').click()`); await sleep(300);
    check(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'desktop.json'), 'utf8')).minimizeToBackground === true, 'la opción de minimizar queda guardada en el equipo');
    win.emit('minimize'); await sleep(900);   // sin gestor de ventanas (Xvfb) minimize() no emite el evento: se emite a mano
    check(!win.isVisible(), 'al minimizar con la opción activa, la ventana pasa a segundo plano (oculta)');
    win.show(); await sleep(300);
  });
  console.log(failures.length ? '\nFALLOS:\n- ' + failures.join('\n- ') : '\nTODO OK');
  app.exit(failures.length ? 1 : 0);
});
