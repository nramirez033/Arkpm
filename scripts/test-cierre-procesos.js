// Comprueba que al cerrar la app NO queda nada corriendo: ni el proceso principal ni sus hijos (renderer, GPU, utilidades),
// y que se cierran las sesiones SSH que la app abrió en el servidor. Linux con xvfb + un servidor SSH de prueba local.
// Uso: ARKPM_TEST_PORT=2222 ARKPM_TEST_USER=u ARKPM_TEST_PASS=p node scripts/test-cierre-procesos.js
const { spawn, execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }); } catch (e) { return e.stdout || ''; } };
const descendants = (pid) => { const rows = sh('ps -eo pid=,ppid=').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)); const out = new Set([pid]); let grew = true; while (grew) { grew = false; for (const [p, pp] of rows) if (out.has(pp) && !out.has(p)) { out.add(p); grew = true; } } return [...out]; };
const alive = (pids) => pids.filter((p) => { try { process.kill(p, 0); return !/Z/.test(sh(`ps -o stat= -p ${p}`)); } catch { return false; } });
const sessions = () => sh('ps -eo args= | grep -c "[s]shd: ' + process.env.ARKPM_TEST_USER + '@"').trim() | 0;

(async () => {
  const bad = [];
  for (const mode of ['dialog', 'quit', 'sigterm']) {
    fs.rmSync('/tmp/arkpm-salida.pid', { force: true });
    const before = sessions();
    const p = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', path.join(__dirname, '..', 'node_modules/.bin/electron'), '--no-sandbox', '--disable-gpu', path.join(__dirname, 'e2e-salida.js'), mode], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', () => {});
    let ready = false; for (let i = 0; i < 120 && !ready; i++) { await sleep(250); ready = out.includes('LISTO'); }
    if (!ready) { bad.push(mode + ': la app no llegó a conectar'); try { process.kill(-p.pid); } catch {} continue; }
    const pid = Number(fs.readFileSync('/tmp/arkpm-salida.pid', 'utf8'));
    const tree = descendants(pid);
    const during = sessions() - before;
    // espera a que salga (la propia app inicia el cierre 1,5 s después de «LISTO»)
    let gone = false; for (let i = 0; i < 60 && !gone; i++) { await sleep(250); gone = alive([pid]).length === 0; }
    await sleep(2500);   // margen para hijos y sesiones remotas
    const left = alive(tree), sessionsLeft = sessions() - before;
    const ok = gone && left.length === 0 && sessionsLeft <= 0;
    console.log(ok ? '✔' : '✖', `salida «${mode}»: proceso principal ${gone ? 'terminó' : 'SIGUE VIVO'}; ${tree.length} procesos de la app → quedan ${left.length}; sesiones SSH abiertas ${during} → quedan ${Math.max(0, sessionsLeft)}`);
    if (!ok) bad.push(mode + (left.length ? ' · procesos vivos: ' + left.join(',') + ' ' + sh('ps -o pid=,args= -p ' + left.join(',')).split('\n')[0].slice(0, 120) : '') + (sessionsLeft > 0 ? ' · sesiones SSH sin cerrar' : ''));
    try { process.kill(-p.pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
  console.log(bad.length ? '\nFALLOS:\n- ' + bad.join('\n- ') : '\nTODO OK: al cerrar no queda nada corriendo');
  process.exit(bad.length ? 1 : 0);
})();
