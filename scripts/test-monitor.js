// Prueba del vigilante (electron/monitor.js) contra un servidor real con PM2: avisos de inicio, detención, reinicio,
// silenciado de acciones propias y pérdida/recuperación de la conexión.
// Uso: ARKPM_TEST_PORT=22 ARKPM_TEST_USER=u ARKPM_TEST_PASS=p ARKPM_TEST_APP=miapp node scripts/test-monitor.js
const assert = require('assert');
const { SshManager } = require('../electron/ssh');
const { Monitor, diffApps, groupApps } = require('../electron/monitor');

// --- lógica pura
{
  const A = (status, restarts = 0) => ({ status, restarts });
  const k = (p, n) => diffApps(p, n).events.map((e) => e.kind + ':' + e.name).join(',');
  assert.strictEqual(k({ a: A('online') }, { a: A('stopped') }), 'stopped:a');
  assert.strictEqual(k({ a: A('stopped') }, { a: A('online') }), 'started:a');
  assert.strictEqual(k({ a: A('online') }, { a: A('errored') }), 'errored:a');
  assert.strictEqual(k({ a: A('online', 1) }, { a: A('online', 3) }), 'restart:a');
  assert.strictEqual(k({ a: A('online') }, { a: A('partial') }), 'errored:a');
  assert.strictEqual(k({ a: A('online') }, { a: A('launching') }), '');
  assert.strictEqual(diffApps({ a: A('online') }, { a: A('launching') }).merged.a.status, 'online');
  assert.strictEqual(k({}, { b: A('online') }), 'started:b');
  assert.strictEqual(k({ a: A('online') }, {}), 'stopped:a');
  assert.strictEqual(k({ a: A('online', 2) }, { a: A('online', 2) }), '');
  const g = groupApps([{ name: 'x', pm2_env: { status: 'online', restart_time: 1 } }, { name: 'x', pm2_env: { status: 'stopped', restart_time: 2 } }]);
  assert.deepStrictEqual(g.x, { status: 'partial', restarts: 3 });
  console.log('✔ lógica de eventos (diffApps / groupApps)');
}

const o = { host: '127.0.0.1', port: +(process.env.ARKPM_TEST_PORT || 22), username: process.env.ARKPM_TEST_USER, password: process.env.ARKPM_TEST_PASS };
const APP = process.env.ARKPM_TEST_APP || 'miapp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ssh = new SshManager();
  const fp = (await ssh.connect(o)).fingerprint;
  const ctl = await ssh.connect({ ...o, expectedFingerprint: fp });
  const run = (c) => ssh.exec(ctl.sessionId, `bash -lc ${JSON.stringify(c)}`, { timeoutMs: 60000 });
  await run(`mkdir -p ~/${APP} && cd ~/${APP} && { [ -f server.js ] || echo 'setInterval(()=>console.log("t"),1000)' > server.js; } && { pm2 describe ${APP} >/dev/null 2>&1 || pm2 start server.js --name ${APP}; } && pm2 restart ${APP}`);

  const got = [];
  const mon = new Monitor({ ssh: new SshManager(), notify: (n) => got.push(n), loadSecret: async () => ({ password: o.password }), log: (...a) => process.env.DEBUG && console.log('  [monitor]', ...a) });
  const cfg = { enabled: true, background: true, interval: 1, events: { started: true, stopped: true, errored: true, connection: true },
    servers: [{ id: 's1', name: 'Prod', host: o.host, port: o.port, username: o.username, auth: 'password', pm2Cmd: 'pm2', shellInit: '', fingerprint: fp, notify: true }] };
  const waitFor = async (re, what, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (got.some((n) => re.test(n.body))) return; await sleep(200); } throw new Error('No llegó el aviso: ' + what + ' | recibidos: ' + JSON.stringify(got.map((g) => g.body))); };

  mon.configure(cfg);
  await sleep(3000);
  assert.strictEqual(got.length, 0, 'la primera lectura es solo línea base: ' + JSON.stringify(got));
  assert.strictEqual(mon.status()[0].state, 'up');
  console.log('✔ línea base sin avisos');

  await run(`pm2 stop ${APP}`); await waitFor(/se detuvo/, 'detención'); console.log('✔ aviso: servicio detenido');
  await run(`pm2 start ${APP}`); await waitFor(/se inició/, 'inicio'); console.log('✔ aviso: servicio iniciado');

  got.length = 0; mon.mute('s1', APP, 8000);
  await run(`pm2 stop ${APP}`); await sleep(3000); await run(`pm2 start ${APP}`); await sleep(3000);
  assert.strictEqual(got.length, 0, 'acciones propias silenciadas: ' + JSON.stringify(got)); console.log('✔ las acciones hechas desde la app no generan aviso');
  await sleep(6000);

  got.length = 0;
  await run(`pm2 restart ${APP}`); await waitFor(/reinici/, 'reinicio inesperado'); console.log('✔ aviso: reinicio inesperado');

  await run(`pm2 stop ${APP}`); await sleep(1500); got.length = 0;
  // el corte se lanza desacoplado: así no mata antes su propia sesión y alcanza también a la del vigilante
  await run(`setsid -f bash -c 'sleep 0.5; pkill -f "[s]shd: ${o.username}"' </dev/null >/dev/null 2>&1; echo ok`);
  await sleep(1500);
  await sleep(300); if (process.env.DEBUG) console.log('  estado tras cortar:', JSON.stringify(mon.status()), 'recibidos', got.length);
  // el sshd se mantiene escuchando: el vigilante detecta la caída y se reconecta
  await waitFor(/perdió la conexión|Conexión restablecida/, 'pérdida de conexión', 30000);
  console.log('✔ aviso de conexión:', got.map((g) => g.body).join(' → '));
  await waitFor(/restablecida/, 'conexión restablecida', 30000); console.log('✔ aviso: conexión restablecida');

  const bad = new Monitor({ ssh: new SshManager(), notify: (n) => got.push(n), loadSecret: async () => ({ password: 'incorrecta' }) });
  got.length = 0; bad.configure({ ...cfg, servers: [{ ...cfg.servers[0] }] }); await sleep(2500);
  assert(got.some((n) => /No se pudo iniciar sesión/.test(n.body)) && bad.status()[0].state === 'skipped'); bad.shutdown(); console.log('✔ contraseña incorrecta: un solo aviso y el servidor queda en pausa');

  mon.shutdown();
  const c2 = await ssh.connect({ ...o, expectedFingerprint: fp });
  await ssh.exec(c2.sessionId, `bash -lc ${JSON.stringify('pm2 start ' + APP)}`).catch(() => {});
  console.log('TODO OK'); process.exit(0);
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
