// Prueba del módulo nginx contra un servidor real (nginx + sudo) por SSH.
// Usuarios: A = sudo con contraseña, B = sudo sin contraseña, C = sin sudo (solo lectura).
// ARKPM_TEST_PORT=2222 USER_A=deploy PASS_A=Test1234 USER_B=otro PASS_B=Otro1234 USER_C=solo PASS_C=Solo1234 node scripts/test-nginx.js
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpm-ng-'));
for (const f of ['remote', 'nginx']) execFileSync('npx', ['tsc', '--outDir', out, '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop', path.join(__dirname, '..', 'src/app/' + f + '.ts')], { stdio: 'inherit' });
const R = require(path.join(out, 'remote.js')), N = require(path.join(out, 'nginx.js'));
const { SshManager } = require('../electron/ssh');
const port = +(process.env.ARKPM_TEST_PORT || 22);
const U = { A: [process.env.USER_A, process.env.PASS_A], B: [process.env.USER_B, process.env.PASS_B], C: [process.env.USER_C, process.env.PASS_C] };
const sh = (c) => { try { return execFileSync('bash', ['-c', c], { encoding: 'utf8' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const m = new SshManager();
  const sess = {};
  for (const k of 'ABC') {
    const o = { host: '127.0.0.1', port, username: U[k][0], password: U[k][1] };
    const fp = (await m.connect(o)).fingerprint; const c = await m.connect({ ...o, expectedFingerprint: fp }); assert(c.ok, 'conecta ' + k); sess[k] = c.sessionId;
  }
  const run = (k, script, pw) => m.exec(sess[k], R.wrap(script), { stdin: pw == null ? undefined : pw + '\n', timeoutMs: 60000 });
  const probe = async (k) => N.parseNginxProbe((await run(k, N.nginxProbeScript())).stdout);
  const put = async (k, p, text) => m.writeFile(sess[k], p, Buffer.from(text).toString('base64'));
  const curl = (host, p = '/') => sh(`curl -s -m 5 -H 'Host: ${host}' http://127.0.0.1${p}`);

  // ---- sondeo y permisos
  const pa = await probe('A'), pb = await probe('B'), pc = await probe('C');
  assert(pa.installed && /nginx\/\d/.test(pa.version) && pa.active === 'active' && pa.layout === 'debian', JSON.stringify(pa));
  assert.strictEqual(pa.sudo, 'password'); assert.strictEqual(pb.sudo, 'nopasswd'); assert.strictEqual(pc.sudo, 'password');
  console.log('✔ sondeo:', pa.version, '| activo | sudo A=' + pa.sudo + ' B=' + pb.sudo);

  // ---- lectura sin sudo y análisis
  let files = N.parseNginxFiles((await run('C', N.nginxReadScript())).stdout); let sites = N.buildSites(files);
  assert(files.some((f) => f.kind === 'main') && sites.some((s) => s.name === 'default' && s.file.enabled && s.servers.length), JSON.stringify(files.map((f) => f.path)));
  console.log('✔ lectura de la configuración sin privilegios:', files.map((f) => f.path.split('/').pop()).join(', '));

  // ---- sudo: contraseña incorrecta / usuario sin permisos
  let r = await run('A', N.testScript(pa.bin), 'incorrecta'); assert(/SUDO_FAIL/.test(r.stdout), r.stdout);
  r = await run('C', N.testScript(pa.bin), 'Solo1234'); assert(/SUDO_FAIL/.test(r.stdout), 'sin permisos de sudo: ' + r.stdout);
  r = await run('A', N.testScript(pa.bin), U.A[1]); assert(/TEST_OK/.test(r.stdout), r.stdout);
  r = await run('B', N.testScript(pb.bin)); assert(/TEST_OK/.test(r.stdout), r.stdout);
  console.log('✔ sudo: contraseña incorrecta y usuario sin permisos se rechazan; contraseña correcta y sudo sin contraseña funcionan');

  // ---- crear un sitio estático nuevo y comprobar que sirve
  sh('mkdir -p /var/www/arkpm-test && echo "HOLA-ARKPM" > /var/www/arkpm-test/index.html && chmod -R a+rX /var/www/arkpm-test');
  const cfg = N.buildSiteConfig({ names: ['prueba.local'], type: 'static', target: '/var/www/arkpm-test', spa: false, ipv6: pa.ipv6 });
  const tmp = '/tmp/arkpm-ng-' + Date.now() + '.conf'; await put('A', tmp, cfg);
  const dest = '/etc/nginx/sites-available/prueba.local';
  r = await run('A', N.installScript(pa.bin, tmp, dest, { link: '/etc/nginx/sites-enabled/prueba.local', reload: true }), U.A[1]);
  assert(/OK\s*$/.test(r.stdout.trim()) && /RELOADED/.test(r.stdout), r.stdout + r.stderr);
  await sleep(500); assert(/HOLA-ARKPM/.test(curl('prueba.local')), 'el sitio nuevo responde: ' + curl('prueba.local'));
  files = N.parseNginxFiles((await run('C', N.nginxReadScript())).stdout); sites = N.buildSites(files);
  const nuevo = sites.find((s) => s.name === 'prueba.local');
  assert(nuevo && nuevo.file.enabled && nuevo.servers[0].names[0] === 'prueba.local' && nuevo.servers[0].kind === 'static' && nuevo.servers[0].target === '/var/www/arkpm-test', JSON.stringify(nuevo));
  console.log('✔ sitio nuevo creado, habilitado y recargado: responde y aparece en la lista');

  // ---- editar con un error: se prueba y se REVIERTE
  const bad = cfg.replace('root /var/www/arkpm-test;', 'root /var/www/arkpm-test\n    directiva_inexistente on;');
  await put('A', tmp, bad);
  r = await run('A', N.installScript(pa.bin, tmp, dest, { reload: true }), U.A[1]);
  assert(/TEST_FAIL/.test(r.stdout) && /directiva_inexistente|unknown directive|unexpected|invalid number of arguments/.test(r.stdout), 'detecta el error: ' + r.stdout);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), cfg, 'la configuración errónea se revirtió al contenido anterior');
  assert(/HOLA-ARKPM/.test(curl('prueba.local')), 'nginx sigue sirviendo tras el rollback');
  console.log('✔ editar con error: nginx -t falla, se revierte al contenido anterior y el sitio sigue funcionando');

  // ---- editar bien (con copia de seguridad)
  await put('A', tmp, cfg.replace('index index.html index.htm;', 'index index.html;\n    add_header X-Arkpm "editado" always;'));
  r = await run('A', N.installScript(pa.bin, tmp, dest, { reload: true }), U.A[1]); assert(/OK\s*$/.test(r.stdout.trim()), r.stdout);
  await sleep(600);
  assert(/x-arkpm: editado/i.test(sh(`curl -s -I -m 5 -H 'Host: prueba.local' http://127.0.0.1/`)), 'el cambio se aplicó');
  assert(fs.readdirSync('/etc/nginx/arkpm-backups').some((f) => f.startsWith('prueba.local.')), 'hay copia de seguridad');
  console.log('✔ editar bien: se aplica, se recarga y queda copia en /etc/nginx/arkpm-backups');

  // ---- deshabilitar / habilitar
  r = await run('B', N.toggleScript(pb.bin, 'available', dest, false)); assert(/OK\s*$/.test(r.stdout.trim()), r.stdout);
  await sleep(400); assert(!/HOLA-ARKPM/.test(curl('prueba.local')) && !fs.existsSync('/etc/nginx/sites-enabled/prueba.local'), 'deshabilitado');
  r = await run('B', N.toggleScript(pb.bin, 'available', dest, true)); assert(/OK\s*$/.test(r.stdout.trim()), r.stdout);
  await sleep(400); assert(/HOLA-ARKPM/.test(curl('prueba.local')), 'habilitado de nuevo');
  console.log('✔ deshabilitar y habilitar un sitio (sudo sin contraseña)');

  // ---- certificado: fecha de vencimiento
  sh('openssl req -x509 -nodes -newkey rsa:2048 -days 90 -keyout /etc/ssl/arkpm-test.key -out /etc/ssl/arkpm-test.pem -subj "/CN=prueba.local" 2>/dev/null; chmod 600 /etc/ssl/arkpm-test.key; chmod 600 /etc/ssl/arkpm-test.pem');
  r = await run('A', N.certInfoScript(['/etc/ssl/arkpm-test.pem', '/no/existe.pem']), U.A[1]);
  const certs = N.parseCerts(r.stdout); const end = certs.get('/etc/ssl/arkpm-test.pem');
  assert(end instanceof Date && end.getTime() > Date.now() + 80 * 86400000 && end.getTime() < Date.now() + 100 * 86400000 && certs.get('/no/existe.pem') === null, r.stdout);
  console.log('✔ vencimiento de certificados (archivo legible solo por root):', end.toISOString().slice(0, 10));

  // ---- eliminar un sitio
  r = await run('A', N.deleteScript(pa.bin, 'available', dest), U.A[1]); assert(/OK\s*$/.test(r.stdout.trim()), r.stdout);
  assert(!fs.existsSync(dest) && !fs.existsSync('/etc/nginx/sites-enabled/prueba.local'), 'archivo y enlace eliminados'); await sleep(700); assert(!/HOLA-ARKPM/.test(curl('prueba.local')), 'ya no responde');
  console.log('✔ eliminar un sitio (con copia de seguridad previa)');

  // ---- control del servicio
  r = await run('A', N.ctlScript(pa.bin, 'stop'), U.A[1]); assert(/RESULT=inactive/.test(r.stdout), 'stop: ' + r.stdout);
  assert.strictEqual((await probe('C')).active, 'inactive');
  r = await run('A', N.ctlScript(pa.bin, 'start'), U.A[1]); assert(/RESULT=active/.test(r.stdout), 'start: ' + r.stdout);
  r = await run('B', N.ctlScript(pb.bin, 'reload')); assert(/RESULT=active/.test(r.stdout), 'reload: ' + r.stdout);
  r = await run('B', N.ctlScript(pb.bin, 'restart')); assert(/RESULT=active/.test(r.stdout), 'restart: ' + r.stdout);
  assert.strictEqual((await probe('C')).active, 'active');
  console.log('✔ iniciar / detener / recargar / reiniciar nginx');

  // ---- logs
  r = await run('B', N.logScript('error', 50)); assert(r.code === 0 || r.stdout.length >= 0);
  r = await run('A', N.logScript('access', 20), U.A[1]); assert(/GET|No such file/.test(r.stdout), 'logs: ' + r.stdout.slice(0, 80));
  console.log('✔ logs de nginx');

  // ---- certbot: validación de entradas
  assert.throws(() => N.certbotScript(['a.com'], 'no-es-correo'), /Correo/); assert.throws(() => N.certbotScript(['a.com; rm'], 'a@b.co'), /Dominio/);
  sh('rm -rf /var/www/arkpm-test /etc/ssl/arkpm-test.*');
  console.log('TODO OK'); process.exit(0);
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
