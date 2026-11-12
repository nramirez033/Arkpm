// Prueba los scripts de shell de src/app/remote.ts (backup, deploy, restore, PM2) contra un servidor Ubuntu real por SSH.
// Uso: ARKPM_TEST_PORT=22 ARKPM_TEST_USER=u ARKPM_TEST_PASS=p ARKPM_TEST_APP=miapp node scripts/test-remote-scripts.js
// (el usuario debe tener PM2 y una app registrada con ese nombre, y su carpeta de trabajo escribible)
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpm-ts-'));
execFileSync('npx', ['tsc', '--outDir', out, '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop', path.join(__dirname, '..', 'src/app/remote.ts')], { stdio: 'inherit', shell: process.platform === 'win32' });
const R = require(path.join(out, 'remote.js'));
const { SshManager } = require('../electron/ssh');

const o = { host: process.env.ARKPM_TEST_HOST || '127.0.0.1', port: +(process.env.ARKPM_TEST_PORT || 22), username: process.env.ARKPM_TEST_USER, password: process.env.ARKPM_TEST_PASS };
const APP = process.env.ARKPM_TEST_APP || 'miapp';

(async () => {
  const m = new SshManager();
  const fp = (await m.connect(o)).fingerprint;
  const c = await m.connect({ ...o, expectedFingerprint: fp });
  assert(c.ok, JSON.stringify(c)); const sid = c.sessionId;
  const run = async (script, t = 120000) => m.exec(sid, R.wrap(script), { timeoutMs: t });
  const ok = async (script) => { const r = await run(script); assert.strictEqual(r.code, 0, `salida ${r.code}: ${r.stderr}${r.stdout}`); return r.stdout; };
  const home = (await run('echo $HOME')).stdout.trim();
  const ark = R.arkDir(home);

  // la app de prueba debe existir y estar registrada en PM2
  await ok(`mkdir -p "$HOME/${APP}" && cd "$HOME/${APP}" && { [ -f server.js ] || echo 'setInterval(()=>console.log("tick"),1000)' > server.js; } && { pm2 describe ${APP} >/dev/null 2>&1 || pm2 start server.js --name ${APP} >/dev/null 2>&1; }`);
  // wrap + pm2 jlist
  const j = R.extractJson(await ok('pm2 jlist'));
  const p = j.find((x) => x.name === APP);
  assert(p && p.pm2_env.pm_cwd && p.pm2_env.pm_out_log_path, 'pm2 jlist');
  const dir = p.pm2_env.pm_cwd;
  // estado inicial reproducible
  await ok(`cd ${R.sq(dir)} && rm -rf sub nuevo.txt old.txt app.js basura.txt a.log 'con espacio.txt' && mkdir -p uploads node_modules/x && echo hi > uploads/a.txt && echo m > node_modules/x/i.js && echo v1 > VERSION && echo SECRET=1 > .env && echo 'setInterval(()=>console.log("tick"),1000)' > server.js`);
  console.log('✔ wrap (PATH/nvm) + pm2 jlist →', dir);

  // extractJson tolera ruido
  assert.strictEqual(R.extractJson('[PM2] Spawning PM2 daemon\n[PM2] PM2 Successfully daemonized\n[]\n').length, 0);
  assert.strictEqual(R.extractJson('[PM2] ruido\n[{"name":"a"}]\n')[0].name, 'a');

  // quoting con espacios y comillas
  const weird = `${ark}/t e'st`;
  await ok(`mkdir -p ${R.sq(weird)} && echo ok > ${R.sq(weird + '/f x.txt')}`);
  assert((await ok(`cat ${R.sq(weird + '/f x.txt')}`)).trim() === 'ok');
  await ok(`rm -rf ${R.sq(weird)}`);
  console.log('✔ quoting seguro');

  // ---- backup: todo excepto
  await ok(`cd ${R.sq(dir)} && mkdir -p sub/node_modules sub/logs && echo x > sub/node_modules/z.js && echo l > a.log && echo l > sub/b.log && echo k > sub/keep.txt && echo p > 'con espacio.txt'`);
  const bdir = `${ark}/backups/${APP}`;
  const arch1 = `${bdir}/t1.tar.gz`;
  const spec = { dir, mode: 'all-except', includes: [], excludes: ['node_modules', '*.log', '/uploads'] };
  const size = Number((await ok(R.backupScript(spec, arch1))).trim());
  assert(size > 0);
  let ls = await ok(`tar -tzf ${R.sq(arch1)}`);
  assert(ls.includes('./server.js') && ls.includes('./.env') && ls.includes('./sub/keep.txt') && ls.includes('./con espacio.txt'), ls);
  assert(!/node_modules|\.log|uploads/.test(ls), 'exclusiones:\n' + ls);
  console.log('✔ backup «todo excepto» (node_modules en cualquier nivel, *.log, /uploads anclado)');

  // anclado no debe excluir un homónimo en subcarpeta
  await ok(`cd ${R.sq(dir)} && mkdir -p sub/uploads && echo s > sub/uploads/s.txt`);
  const arch2 = `${bdir}/t2.tar.gz`;
  await ok(R.backupScript({ ...spec, excludes: ['/uploads'] }, arch2));
  ls = await ok(`tar -tzf ${R.sq(arch2)}`);
  assert(ls.includes('./sub/uploads/s.txt') && !ls.includes('./uploads/a.txt'), ls);
  console.log('✔ regla anclada (/uploads) no toca sub/uploads');

  // ---- backup: solo lo elegido
  const arch3 = `${bdir}/t3.tar.gz`;
  await ok(R.backupScript({ dir, mode: 'only', includes: ['/VERSION', '/sub', '/con espacio.txt'], excludes: ['node_modules', '*.log'] }, arch3));
  ls = (await ok(`tar -tzf ${R.sq(arch3)}`)).trim().split('\n').filter((l) => !l.endsWith('/'));
  assert.deepStrictEqual(ls.sort(), ['./VERSION', './con espacio.txt', './sub/keep.txt', './sub/uploads/s.txt'].sort(), JSON.stringify(ls));
  assert.throws(() => R.backupScript({ dir, mode: 'only', includes: [], excludes: [] }, arch3), /nada seleccionado/);
  console.log('✔ backup «solo lo seleccionado»');

  const pv = R.parsePreview(await ok(R.previewScript(spec)));
  assert(pv.files > 3 && pv.bytes > 0, JSON.stringify(pv));
  console.log('✔ vista previa:', pv);

  // ---- listar / podar
  const lb = R.parseBackupList(await ok(R.listBackupsScript(bdir)));
  assert(lb.length === 3 && lb[0].size > 0);
  await ok(R.pruneBackupsScript(bdir, 1));
  assert(R.parseBackupList(await ok(R.listBackupsScript(bdir))).length === 1);
  console.log('✔ listar y podar backups');

  // ---- deploy desde carpeta subida (sync + preservar)
  const stage = `${ark}/staging/${APP}/t`;
  await ok(`rm -rf ${R.sq(stage)}; mkdir -p ${R.sq(stage + '/content')} && cd ${R.sq(stage + '/content')} && echo v2 > VERSION && echo nuevo > nuevo.txt && echo 'setInterval(()=>console.log("v2"),1000)' > server.js`);
  await ok(`cd ${R.sq(dir)} && echo viejo > old.txt && echo local > uploads/local.txt`);
  const out1 = await ok(R.applyScript({ src: stage + '/content', dir, mode: 'sync', preserve: ['.env', 'node_modules', 'uploads', '*.db'], flatten: true }));
  const after = (await ok(`cd ${R.sq(dir)} && find . -type f | sort`)).split('\n');
  assert(after.includes('./nuevo.txt') && !after.includes('./old.txt') && !after.includes('./sub/keep.txt'), 'sync borra lo que sobra:\n' + after.join('\n'));
  assert(after.includes('./.env') && after.includes('./uploads/local.txt') && after.includes('./node_modules/x/i.js'), 'preserva:\n' + after.join('\n'));
  assert((await ok(`cat ${R.sq(dir + '/VERSION')}`)).trim() === 'v2');
  console.log('✔ deploy modo sync: reemplaza, borra sobrantes y preserva .env/uploads/node_modules');

  // merge no borra
  await ok('sleep 1.2'); // rsync compara tamaño+fecha (resolución de 1 s)
  await ok(`rm -rf ${R.sq(stage)}; mkdir -p ${R.sq(stage + '/content')} && echo v3 > ${R.sq(stage + '/content/VERSION')}`);
  await ok(R.applyScript({ src: stage + '/content', dir, mode: 'merge', preserve: [], flatten: false }));
  assert((await ok(`cd ${R.sq(dir)} && ls`)).includes('nuevo.txt') && (await ok(`cat ${R.sq(dir + '/VERSION')}`)).trim() === 'v3');
  console.log('✔ deploy modo merge: no borra');

  // ---- deploy desde ZIP con carpeta raíz única (flatten)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpm-z-'));
  fs.mkdirSync(path.join(tmp, 'release-1.4'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'release-1.4/VERSION'), 'v4\n'); fs.writeFileSync(path.join(tmp, 'release-1.4/app.js'), 'x');
  execFileSync('python3', ['-c', `import shutil;shutil.make_archive('${tmp}/rel','zip','${tmp}','release-1.4')`]);
  await ok(`rm -rf ${R.sq(stage)}; mkdir -p ${R.sq(stage)}`);
  await m.uploadMany(sid, 'z', [{ local: path.join(tmp, 'rel.zip'), remote: stage + '/upload.zip', size: fs.statSync(path.join(tmp, 'rel.zip')).size }]);
  const ex = await ok(R.extractScript(stage + '/upload.zip', stage + '/content'));
  assert(/extraídos: 2/.test(ex), ex);
  const ap = await ok(R.applyScript({ src: stage + '/content', dir, mode: 'sync', preserve: ['.env', 'node_modules', 'uploads'], flatten: true }));
  const dbg = (await ok(`cd ${R.sq(dir)} && ls -la --time-style=full-iso && cat VERSION`));
  assert(/una sola carpeta/.test(ap) && (await ok(`cat ${R.sq(dir + '/VERSION')}`)).trim() === 'v4' && (await ok(`ls ${R.sq(dir)}`)).includes('app.js'), ap + '\n' + dbg);
  console.log('✔ ZIP: extrae, detecta carpeta raíz única y aplica');
  await ok(`rm -rf ${R.sq(stage)}`);

  // ---- restaurar el backup t3 (solo VERSION, sub, con espacio)… debe volver a ese estado preservando .env
  const arch4 = `${bdir}/t4.tar.gz`;
  await ok(`cd ${R.sq(dir)} && echo v5 > VERSION`);
  await ok(R.backupScript({ dir, mode: 'all-except', includes: [], excludes: ['node_modules'] }, arch4));
  await ok(`cd ${R.sq(dir)} && echo roto > VERSION && echo basura > basura.txt`);
  await ok(R.restoreScript(arch4, `${ark}/tmp/restore-t`, dir, ['.env', 'node_modules', 'uploads']));
  assert((await ok(`cat ${R.sq(dir + '/VERSION')}`)).trim() === 'v5' && !(await ok(`ls ${R.sq(dir)}`)).includes('basura.txt'));
  console.log('✔ restaurar backup (deja la carpeta como estaba)');

  // ---- comandos posteriores
  const post = await run(R.postScript(dir, 'echo uno\ntrue\nfalse\necho no-debe-llegar'));
  assert(post.code !== 0 && post.stdout.includes('uno') && !post.stdout.includes('no-debe-llegar'));
  const post2 = await run(R.postScript(dir, 'echo ok1\npwd'));
  assert(post2.code === 0 && post2.stdout.includes(dir));
  console.log('✔ comandos posteriores (se detienen en el primer error)');

  // ---- pm2
  for (const verb of ['restart', 'stop', 'start', 'reload']) {
    const r = await run(R.pm2Script('pm2', verb, APP, verb === 'restart'));
    assert.strictEqual(r.code, 0, verb + ': ' + r.stdout + r.stderr);
  }
  const st = R.extractJson(await ok('pm2 jlist')).find((x) => x.name === APP).pm2_env.status;
  assert.strictEqual(st, 'online');
  console.log('✔ pm2 start/stop/restart/reload');

  // ---- información del servidor
  const info = R.parseServerInfo(await ok(R.serverInfoScript()));
  assert(info.os && info.kernel && info.uptimeSec > 0 && info.cpus >= 1 && info.memTotal > 1e8 && info.memAvail > 0 && info.memAvail <= info.memTotal, JSON.stringify(info));
  assert(info.disks.length >= 1 && info.disks[0].total > 0 && info.disks[0].used <= info.disks[0].total && info.cpuUse >= 0 && info.cpuUse <= 100, JSON.stringify(info.disks));
  console.log('✔ información del servidor:', info.os, '|', info.cpus, 'CPU |', Math.round(info.memTotal / 1e6), 'MB RAM |', info.disks[0].mount, Math.round(info.disks[0].total / 1e9), 'GB');

  // ---- terminal: un comando por vez, con la carpeta que persiste entre comandos
  {
    const runTerm = async (cwd, cmd) => {
      const r = await run(R.terminalScript(cwd, dir, cmd));   // mismo script que usa la pestaña Terminal
      const lines = (r.stdout + r.stderr).split('\n')   // en la app va con pty: stderr y stdout llegan juntos
        .map((l) => l.replace(/\r$/, ''));
      const mark = lines.map(R.parseTermMarker).filter(Boolean).pop();
      return { out: lines.filter((l) => !R.parseTermMarker(l)).join('\n').trim(), ...mark };
    };
    await ok(`mkdir -p ${R.sq(dir + '/sub dir')} && echo contenido > ${R.sq(dir + '/sub dir/a.txt')}`);
    let t = await runTerm(dir, 'pwd');
    assert(t.out === dir && t.code === 0 && t.cwd === dir, JSON.stringify(t));
    t = await runTerm(t.cwd, 'cd "sub dir"'); assert(t.cwd === dir + '/sub dir' && t.code === 0, JSON.stringify(t));
    t = await runTerm(t.cwd, 'cat a.txt && echo $PWD'); assert(t.out.startsWith('contenido') && t.cwd === dir + '/sub dir', JSON.stringify(t));
    t = await runTerm(t.cwd, 'ls no-existe'); assert(t.code !== 0 && /no-existe/.test(t.out), JSON.stringify(t));
    t = await runTerm(t.cwd, 'echo "comilla sin cerrar'); assert(t.code !== 0 && t.cwd === dir + '/sub dir', 'un error de sintaxis no rompe el marcador: ' + JSON.stringify(t));
    t = await runTerm(t.cwd, 'exit 7'); assert(t.code === undefined || t.code === 7, 'exit del usuario: ' + JSON.stringify(t));
    t = await runTerm(dir, 'read x; echo "leido=[$x]"'); assert(/leido=\[\]/.test(t.out), 'sin stdin no se cuelga: ' + JSON.stringify(t));
    t = await runTerm(dir, 'pm2 jlist | head -c 2; echo; node -v'); assert(/^\[/.test(t.out) && /v\d+/.test(t.out), 'pm2 y node en el PATH: ' + JSON.stringify(t));
    t = await runTerm('/ruta/que/no/existe', 'pwd'); assert(t.out === dir, 'si la carpeta no existe vuelve a la de la app: ' + JSON.stringify(t));
    t = await runTerm(dir, "echo 'it''s' \"$((6*7))\" $(whoami)"); assert(/its 42 deploy|its 42 \w+/.test(t.out), JSON.stringify(t));
    await ok(`rm -rf ${R.sq(dir + '/sub dir')}`);
    console.log('✔ terminal: carpeta persistente, códigos de salida, errores de sintaxis, sin stdin, PATH de pm2/node');
  }

  // ---- datos compartidos en el servidor (.arkpm): notas y configuración visibles para cualquier usuario / conexión
  {
    const sd = R.sharedDir(dir);
    await ok(`rm -rf ${R.sq(sd)}`);
    const rd = async () => R.parseSharedRead(await ok(R.sharedReadScript(sd)));
    const wr = (rel, field, exp, obj) => m.exec(sid, R.wrap(R.sharedWriteScript(sd, rel, field, exp)), { stdin: JSON.stringify(obj), timeoutMs: 20000 });
    let r = await rd(); assert(r.state === 'rw' || r.state === 'new', 'estado inicial: ' + r.state); assert(r.notes.length === 0 && r.config === null);
    const n1 = { id: 'nota-1', text: 'línea 1\nlínea "2" con ñ y \\ barra', createdAt: 1, updatedAt: 1000, author: 'deploy' };
    let w = await wr('notes/nota-1.json', 'updatedAt', null, n1); assert(w.code === 0 && w.stdout.trim() === 'OK', JSON.stringify(w));
    r = await rd(); assert(r.state === 'rw' && r.notes.length === 1 && r.notes[0].text === n1.text, 'ida y vuelta de la nota (saltos de línea, comillas, acentos): ' + JSON.stringify(r));
    // conflicto: alguien la editó mientras tanto
    w = await wr('notes/nota-1.json', 'updatedAt', 999, { ...n1, text: 'pisada', updatedAt: 2000 }); assert(/CONFLICT/.test(w.stdout) && !/OK/.test(w.stdout), 'detecta edición simultánea: ' + JSON.stringify(w));
    w = await wr('notes/nota-1.json', 'updatedAt', 1000, { ...n1, text: 'editada', updatedAt: 2000 }); assert(/OK/.test(w.stdout));
    assert((await rd()).notes[0].text === 'editada');
    // configuración con revisión
    w = await wr('config.json', 'rev', null, { rev: 1, deploy: { mode: 'sync' } }); assert(w.code === 0);
    w = await wr('config.json', 'rev', 5, { rev: 6 }); assert(/CONFLICT/.test(w.stdout), 'config: conflicto de revisión');
    w = await wr('config.json', 'rev', 1, { rev: 2, deploy: { mode: 'merge' } }); assert(/OK/.test(w.stdout));
    assert((await rd()).config.deploy.mode === 'merge');
    assert.throws(() => R.sharedWriteScript(sd, '../../etc/passwd', 'rev', null), /Ruta/); assert.throws(() => R.sharedDeleteScript(sd, '../x'), /Id/);
    // permisos abiertos y sin archivos temporales sueltos
    const perms = (await ok(`stat -c '%a' ${R.sq(sd + '/notes/nota-1.json')} ${R.sq(sd + '/config.json')}; ls -A ${R.sq(sd)}`)).trim().split('\n');
    assert(perms[0] === '666' && perms[1] === '666' && !perms.some((l) => l.startsWith('.tmp')), 'permisos 666 y sin temporales: ' + perms.join(','));
    // OTRO usuario SSH ve y edita lo mismo (otra conexión, otro usuario)
    if (process.env.ARKPM_TEST_USER2) {
      const o2 = { host: o.host, port: o.port, username: process.env.ARKPM_TEST_USER2, password: process.env.ARKPM_TEST_PASS2 };
      const c2 = await m.connect({ ...o2, expectedFingerprint: fp }); assert(c2.ok, 'conecta el segundo usuario');
      const run2 = (script, stdin) => m.exec(c2.sessionId, R.wrap(script), { stdin, timeoutMs: 20000 });
      const r2 = R.parseSharedRead((await run2(R.sharedReadScript(sd))).stdout);
      assert(r2.state === 'rw' && r2.notes.length === 1 && r2.notes[0].text === 'editada' && r2.config.deploy.mode === 'merge', 'el otro usuario ve las notas y la configuración: ' + JSON.stringify(r2));
      let w2 = await run2(R.sharedWriteScript(sd, 'notes/nota-2.json', 'updatedAt', null), JSON.stringify({ id: 'nota-2', text: 'del otro usuario', createdAt: 5, updatedAt: 5000, author: o2.username })); assert(/OK/.test(w2.stdout), 'el otro usuario crea una nota: ' + w2.stderr + w2.stdout);
      w2 = await run2(R.sharedWriteScript(sd, 'notes/nota-1.json', 'updatedAt', 2000), JSON.stringify({ ...n1, text: 'editada por el otro', updatedAt: 6000, author: o2.username })); assert(/OK/.test(w2.stdout), 'el otro usuario edita una nota ajena: ' + w2.stderr + w2.stdout);
      const r3 = await rd(); assert(r3.notes.length === 2 && r3.notes.find((n) => n.id === 'nota-1').author === o2.username, 'el primer usuario ve lo que escribió el otro');
      await run2(R.sharedDeleteScript(sd, 'nota-2'));
      assert((await rd()).notes.length === 1, 'el otro usuario puede borrar una nota');
      m.disconnect(c2.sessionId);
      console.log('✔ dos usuarios SSH comparten notas y configuración (leer, crear, editar, borrar)');
    }
    // el deploy en modo sync no borra .arkpm y el backup no lo incluye
    const st2 = `${ark}/staging/${APP}/shared`;
    await ok(`rm -rf ${R.sq(st2)}; mkdir -p ${R.sq(st2 + '/content')} && echo nuevo > ${R.sq(st2 + '/content/NUEVO')}`);
    await ok(R.applyScript({ src: st2 + '/content', dir, mode: 'sync', preserve: [], flatten: false }));
    assert((await rd()).notes.length >= 1, 'el deploy (sync) no borra .arkpm');
    const arch = `${ark}/backups/${APP}/shared.tar.gz`;
    await ok(R.backupScript({ dir, mode: 'all-except', includes: [], excludes: [] }, arch));
    assert(!(await ok(`tar -tzf ${R.sq(arch)}`)).includes('.arkpm'), 'el backup no incluye .arkpm');
    await ok(`rm -rf ${R.sq(st2)} ${R.sq(arch)} ${R.sq(sd)}`);
    console.log('✔ datos compartidos en el servidor: ida y vuelta, conflictos, permisos, deploy y backup respetan .arkpm');
  }

  // ---- crear un servicio nuevo en PM2
  const nd = `${ark}/nuevo-svc`;
  await ok(`rm -rf ${R.sq(nd)}; mkdir -p ${R.sq(nd)} && echo 'setInterval(()=>console.log("env="+process.env.MI_VAR+" arg="+process.argv[2]),1000)' > ${R.sq(nd + '/srv-app.js')}`);
  const nspec = { name: 'svc-test', kind: 'node', script: 'srv-app.js', cwd: nd, args: '"hola mundo"', interpreter: '', instances: '1', maxMemory: '200m', env: [{ key: 'MI_VAR', value: "it's ok" }], autorestart: true };
  const made = await run(R.pm2NewScript('pm2', nspec));
  assert.strictEqual(made.code, 0, made.stdout + made.stderr);
  let np = R.extractJson(await ok('pm2 jlist')).find((x) => x.name === 'svc-test');
  assert(np && np.pm2_env.status === 'online' && np.pm2_env.pm_cwd === nd && np.pm2_env.max_memory_restart === 200 * 1024 * 1024, JSON.stringify(np && np.pm2_env.status));
  await ok('sleep 2'); assert((await ok(`tail -n 2 ${R.sq(np.pm2_env.pm_out_log_path)}`)).includes('env=it\'s ok arg=hola mundo'));
  await ok('pm2 delete svc-test');
  const spec2 = { ...nspec, name: 'svc-npm', kind: 'npm', script: 'start', args: '', maxMemory: '', env: [] };
  await ok(`echo '{"name":"x","scripts":{"start":"node srv-app.js"}}' > ${R.sq(nd + '/package.json')}`);
  assert.strictEqual((await run(R.pm2NewScript('pm2', spec2))).code, 0);
  np = R.extractJson(await ok('pm2 jlist')).find((x) => x.name === 'svc-npm'); assert(np && np.pm2_env.status === 'online');
  await ok('pm2 delete svc-npm');
  const spec3 = { ...nspec, name: 'svc-cmd', kind: 'command', script: './run.sh', args: 'uno', env: [] };
  await ok(`printf '#!/bin/bash\\nwhile true; do echo cmd $1; sleep 1; done\\n' > ${R.sq(nd + '/run.sh')} && chmod +x ${R.sq(nd + '/run.sh')}`);
  assert.strictEqual((await run(R.pm2NewScript('pm2', spec3))).code, 0);
  np = R.extractJson(await ok('pm2 jlist')).find((x) => x.name === 'svc-cmd'); assert(np && np.pm2_env.status === 'online');
  await ok('pm2 delete svc-cmd');
  assert.throws(() => R.pm2NewScript('pm2', { ...nspec, name: 'a b; rm -rf /' }), /nombre/);
  assert.throws(() => R.pm2NewScript('pm2', { ...nspec, script: 'con espacio.js' }), /espacios/);
  assert.throws(() => R.pm2NewScript('pm2', { ...nspec, cwd: 'relativa' }), /absoluta/);
  assert.throws(() => R.pm2NewScript('pm2', { ...nspec, env: [{ key: 'X;Y', value: '' }] }), /Variable/);
  await ok(`rm -rf ${R.sq(nd)}`);
  console.log('✔ crear servicios nuevos en PM2 (node, npm, comando; env, args con espacios, límite de memoria; validaciones)');

  await ok(`rm -rf ${R.sq(bdir)} ${R.sq(ark + '/tmp')} ${R.sq(dir + '/sub')} ${R.sq(dir + '/nuevo.txt')} ${R.sq(dir + '/app.js')} ${R.sq(dir + '/con espacio.txt')}`);
  m.disconnect(sid);
  console.log('TODO OK'); process.exit(0);
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
