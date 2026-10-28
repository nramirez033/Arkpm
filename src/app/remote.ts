// Generadores de scripts de shell para el servidor Ubuntu (funciones puras, probadas contra un sshd real: scripts/test-remote-scripts.js).
import { toBase64 } from './bytes';
import { cleanRules } from './exclude';

/** Comilla simple segura para shell. */
export const sq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ENV_INIT =
  'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; ' +
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ';

/**
 * Ejecuta un script en un bash de login (carga el PATH del usuario y nvm, que una sesión SSH no interactiva no carga).
 * El script va en base64: no hay que escapar nada y soporta varias líneas y acentos.
 */
export function wrap(script: string, init = ''): string {
  const full = ENV_INIT + (init.trim() ? init.trim() + '\n' : '') + script;
  return `bash -lc "$(printf %s ${toBase64(new TextEncoder().encode(full))} | base64 -d)"`;
}

export const safeName = (s: string): string => (s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app').slice(0, 60);

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const joinPath = (a: string, b: string): string => (a.endsWith('/') ? a : a + '/') + b.replace(/^\/+/, '');
export const parentPath = (p: string): string => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
export const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || '/';

/** Rutas que nunca se borran desde la app (raíz, carpetas del sistema de primer nivel y el home). */
export function isDangerousPath(p: string, home: string): boolean {
  const n = '/' + p.split('/').filter(Boolean).join('/');
  return n === '/' || n.split('/').filter(Boolean).length < 2 || n === home.replace(/\/+$/, '');
}

export const arkDir = (home: string) => `${home.replace(/\/+$/, '')}/.arkpm`;

// ------------------------------------------------------------------ reglas -> tar / rsync
/** Opciones `--exclude` de GNU tar equivalentes a las reglas (las rutas de miembros empiezan por «./»). */
export function tarExcludeArgs(rules: readonly string[]): string {
  const out: string[] = [];
  for (const r of cleanRules(rules)) {
    const anchored = r.startsWith('/');
    const body = anchored ? r.slice(1) : r;
    const star2 = body.includes('**');
    const pat = body.replace(/\*\*\/?/g, '*');
    const slash = star2 ? '--wildcards-match-slash' : '--no-wildcards-match-slash';
    out.push(anchored ? `${slash} --anchored ${sq('--exclude=./' + pat)}` : `${slash} --no-anchored ${sq('--exclude=' + pat)}`);
  }
  return out.join(' ');
}
export const rsyncExcludeArgs = (rules: readonly string[]): string => cleanRules(rules).map((r) => sq('--exclude=' + r)).join(' ');

// ------------------------------------------------------------------ backup
export interface TarSpec { dir: string; mode: 'all-except' | 'only'; includes: string[]; excludes: string[]; }

function tarCore(s: TarSpec): { args: string; paths: string } {
  const inc = s.mode === 'only' ? cleanRules(s.includes).filter((r) => r.startsWith('/')).map((r) => './' + r.slice(1)) : ['.'];
  if (!inc.length) throw new Error('No hay nada seleccionado para incluir en el backup');
  return { args: tarExcludeArgs(s.excludes), paths: inc.map(sq).join(' ') };
}

/** Crea el .tar.gz en `out` (se escribe como .part y se renombra al terminar). */
export function backupScript(s: TarSpec, out: string): string {
  const { args, paths } = tarCore(s);
  return [
    'set -e',
    `mkdir -p ${sq(out.replace(/\/[^/]*$/, ''))}`,
    `cd ${sq(s.dir)}`,
    // código 1 de tar = «un archivo cambió mientras se leía» (logs en uso): no es un fallo
    `tar --warning=no-file-changed -czf ${sq(out + '.part')} ${args} -- ${paths} || [ $? -eq 1 ]`,
    `mv -f ${sq(out + '.part')} ${sq(out)}`,
    `stat -c '%s' ${sq(out)}`,
  ].join('\n');
}

/** Cuenta archivos y bytes (sin comprimir) de lo que entraría en el backup. */
export function previewScript(s: TarSpec): string {
  const { args, paths } = tarCore(s);
  return [
    'set -e',
    `cd ${sq(s.dir)}`,
    'L=$(mktemp)',
    `B=$(tar --warning=no-file-changed -cvf - ${args} -- ${paths} 2>"$L" | wc -c || true)`,
    'N=$(grep -vc "/$" "$L" || true)',
    'rm -f "$L"',
    'echo "FILES=$N"; echo "BYTES=$B"',
  ].join('\n');
}

export function parsePreview(out: string): { files: number; bytes: number } {
  const g = (k: string) => Number((out.match(new RegExp(`${k}=(\\d+)`)) ?? [])[1] ?? 0);
  return { files: g('FILES'), bytes: g('BYTES') };
}

export const listBackupsScript = (dir: string): string =>
  `cd ${sq(dir)} 2>/dev/null || exit 0\nfor f in *.tar.gz; do [ -f "$f" ] && stat -c '%n|%s|%Y' -- "$f"; done; exit 0`;

export function parseBackupList(out: string): { name: string; size: number; mtime: number }[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, size, m] = l.split('|');
    return { name, size: Number(size), mtime: Number(m) * 1000 };
  }).sort((a, b) => b.mtime - a.mtime);
}

export const pruneBackupsScript = (dir: string, keep: number): string =>
  `cd ${sq(dir)} 2>/dev/null || exit 0\nls -1t -- *.tar.gz 2>/dev/null | tail -n +${Math.max(1, Math.floor(keep)) + 1} | while IFS= read -r f; do rm -f -- "$f"; done; exit 0`;

// ------------------------------------------------------------------ deploy
/** Descomprime un ZIP / TAR / TAR.GZ subido en `contentDir`. */
export function extractScript(archive: string, contentDir: string): string {
  const a = sq(archive), c = sq(contentDir);
  return [
    'set -e',
    `mkdir -p ${c}`,
    `case ${a} in`,
    `  *.zip|*.ZIP) if command -v unzip >/dev/null 2>&1; then unzip -oq ${a} -d ${c} || [ $? -le 1 ]; else python3 -m zipfile -e ${a} ${c}; fi ;;`,
    `  *.tar.gz|*.tgz) tar -xzf ${a} -C ${c} ;;`,
    `  *.tar) tar -xf ${a} -C ${c} ;;`,
    '  *) echo "Formato no soportado (usa .zip, .tar.gz o .tgz)"; exit 2 ;;',
    'esac',
    `rm -f ${a}`,
    `echo "Archivos extraídos: $(find ${c} -type f | wc -l)"`,
  ].join('\n');
}

export interface ApplySpec { src: string; dir: string; mode: 'sync' | 'merge'; preserve: string[]; flatten: boolean; }

/** Copia `src` sobre la carpeta de la app. En modo sync deja la carpeta idéntica (salvo lo preservado). */
export function applyScript(s: ApplySpec): string {
  const ex = rsyncExcludeArgs(s.preserve);
  return [
    'set -e',
    `SRC=${sq(s.src)}`,
    ...(s.flatten ? [
      'if [ "$(ls -A "$SRC" | wc -l)" = 1 ]; then ONLY="$(ls -A "$SRC")"; if [ -d "$SRC/$ONLY" ]; then SRC="$SRC/$ONLY"; echo "El paquete trae una sola carpeta («$ONLY»): se usa su contenido"; fi; fi',
    ] : []),
    `mkdir -p ${sq(s.dir)}`,
    'if command -v rsync >/dev/null 2>&1; then',
    `  rsync -rlptDc ${s.mode === 'sync' ? '--delete ' : ''}${ex} "$SRC"/ ${sq(s.dir + '/')}`,
    'else',
    `  echo "rsync no está instalado en el servidor: se copia sobrescribiendo, sin borrar lo que sobra (sudo apt install rsync)"`,
    `  cp -a "$SRC"/. ${sq(s.dir + '/')}`,
    'fi',
    'echo "Archivos aplicados en la carpeta de la app"',
  ].join('\n');
}

/** Restaura un backup .tar.gz: lo extrae aparte y deja la carpeta idéntica a su contenido (salvo lo preservado). */
export function restoreScript(archive: string, tmp: string, dir: string, preserve: string[]): string {
  return [
    'set -e',
    `rm -rf ${sq(tmp)}; mkdir -p ${sq(tmp)}`,
    `tar -xzf ${sq(archive)} -C ${sq(tmp)}`,
    applyScript({ src: tmp, dir, mode: 'sync', preserve, flatten: false }),
    `rm -rf ${sq(tmp)}`,
  ].join('\n');
}

/** Comandos posteriores al deploy, en la carpeta de la app; se detiene en el primer error. */
export function postScript(dir: string, commands: string): string {
  return `set -eo pipefail\ncd ${sq(dir)}\nPS4='$ '\nset -x\n${commands.trim()}\n`;
}

export function pm2Script(pm2: string, verb: 'start' | 'stop' | 'restart' | 'reload' | 'delete', name: string, updateEnv = false): string {
  return `${pm2} ${verb} ${sq(name)}${updateEnv && (verb === 'restart' || verb === 'reload') ? ' --update-env' : ''} 2>&1`;
}

// ------------------------------------------------------------------ PM2 jlist
/** `pm2 jlist` puede ir precedido de avisos («[PM2] Spawning PM2 daemon…»): se toma la línea que es el JSON. */
export function extractJson(out: string): any[] {
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l === '[]' || l.startsWith('[{')) { try { return JSON.parse(l); } catch { /* sigue buscando */ } }
  }
  const i = out.indexOf('[{');
  if (i >= 0) { try { return JSON.parse(out.slice(i, out.lastIndexOf(']') + 1)); } catch { /* nada */ } }
  if (/\[\s*\]/.test(out) && !/error/i.test(out)) return [];
  throw new Error(('No se pudo leer la salida de PM2: ' + out.trim().split('\n').slice(-3).join(' ')).slice(0, 300));
}

// ------------------------------------------------------------------ crear un servicio nuevo en PM2
export interface Pm2NewSpec {
  name: string;
  /** node: script JS · npm: nombre del script de package.json · command: ejecutable o shell script */
  kind: 'node' | 'npm' | 'command';
  script: string;
  cwd: string;
  /** Argumentos tal como se escribirían en la terminal. */
  args: string;
  /** Solo kind=node: intérprete alternativo (p. ej. «python3»); vacío = el de PM2. */
  interpreter: string;
  /** 1 = fork; >1 o «max» = cluster (solo node). */
  instances: string;
  maxMemory: string;
  env: { key: string; value: string }[];
  autorestart: boolean;
}

export const PM2_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Devuelve el primer problema del formulario o null si está bien. */
export function validateNewSpec(s: Pm2NewSpec): string | null {
  if (!PM2_NAME_RE.test(s.name.trim())) return 'El nombre solo puede tener letras, números, punto, guion y guion bajo (máx. 64).';
  if (!s.cwd.trim().startsWith('/')) return 'La carpeta debe ser una ruta absoluta del servidor (empieza con /).';
  if (!s.script.trim()) return s.kind === 'npm' ? 'Indica el script de npm (por ejemplo «start»).' : 'Indica el archivo o comando a ejecutar.';
  if (s.kind !== 'npm' && /\s/.test(s.script.trim())) return 'PM2 no admite espacios en la ruta del script (los pasa sin comillas a la shell). Renombra el archivo o usa un script de npm.';
  if (s.kind === 'npm' && /\s/.test(s.script.trim())) return 'El script de npm es un nombre sin espacios (por ejemplo «start»); los argumentos van aparte.';
  if (s.instances.trim() && !/^(max|\d{1,3})$/i.test(s.instances.trim())) return 'Instancias: un número o «max».';
  if (s.maxMemory.trim() && !/^\d+(\.\d+)?\s?[KMG]$/i.test(s.maxMemory.trim())) return 'Límite de memoria: por ejemplo 300M o 1G.';
  for (const e of s.env) if ((e.key.trim() || e.value) && !ENV_KEY_RE.test(e.key.trim())) return `Variable de entorno inválida: «${e.key}».`;
  return null;
}

/** Script de shell que registra y arranca el servicio con «pm2 start». */
export function pm2NewScript(pm2: string, s: Pm2NewSpec): string {
  const err = validateNewSpec(s);
  if (err) throw new Error(err);
  const inst = s.instances.trim().toLowerCase();
  const cluster = s.kind === 'node' && inst && inst !== '1';
  const parts: string[] = [pm2, 'start'];
  parts.push(s.kind === 'npm' ? 'npm' : sq(s.script.trim()));
  parts.push('--name', sq(s.name.trim()));
  if (s.kind === 'command') parts.push('--interpreter', 'none');
  else if (s.kind === 'node' && s.interpreter.trim()) parts.push('--interpreter', sq(s.interpreter.trim()));
  if (cluster) parts.push('-i', sq(inst));
  if (s.maxMemory.trim()) parts.push('--max-memory-restart', sq(s.maxMemory.trim().toUpperCase().replace(/\s/g, '')));
  if (!s.autorestart) parts.push('--no-autorestart');
  const tail = s.kind === 'npm' ? `-- run ${sq(s.script.trim())}${s.args.trim() ? ' -- ' + s.args.trim() : ''}` : s.args.trim() ? '-- ' + s.args.trim() : '';
  return [
    'set -e',
    `cd ${sq(s.cwd.trim())}`,
    ...s.env.filter((e) => e.key.trim()).map((e) => `export ${e.key.trim()}=${sq(e.value)}`),
    `${parts.join(' ')} ${tail} 2>&1`.trimEnd(),
  ].join('\n');
}

// ------------------------------------------------------------------ información del servidor
export interface DiskInfo { dev: string; mount: string; total: number; used: number; avail: number; }
export interface ServerInfo {
  host: string; os: string; kernel: string; arch: string;
  uptimeSec: number; bootedAt: string; load: string;
  cpus: number; cpuModel: string; cpuUse: number;
  memTotal: number; memAvail: number; swapTotal: number; swapFree: number;
  disks: DiskInfo[]; virt: string; vendor: string; product: string; ips: string[];
}

/** Lee todo desde /proc, /etc y df (sin root ni paquetes extra). */
export const serverInfoScript = (): string => String.raw`export LC_ALL=C
echo "HOST=$(hostname 2>/dev/null)"
OSN=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"); echo "OS=$OSN"
echo "KERNEL=$(uname -r)"; echo "ARCH=$(uname -m)"
echo "UPTIME=$(cut -d' ' -f1 /proc/uptime)"
echo "BOOT=$(uptime -s 2>/dev/null)"
echo "LOAD=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "CPUS=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
CM=$(grep -m1 -E 'model name|Model' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//'); [ -z "$CM" ] && CM=$(lscpu 2>/dev/null | sed -n 's/^Model name: *//p' | head -1); echo "CPUMODEL=$CM"
s1=$(head -1 /proc/stat); sleep 0.4; s2=$(head -1 /proc/stat)
echo "$s1 $s2" | awk '{t1=$2+$3+$4+$5+$6+$7+$8+$9; i1=$5+$6; t2=$13+$14+$15+$16+$17+$18+$19+$20; i2=$16+$17; d=t2-t1; printf "CPUUSE=%.0f
", (d>0 ? (d-(i2-i1))*100/d : 0)}'
awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} /^MemFree/{f=$2} /^SwapTotal/{st=$2} /^SwapFree/{sf=$2} END{if(a=="")a=f; print "MEMTOTAL=" t*1024; print "MEMAVAIL=" a*1024; print "SWAPTOTAL=" st*1024; print "SWAPFREE=" sf*1024}' /proc/meminfo
df -B1 -P -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | awk 'NR>1 && $2>0 {print "DISK=" $1 "|" $6 "|" $2 "|" $3 "|" $4}'
echo "VIRT=$(systemd-detect-virt 2>/dev/null)"
echo "VENDOR=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
echo "PRODUCT=$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
echo "IPS=$(hostname -I 2>/dev/null | cut -d' ' -f1-4)"
exit 0`;

export function parseServerInfo(out: string): ServerInfo {
  const kv = new Map<string, string>();
  const disks: DiskInfo[] = [];
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (k === 'DISK') { const [dev, mount, total, used, avail] = v.split('|'); disks.push({ dev, mount, total: Number(total), used: Number(used), avail: Number(avail) }); }
    else kv.set(k, v);
  }
  const n = (k: string) => Number(kv.get(k) ?? 0) || 0;
  const t = (k: string) => kv.get(k) ?? '';
  if (!kv.has('KERNEL')) throw new Error('El servidor no devolvió información (¿no es Linux?)');
  return {
    host: t('HOST'), os: t('OS') || 'Linux', kernel: t('KERNEL'), arch: t('ARCH'), uptimeSec: n('UPTIME'), bootedAt: t('BOOT'), load: t('LOAD'),
    cpus: n('CPUS'), cpuModel: t('CPUMODEL'), cpuUse: n('CPUUSE'),
    memTotal: n('MEMTOTAL'), memAvail: n('MEMAVAIL'), swapTotal: n('SWAPTOTAL'), swapFree: n('SWAPFREE'),
    disks: disks.filter((d, i) => disks.findIndex((x) => x.dev === d.dev && x.total === d.total && x.used === d.used) === i).sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.total - a.total)),
    virt: t('VIRT') === 'none' ? '' : t('VIRT'), vendor: t('VENDOR'), product: t('PRODUCT'), ips: t('IPS').split(/\s+/).filter(Boolean),
  };
}
