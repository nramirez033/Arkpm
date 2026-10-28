// Versionado: x.y.z + fecha ddmmyyyy. Cada generación sube la versión (z) de su componente:
//   android  → npm run cap:sync        (app Android / Capacitor)
//   electron → npm run dist            (app de escritorio)
// Uso: node scripts/version.js <android|electron> [--show]
// La fuente de verdad es versions.json; de ahí se generan src/app/version.ts, electron/versions.json y, según el caso,
// package.json (electron) y android/app/build.gradle (android). La fecha es la del día de la generación.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const FILE = path.join(root, 'versions.json');
const TARGETS = ['android', 'electron'];

const target = process.argv[2];
if (!TARGETS.includes(target)) { console.error('Uso: node scripts/version.js <android|electron>'); process.exit(1); }

const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}${p(d.getMonth() + 1)}${d.getFullYear()}`; };
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const v = read();
for (const t of TARGETS) if (!v[t] || !/^\d+\.\d+\.\d+$/.test(v[t].version)) v[t] = { version: '1.0.0', date: today() };

if (!process.argv.includes('--show')) {
  const [a, b, c] = v[target].version.split('.').map(Number);
  v[target] = { version: `${a}.${b}.${c + 1}`, date: today() };
  if (target === 'android') v.androidCode = (v.androidCode || 1) + 1;
}
fs.writeFileSync(FILE, JSON.stringify(v, null, 2) + '\n');

// ---- archivos derivados ----
const pub = { android: v.android, electron: v.electron };
fs.writeFileSync(path.join(root, 'src', 'app', 'version.ts'),
  `// Generado por scripts/version.js (no editar a mano)\nexport const VERSIONS = ${JSON.stringify(pub, null, 2)} as const;\n`);
fs.writeFileSync(path.join(root, 'electron', 'versions.json'), JSON.stringify(pub, null, 2) + '\n');

const edit = (file, fn) => { try { const s = fs.readFileSync(file, 'utf8'); const n = fn(s); if (n !== s) fs.writeFileSync(file, n); return true; } catch { return false; } };
if (target === 'electron') edit(path.join(root, 'package.json'), (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${v.electron.version}$2`));
if (target === 'android') {
  for (const g of [path.join(root, 'android', 'app', 'build.gradle'), path.join(root, 'android-native', 'android', 'app', 'build.gradle')]) {
    edit(g, (s) => s.replace(/versionCode\s+\d+/, `versionCode ${v.androidCode || 1}`).replace(/versionName\s+"[^"]*"/, `versionName "${v.android.version}"`));
  }
}
console.log(`${target}: ${v[target].version} ${v[target].date}`);
