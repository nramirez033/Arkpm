// Prueba de integración de electron/ssh.js contra un servidor SSH real.
// Uso: ARKPM_TEST_HOST=127.0.0.1 ARKPM_TEST_PORT=22 ARKPM_TEST_USER=u ARKPM_TEST_PASS=p node scripts/test-ssh-layer.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { SshManager, walkLocal } = require('../electron/ssh');

const o = { host: process.env.ARKPM_TEST_HOST || '127.0.0.1', port: +(process.env.ARKPM_TEST_PORT || 22), username: process.env.ARKPM_TEST_USER, password: process.env.ARKPM_TEST_PASS };
(async () => {
  const events = [];
  const m = new SshManager((...a) => events.push(a));
  let r = await m.connect({ ...o, password: 'mala' });
  assert(!r.ok && (r.code === 'HOSTKEY_UNKNOWN') && r.fingerprint.startsWith('SHA256:'), 'huella desconocida: ' + JSON.stringify(r));
  const fp = r.fingerprint;
  r = await m.connect({ ...o, expectedFingerprint: 'SHA256:otra' });
  assert(!r.ok && r.code === 'HOSTKEY_CHANGED', 'huella cambiada');
  r = await m.connect({ ...o, password: 'mala', expectedFingerprint: fp });
  assert(!r.ok && r.code === 'AUTH_FAILED', 'credenciales malas: ' + JSON.stringify(r));
  r = await m.connect({ ...o, expectedFingerprint: fp });
  assert(r.ok, JSON.stringify(r));
  const sid = r.sessionId;
  console.log('✔ conexión + huella');

  const e = await m.exec(sid, 'echo hola; echo err >&2; exit 3');
  assert(e.code === 3 && e.stdout.trim() === 'hola' && e.stderr.trim() === 'err');
  console.log('✔ exec');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpm-'));
  fs.mkdirSync(path.join(tmp, 'src/sub'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src/a.js'), 'a'.repeat(1000)); fs.writeFileSync(path.join(tmp, 'src/sub/b.txt'), 'b');
  fs.writeFileSync(path.join(tmp, 'vacio.txt'), ''); fs.writeFileSync(path.join(tmp, 'node_modules/x/i.js'), 'x'); fs.writeFileSync(path.join(tmp, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  const files = await walkLocal(tmp, ['node_modules']);
  assert.deepStrictEqual(files.map((f) => f.path).sort(), ['big.bin', 'src/a.js', 'src/sub/b.txt', 'vacio.txt']);
  const home = (await m.exec(sid, 'echo $HOME')).stdout.trim();
  const dest = home + '/arkpm-test-' + Date.now();
  await m.uploadMany(sid, 'j1', files.map((f) => ({ local: path.join(tmp, f.path), remote: dest + '/' + f.path, size: f.size })));
  const ls = await m.exec(sid, `cd ${dest} && find . -type f | sort && wc -c < big.bin`);
  assert(ls.stdout.includes('./src/sub/b.txt') && ls.stdout.includes('./vacio.txt') && !ls.stdout.includes('node_modules') && ls.stdout.trim().endsWith('3145728'), ls.stdout);
  assert(events.some((x) => x[0] === 'ssh:progress' && x[1] === 'j1' && x[2] === x[3]), 'progreso final');
  console.log('✔ subida de carpeta con reglas, archivos vacíos y 3 MB');

  const entries = await m.list(sid, dest);
  assert(entries.find((x) => x.name === 'src').isDir && !entries.find((x) => x.name === 'big.bin').isDir);
  await m.exec(sid, `ln -s src ${dest}/enlace`);
  assert((await m.list(sid, dest)).find((x) => x.name === 'enlace').isDir, 'symlink a carpeta');
  console.log('✔ listado SFTP (incluye enlaces)');

  await m.writeFile(sid, dest + '/nota.txt', Buffer.from('línea ñ\n').toString('base64'));
  const rf = await m.readFile(sid, dest + '/nota.txt');
  assert(Buffer.from(rf.data, 'base64').toString() === 'línea ñ\n' && !rf.truncated);
  const rt = await m.readFile(sid, dest + '/big.bin', 1000);
  assert(rt.truncated && Buffer.from(rt.data, 'base64').length === 1000);
  console.log('✔ leer/escribir/truncar');

  const out = path.join(tmp, 'descargas');
  const dl = await m.download(sid, 'j2', dest + '/big.bin', out, 'big.bin');
  const dl2 = await m.download(sid, 'j3', dest + '/big.bin', out, 'big.bin');
  assert(fs.statSync(dl.path).size === 3145728 && dl2.path.endsWith('big (1).bin'));
  console.log('✔ descarga (y nombre duplicado)');

  const chunks = [];
  const off = (() => { const h = (x) => { if (x[0] === 'ssh:stream') chunks.push(x); }; const i = events.length; return () => events.slice(i).forEach(h); })();
  const stid = await m.streamStart(sid, 'for i in 1 2 3; do echo línea $i; sleep 0.3; done', { pty: true });
  await new Promise((res) => { const t = setInterval(() => { if (events.some((x) => x[0] === 'ssh:stream' && x[1] === stid && x[2] === 'close')) { clearInterval(t); res(); } }, 50); });
  off();
  const txt = events.filter((x) => x[0] === 'ssh:stream' && x[1] === stid && x[2] === 'data').map((x) => x[3]).join('');
  assert(/línea 1/.test(txt) && /línea 3/.test(txt), txt);
  const st2 = await m.streamStart(sid, 'tail -f /dev/null', { pty: true });
  m.streamStop(st2);
  await new Promise((res) => setTimeout(res, 400));
  assert(!m.streams.has(st2));
  console.log('✔ stream (pty) y parada');

  const big2 = Array.from({ length: 6 }, (_, i) => ({ local: path.join(tmp, 'big.bin'), remote: `${dest}/c${i}.bin`, size: 3 * 1024 * 1024 }));
  const up = m.uploadMany(sid, 'j4', big2);
  setTimeout(() => m.cancelJob('j4'), 150);
  let cancelled = false; try { await up; } catch (x) { cancelled = /Cancelado/.test(x.message); }
  console.log(cancelled ? '✔ cancelación de subida' : '• la subida terminó antes de cancelar (red local muy rápida)');

  await m.exec(sid, `rm -rf ${dest}`);
  m.disconnect(sid);
  await new Promise((res) => setTimeout(res, 200));
  assert(events.some((x) => x[0] === 'ssh:closed'));
  console.log('✔ desconexión\nTODO OK');
  process.exit(0);
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
