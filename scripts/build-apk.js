// Compila el proyecto Android y deja el APK en ./release (junto a lo de Electron y el servidor).
//   npm run apk            → APK de depuración (firmado con la clave de debug: se instala directamente)
//   npm run apk:release    → APK release; se firma si defines ARKPM_KEYSTORE, ARKPM_KEYSTORE_PASS (y opcional
//                            ARKPM_KEY_ALIAS / ARKPM_KEY_PASS); si no, queda «-unsigned» (Android no lo instala sin firmar)
// Antes ejecuta «npm run cap:sync» (sube la versión de Android, compila la web y sincroniza). Con --no-sync lo omite.
// Requisitos: Android SDK (ANDROID_HOME) y JDK 17+; el proyecto android/ creado con «npm run cap:add:android».
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const androidDir = path.join(root, 'android');
const release = process.argv.includes('--release');
const sync = !process.argv.includes('--no-sync');
const win = process.platform === 'win32';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: win, cwd: root, ...opts });
  if (r.status !== 0) { console.error(`\nFalló: ${cmd} ${args.join(' ')}`); process.exit(r.status || 1); }
};

if (!fs.existsSync(path.join(androidDir, 'gradlew')) && !fs.existsSync(path.join(androidDir, 'gradlew.bat'))) {
  console.error('No existe el proyecto android/. Créalo primero con «npm run cap:add:android» (y copia lo nativo con scripts/install-android-native.sh).');
  process.exit(1);
}

if (sync) run('npm', ['run', 'cap:sync']);

const ver = (() => { try { const v = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8')).android; return v.version; } catch { return '0.0.0'; } })();
const task = release ? 'assembleRelease' : 'assembleDebug';
run(win ? 'gradlew.bat' : './gradlew', [task], { cwd: androidDir });

const outDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug');
const apk = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.apk')).map((f) => path.join(outDir, f))[0] : null;
if (!apk) { console.error(`No se encontró el APK en ${outDir}`); process.exit(1); }

const dest = path.join(root, 'release');
fs.mkdirSync(dest, { recursive: true });
let name = `Arkpm-${ver}-android${release ? '' : '-debug'}.apk`;
let target = path.join(dest, name);

if (release) {
  const ks = process.env.ARKPM_KEYSTORE;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const tools = sdk && fs.existsSync(path.join(sdk, 'build-tools')) ? fs.readdirSync(path.join(sdk, 'build-tools')).sort().pop() : null;
  if (ks && tools) {
    const bt = path.join(sdk, 'build-tools', tools);
    const exe = (n) => path.join(bt, win ? n + '.bat' : n);
    const aligned = path.join(dest, '.aligned.apk');
    fs.rmSync(aligned, { force: true });
    run(path.join(bt, win ? 'zipalign.exe' : 'zipalign'), ['-f', '-p', '4', apk, aligned]);
    run(exe('apksigner'), ['sign', '--ks', ks, '--ks-pass', `pass:${process.env.ARKPM_KEYSTORE_PASS || ''}`,
      ...(process.env.ARKPM_KEY_ALIAS ? ['--ks-key-alias', process.env.ARKPM_KEY_ALIAS] : []),
      ...(process.env.ARKPM_KEY_PASS ? ['--key-pass', `pass:${process.env.ARKPM_KEY_PASS}`] : []),
      '--out', target, aligned]);
    fs.rmSync(aligned, { force: true });
  } else {
    name = `Arkpm-${ver}-android-unsigned.apk`; target = path.join(dest, name);
    fs.copyFileSync(apk, target);
    console.warn('\nAviso: APK sin firmar (define ARKPM_KEYSTORE y ARKPM_KEYSTORE_PASS, con ANDROID_HOME, para firmarlo). Android no instala APK sin firmar; usa «npm run apk» para uno instalable.');
  }
} else {
  fs.copyFileSync(apk, target);
}
console.log(`\nAPK listo: ${path.relative(root, target)}`);
