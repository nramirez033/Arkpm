// Prueba de la pantalla de administración de nginx (usuario con sudo que pide contraseña).
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const OUT = process.env.ARKPM_E2E_OUT || '/tmp/arkpm-shots5';
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




  const { execSync } = require('child_process');
  const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
  const curl = (host) => sh(`curl -s -m 5 -H 'Host: ${host}' http://127.0.0.1/`);
  const SUDOPW = process.env.ARKPM_TEST_PASS || 'Test1234';
  sh('mkdir -p /var/www/arkpm-ui && echo "SITIO-UI-1" > /var/www/arkpm-ui/index.html && chmod -R a+rX /var/www/arkpm-ui; rm -f /etc/nginx/sites-enabled/ui.local /etc/nginx/sites-available/ui.local; nginx -s reload');
  const pwDialog = async () => { await expect('Contraseña de sudo', 'pide la contraseña de sudo'); await type('app-dialog-host .modal input[type=password]', SUDOPW); await click('Continuar', 'app-dialog-host .modal'); };
  const idle = async () => { for (let i = 0; i < 80; i++) { if (!(await safe(`!!document.querySelector('app-nginx .bar.ind')`)) && !(await safe(`!!document.querySelector('.modal footer button[disabled]')`))) return; await sleep(200); } };

  await step('abrir-nginx', async () => {
    await addServer('Servidor N', 'deploy'); await connect('Servidor N');
    await click('Nginx', '.infopane'); await expect('nginx/1.', 'versión de nginx'); await expect('Activo', 'estado: activo');
    await expect('sudo pide contraseña', 'indica que sudo pide contraseña'); await expect('nginx.conf (configuración principal)', 'archivo principal'); await expect('default', 'sitio default listado');
    await shot('01-nginx');
  });
  await step('crear-sitio', async () => {
    await click('Nuevo sitio', 'app-nginx'); await expect('Dominio(s)', 'formulario');
    await type('.modal input[placeholder^="midominio"]', 'ui.local www.ui.local'); await click('Sitio estático', '.modal');
    await type('.modal input[placeholder="/var/www/mi-sitio"]', '/var/www/arkpm-ui'); await shot('02-nuevo-sitio');
    await click('Crear sitio', '.modal'); await pwDialog(); await expect('Sitio creado y habilitado', 'sitio creado y habilitado'); await sleep(800);
    check(/SITIO-UI-1/.test(curl('ui.local')) && /SITIO-UI-1/.test(curl('www.ui.local')), 'el sitio nuevo responde en sus dos dominios');
    await expect('www.ui.local', 'aparece en la lista con sus dominios'); await expect('Sitio estático', 'tipo detectado: estático'); await shot('03-lista');
  });
  await step('editar-con-error', async () => {
    await safe(`[...document.querySelectorAll('app-nginx .site')].find(c => c.textContent.includes('ui.local')).querySelector('button[aria-label="Editar archivo"]').click()`); await expect('Guardar y recargar', 'editor abierto');
    const t = await safe(`document.querySelector('.modal textarea').value`);
    await type('.modal textarea', t.replace('index index.html index.htm;', 'index index.html;\n    directiva_inexistente si;'));
    await click('Guardar y recargar', '.modal'); await expect('rechazó la configuración', 'un error de nginx se muestra y se revierte'); await shot('04-error');
    check(!fs.readFileSync('/etc/nginx/sites-available/ui.local', 'utf8').includes('directiva_inexistente'), 'el archivo del servidor no quedó roto');
  });
  await step('editar-bien', async () => {
    const t = await safe(`document.querySelector('.modal textarea').value`);
    await type('.modal textarea', t.replace('directiva_inexistente si;', 'add_header X-Ui "ok" always;'));
    await click('Guardar y recargar', '.modal'); await expect('Guardado y recargado', 'guardado y recargado (sin volver a pedir sudo)'); await sleep(800);
    check(/x-ui: ok/i.test(sh(`curl -s -I -m 5 -H 'Host: ui.local' http://127.0.0.1/`)), 'el cambio ya está activo en nginx');
  });
  await step('deshabilitar-habilitar', async () => {
    const card = `[...document.querySelectorAll('app-nginx .site')].find(c => c.textContent.includes('ui.local'))`;
    await safe(`${card}.querySelector('button[aria-label="Deshabilitar"]').click()`); await expect('Deshabilitar sitio', 'confirma'); await click('Deshabilitar', 'app-dialog-host .modal footer'); await expect('Sitio deshabilitado', 'deshabilitado'); await sleep(800);
    check(!/SITIO-UI-1/.test(curl('ui.local')), 'ya no responde'); await expect('Deshabilitado', 'la lista lo marca como deshabilitado');
    await safe(`${card}.querySelector('button[aria-label="Habilitar"]').click()`); await expect('Sitio habilitado', 'habilitado'); await sleep(800);
    check(/SITIO-UI-1/.test(curl('ui.local')), 'responde otra vez');
  });
  await step('control', async () => {
    await safe(`document.querySelector('app-nginx button[aria-label="Probar configuración"]').click()`); await expect('configuración es válida', 'probar configuración');
    await safe(`document.querySelector('app-nginx button[aria-label="Recargar configuración"]').click()`); await expect('Configuración recargada', 'recargar');
    await safe(`document.querySelector('app-nginx button[aria-label="Detener nginx"]').click()`); await click('Detener', 'app-dialog-host .modal footer'); await expect('nginx detenido', 'detener'); await expect('Detenido', 'estado: detenido'); await shot('05-detenido');
    await safe(`document.querySelector('app-nginx button[aria-label="Iniciar nginx"]').click()`); await expect('nginx iniciado', 'iniciar'); await expect('Activo', 'estado: activo otra vez');
  });
  await step('logs', async () => {
    await safe(`document.querySelector('app-nginx button[aria-label="Ver logs"]').click()`); await expect('Logs de nginx', 'modal de logs'); await sleep(1500); await click('Accesos', '.modal'); await sleep(1200); await shot('06-logs');
    await safe(`document.querySelector('.modal header button').click()`);
  });
  await step('eliminar', async () => {
    await safe(`[...document.querySelectorAll('app-nginx .site')].find(c => c.textContent.includes('ui.local')).querySelector('button[aria-label="Eliminar sitio"]').click()`); await expect('Eliminar sitio', 'confirma'); await click('Eliminar', 'app-dialog-host .modal footer'); await expect('Sitio eliminado', 'eliminado'); await sleep(800);
    check(!fs.existsSync('/etc/nginx/sites-available/ui.local') && !fs.existsSync('/etc/nginx/sites-enabled/ui.local') && !/SITIO-UI-1/.test(curl('ui.local')), 'archivo y enlace eliminados y deja de responder');
    check(fs.readdirSync('/etc/nginx/arkpm-backups').some((f) => f.startsWith('ui.local.')), 'quedó copia de seguridad');
  });
  sh('rm -rf /var/www/arkpm-ui');
  console.log(failures.length ? '\nFALLOS:\n- ' + failures.join('\n- ') : '\nTODO OK');
  app.exit(failures.length ? 1 : 0);
});
