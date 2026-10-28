// Prueba de extremo a extremo de la app de escritorio con un servidor SSH real y capturas de pantalla.
// Uso (Linux sin pantalla): xvfb-run -a node_modules/.bin/electron --no-sandbox --disable-gpu scripts/e2e-electron.js
// Variables: ARKPM_TEST_PORT, ARKPM_TEST_USER, ARKPM_TEST_PASS, ARKPM_E2E_OUT (carpeta de capturas)
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const OUT = process.env.ARKPM_E2E_OUT || '/tmp/arkpm-shots';
const DL = '/tmp/arkpm-e2e-downloads', ZIP = '/tmp/arkpm-e2e-release.zip';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
const tmp = fs.mkdtempSync('/tmp/arkpm-rel-'); fs.mkdirSync(path.join(tmp, 'app-v9'));
fs.writeFileSync(path.join(tmp, 'app-v9/VERSION'), 'v9\n'); fs.writeFileSync(path.join(tmp, 'app-v9/server.js'), 'setInterval(()=>console.log("v9 corriendo"),1000)\n');
fs.rmSync(ZIP, { force: true }); execFileSync('python3', ['-c', `import shutil;shutil.make_archive('${ZIP.replace('.zip', '')}','zip','${tmp}','app-v9')`]);

execFileSync('su', ['-', 'deploy', '-c', `mkdir -p ~/e2e-svc && echo 'setInterval(()=>console.log("nuevo servicio"),1000)' > ~/e2e-svc/svc.js; pm2 delete e2e-nuevo >/dev/null 2>&1; cd ~/miapp && echo 'let n=0; setInterval(()=>{ console.log("tick "+(++n)); if(n%3==0) console.error("aviso "+n); }, 1000);' > server.js; pm2 restart miapp >/dev/null 2>&1; true`]);
dialog.showOpenDialog = async (_w, o) => ((o.properties || []).includes('openDirectory') ? { canceled: false, filePaths: [DL] } : { canceled: false, filePaths: [ZIP] });
require('../electron/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
app.whenReady().then(async () => {
  await sleep(500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setMinimumSize(300, 300);
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (n) => { await sleep(350); fs.writeFileSync(path.join(OUT, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('📸', n); };
  const safe = async (code) => { const r = await js(`(() => { try { return (${code}); } catch (e) { return 'ERR:' + e.message; } })()`); if (typeof r === 'string' && r.startsWith('ERR:')) throw new Error(r.slice(4)); return r; };
  const click = (t, ctx = '') => safe(`(() => { const root = ${ctx ? `document.querySelector(${JSON.stringify(ctx)})` : 'document'}; const els = [...root.querySelectorAll('button, .item, .seg button, .tabs button, .bottom button, label.btn, .row-e')].filter(e => e.offsetParent !== null && e.textContent.trim().includes(${JSON.stringify(t)})); if (!els.length) throw new Error('no se encontró: ' + ${JSON.stringify(t)}); els[0].click(); return true; })()`);
  const type = (sel, v) => safe(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('sin campo ' + ${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const text = () => js('document.body.innerText');
  const expect = async (frag, what) => { for (let i = 0; i < 60; i++) { if ((await text()).includes(frag)) { console.log('✔', what); return; } await sleep(250); } failures.push(what); console.log('✖', what, '— no apareció:', frag); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { failures.push(name + ': ' + e.message); console.log('✖', name, e.message); await shot('error-' + name.replace(/\W+/g, '-')); } };

  win.setSize(1280, 800); await sleep(500);
  await shot('01-vacio');
  await step('alta-servidor', async () => {
    await click('Agregar servidor'); await sleep(300);
    await type('.modal input[placeholder="Producción, VPS cliente…"]', 'Servidor de prueba');
    await type('.modal input[placeholder="203.0.113.10"]', '127.0.0.1');
    await type('.modal input[type=number]', process.env.ARKPM_TEST_PORT || '2222');
    await type('.modal input[placeholder="ubuntu"]', process.env.ARKPM_TEST_USER || 'deploy');
    await js(`(() => { const c = document.querySelector('.modal input[type=checkbox]'); if (c.checked) c.click(); })()`);
    await shot('02-editor');
    await click('Guardar', '.modal');
    await expect('Servidor de prueba', 'servidor guardado');
  });
  await step('conectar', async () => {
    await click('Servidor de prueba'); await expect('Verificar servidor', 'pide confirmar la huella');
    await shot('03-huella'); await click('Confiar y conectar');
    await expect('Contraseña de', 'pide la contraseña'); await type('.modal input[type=password]', process.env.ARKPM_TEST_PASS || 'Test1234'); await click('Conectar', '.modal');
    await expect('Aún no agregaste apps', 'conectado, sin apps agregadas');
  });
  await step('info-servidor', async () => {
    await expect('Sistema y hardware', 'ficha del servidor (SO, hardware)'); await expect('Ubuntu', 'versión de Ubuntu'); await shot('03b-info-servidor');
  });
  await step('servicio-nuevo', async () => {
    await click('App'); await expect('Crear servicio nuevo', 'modal con opción de servicio nuevo'); await click('Crear servicio nuevo', '.modal');
    await type('.modal input[placeholder="mi-api"]', 'e2e-nuevo'); await type('.modal input[placeholder="server.js"]', 'svc.js');
    await type('.modal input[placeholder="/home/usuario/mi-api"]', '/home/deploy/e2e-svc');
    await shot('03c-servicio-nuevo'); await click('Crear e iniciar', '.modal');
    await expect('Servicio «e2e-nuevo» creado y en línea', 'servicio nuevo creado en PM2'); await expect('Tiempo activa', 'abre el detalle del servicio nuevo'); await shot('03d-servicio-creado');
    await click('Quitar de esta lista').catch(() => {});
  });
  await step('volver', async () => {
    await js(`(() => { const b = [...document.querySelectorAll('.item')].find(e => e.textContent.includes('Servidor de prueba')); b && b.click(); })()`); await sleep(500);
  });
  await step('agregar-app', async () => {
    await click('App'); await expect('Ya está en PM2', 'lista de apps de PM2'); await click('Ya está en PM2', '.modal'); await shot('04-agregar-app');
    await expect('miapp', 'miapp aparece en PM2'); await click('miapp', '.modal'); await expect('Tiempo activa', 'detalle de la app (estado)'); await sleep(700);
    await shot('05-estado');
  });
  await step('acciones-pm2', async () => {
    await click('Reiniciar'); await expect('Reiniciada: miapp', 'reinicio por PM2');
    await click('Detener'); await click('Detener', '.modal'); await expect('Detenida: miapp', 'detener'); await shot('06-detenida');
    await click('Iniciar'); await expect('Iniciada: miapp', 'iniciar');
  });
  await step('logs', async () => {
    await click('Logs', '.tabs'); await expect('tick', 'logs en vivo'); await sleep(2500); await shot('07-logs');
    await click('Errores'); await expect('aviso', 'logs de errores');
  });
  await step('archivos', async () => {
    await click('Archivos', '.tabs'); await expect('server.js', 'explorador lista archivos'); await shot('08-archivos');
    await click('server.js'); await expect('rw-r--r--', 'visor de texto'); await shot('09-visor'); await click('', '.modal header');
  });
  await step('backup', async () => {
    await click('Backup', '.tabs'); await expect('Qué incluir', 'pestaña backup'); await sleep(800);
    await click('Vista previa'); await expect('archivos ·', 'vista previa'); await shot('10-backup');
    await click('Crear backup ahora'); await expect('Backup guardado', 'backup creado y descargado'); await shot('11-backup-hecho');
    const f = fs.readdirSync(DL); console.log('   descargas:', f);
    if (!f.some((x) => x.endsWith('.tar.gz'))) throw new Error('no se descargó el backup');
  });
  await step('deploy', async () => {
    await click('Deploy', '.tabs'); await expect('Qué subir', 'pestaña deploy');
    await click('Elegir…'); await expect('arkpm-e2e-release.zip', 'archivo elegido');
    await click('Deployar ahora'); await expect('Confirmar deploy', 'pide confirmación'); await shot('12-confirmar-deploy');
    await click('Deployar', '.modal footer'); await expect('Todo salió bien', 'deploy completado'); await shot('13-deploy-ok');
  });
  await step('estado-final', async () => { await click('Estado', '.tabs'); await sleep(7000); await expect('En línea', 'app en línea tras el deploy'); });
  await step('ajustes', async () => {
    await js(`document.querySelector('button[aria-label="Notificaciones y segundo plano"]').click()`); await expect('Seguir vigilando en segundo plano', 'abre ajustes');
    await js(`document.querySelector('.modal input[type=checkbox]').click()`); await sleep(500);
    await js(`[...document.querySelectorAll('.modal input[type=checkbox]')].filter(c => !c.disabled && !c.checked)[0]; true`);
    await expect('Servidores vigilados', 'lista de servidores vigilados'); await shot('03e-ajustes');
    await js(`document.querySelector('.modal footer button').click()`);
  });
  win.setSize(900, 700); await sleep(600); await shot('14-tableta');
  win.setSize(400, 820); await sleep(700); await shot('15-telefono-detalle');
  await js(`(() => { const b = document.querySelector('.dh button'); b && b.click(); })()`); await sleep(500); await shot('16-telefono-apps');
  await step('segundo-plano', async () => {
    win.setSize(1100, 760); await sleep(300);
    await js(`window.electronAPI.monitorConfigure({ enabled: true, background: true, interval: 30, events: {}, servers: [] })`); await sleep(500);
    win.close(); await sleep(800);
    if (win.isDestroyed() || win.isVisible()) throw new Error('con «segundo plano» activo, cerrar la ventana debe ocultarla y no salir');
    console.log('✔ cerrar la ventana con segundo plano activo la oculta (la app sigue viva)');
    win.show(); await sleep(300);
    await js(`window.electronAPI.monitorConfigure({ enabled: true, background: false, interval: 30, events: {}, servers: [] })`);
  });
  console.log(failures.length ? '\nFALLOS:\n- ' + failures.join('\n- ') : '\nTODO OK');
  app.exit(failures.length ? 1 : 0);
});
