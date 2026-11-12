// Lógica de nginx: lectura y análisis de la configuración, plantillas de sitios y scripts con sudo.
// Funciones puras, probadas contra un nginx real por SSH (scripts/test-nginx.js).
import { sq } from './remote';

export type SudoMode = 'root' | 'nopasswd' | 'password' | 'none';
export interface NginxProbe {
  installed: boolean; version: string; bin: string; active: 'active' | 'inactive'; systemd: boolean;
  sudo: SudoMode; certbot: boolean; layout: 'debian' | 'confd'; workers: number; confDir: string; ipv6: boolean;
}

export const NGINX_DIR = '/etc/nginx';

/** Qué hay instalado y con qué permisos se puede actuar. Todo sin privilegios. */
export const nginxProbeScript = (): string => String.raw`export LC_ALL=C
BIN=$(command -v nginx 2>/dev/null); [ -z "$BIN" ] && for c in /usr/sbin/nginx /usr/local/nginx/sbin/nginx /opt/nginx/sbin/nginx; do [ -x "$c" ] && BIN=$c && break; done
echo "INSTALLED=$([ -n "$BIN" ] && echo 1 || echo 0)"
echo "BIN=$BIN"
[ -n "$BIN" ] && echo "VERSION=$("$BIN" -v 2>&1 | head -1 | sed 's/^nginx version: //')"
SD=0; [ -d /run/systemd/system ] && SD=1; echo "SYSTEMD=$SD"
ACT=inactive
if [ "$SD" = 1 ]; then [ "$(systemctl is-active nginx 2>/dev/null)" = active ] && ACT=active; else pgrep -x nginx >/dev/null 2>&1 && ACT=active; fi
echo "ACTIVE=$ACT"
echo "WORKERS=$(pgrep -c -x nginx 2>/dev/null || echo 0)"
if [ "$(id -u)" = 0 ]; then echo SUDO=root
elif ! command -v sudo >/dev/null 2>&1; then echo SUDO=none
elif sudo -n true 2>/dev/null; then echo SUDO=nopasswd
else echo SUDO=password; fi
echo "CERTBOT=$(command -v certbot >/dev/null 2>&1 && echo 1 || echo 0)"
echo "IPV6=$([ -s /proc/net/if_inet6 ] && echo 1 || echo 0)"
echo "LAYOUT=$([ -d ${NGINX_DIR}/sites-available ] && echo debian || echo confd)"
exit 0`.replace(/\$\{NGINX_DIR\}/g, NGINX_DIR);

export function parseNginxProbe(out: string): NginxProbe {
  const kv = new Map<string, string>();
  for (const l of out.split('\n')) { const i = l.indexOf('='); if (i > 0) kv.set(l.slice(0, i), l.slice(i + 1).trim()); }
  const g = (k: string) => kv.get(k) ?? '';
  return {
    installed: g('INSTALLED') === '1', version: g('VERSION'), bin: g('BIN') || 'nginx', active: g('ACTIVE') === 'active' ? 'active' : 'inactive', systemd: g('SYSTEMD') === '1',
    sudo: (['root', 'nopasswd', 'password', 'none'].includes(g('SUDO')) ? g('SUDO') : 'none') as SudoMode, certbot: g('CERTBOT') === '1',
    layout: g('LAYOUT') === 'debian' ? 'debian' : 'confd', workers: Number(g('WORKERS')) || 0, confDir: NGINX_DIR, ipv6: g('IPV6') === '1',
  };
}

// ------------------------------------------------------------------ lectura de los archivos de configuración
export type FileKind = 'main' | 'available' | 'enabledfile' | 'confd';
export interface RawFile { kind: FileKind; path: string; enabled: boolean; content: string; }

/** Imprime cada archivo entre marcas `@@FILE|tipo|ruta|activo` y `@@END`. Los archivos de /etc/nginx suelen ser legibles sin sudo. */
export const nginxReadScript = (): string => String.raw`D=${NGINX_DIR}
emit() { printf '@@FILE|%s|%s|%s\n' "$1" "$2" "$3"; head -c 262144 "$2" 2>/dev/null; echo; echo '@@END'; }
[ -f "$D/nginx.conf" ] && emit main "$D/nginx.conf" 1
if [ -d "$D/sites-available" ]; then for f in "$D"/sites-available/*; do [ -f "$f" ] || continue; n=$(basename "$f"); en=0; [ -e "$D/sites-enabled/$n" ] && en=1; emit available "$f" $en; done; fi
for f in "$D"/sites-enabled/*; do [ -f "$f" ] && [ ! -L "$f" ] && emit enabledfile "$f" 1; done
for f in "$D"/conf.d/*.conf; do [ -f "$f" ] && emit confd "$f" 1; done
for f in "$D"/conf.d/*.conf.disabled; do [ -f "$f" ] && emit confd "$f" 0; done
exit 0`.replace(/\$\{NGINX_DIR\}/g, NGINX_DIR);

export function parseNginxFiles(out: string): RawFile[] {
  const files: RawFile[] = [];
  let cur: RawFile | null = null; let buf: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('@@FILE|')) { const [, kind, path, en] = line.split('|'); cur = { kind: kind as FileKind, path, enabled: en === '1', content: '' }; buf = []; }
    else if (line === '@@END' && cur) { cur.content = buf.join('\n').replace(/\n+$/, '\n'); files.push(cur); cur = null; }
    else if (cur) buf.push(line.replace(/\r$/, ''));
  }
  return files;
}

// ------------------------------------------------------------------ analizador de la sintaxis de nginx
export interface Node { name: string; args: string[]; children?: Node[]; }

function tokenize(src: string): string[] {
  const t: string[] = [];
  let i = 0, w = '';
  const flush = () => { if (w) { t.push(w); w = ''; } };
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { flush(); while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") { // el contenido entre comillas es una sola palabra (se guarda sin comillas)
      const q = c; i++; let s = '';
      while (i < src.length && src[i] !== q) { if (src[i] === '\\' && i + 1 < src.length) { s += src[i + 1]; i += 2; } else s += src[i++]; }
      i++; w += s; continue;
    }
    if (/\s/.test(c)) { flush(); i++; continue; }
    if (c === ';' || ((c === '{' || c === '}') && !w.endsWith('$'))) { flush(); t.push(c); i++; continue; }
    w += c; i++;
  }
  flush();
  return t;
}

export function parseNginx(src: string): Node[] {
  const toks = tokenize(src);
  let p = 0;
  const block = (): Node[] => {
    const out: Node[] = [];
    while (p < toks.length) {
      if (toks[p] === '}') { p++; return out; }
      const words: string[] = [];
      while (p < toks.length && toks[p] !== ';' && toks[p] !== '{' && toks[p] !== '}') words.push(toks[p++]);
      if (p >= toks.length) break;
      const end = toks[p];
      if (end === ';') { p++; if (words.length) out.push({ name: words[0], args: words.slice(1) }); }
      else if (end === '{') { p++; out.push({ name: words[0] ?? '', args: words.slice(1), children: block() }); }
      else { if (words.length) out.push({ name: words[0], args: words.slice(1) }); }   // «}» sin «;» previo
    }
    return out;
  };
  return block();
}

export interface Listen { raw: string; port: number; ssl: boolean; isDefault: boolean; }
export interface Loc { path: string; proxy?: string; root?: string; ret?: string; }
export interface NginxServer {
  names: string[]; listens: Listen[]; ssl: boolean; certs: string[]; root: string; locations: Loc[];
  kind: 'proxy' | 'static' | 'redirect' | 'other'; target: string; httpsRedirect: boolean;
}

const find = (n: Node[], name: string) => n.filter((x) => x.name === name);

/** Servidores («server { … }») de un archivo, con lo que importa para verlos: dominios, puertos, SSL y destino. */
export function extractServers(src: string): NginxServer[] {
  const tree = parseNginx(src);
  const upstreams = new Map<string, string>();
  const servers: Node[] = [];
  const walk = (nodes: Node[]) => { for (const n of nodes) { if (n.name === 'upstream' && n.children) upstreams.set(n.args[0], find(n.children, 'server').map((s) => s.args[0]).join(', ')); else if (n.name === 'server' && n.children) servers.push(n); else if (n.children && (n.name === 'http' || n.name === '')) walk(n.children); } };
  walk(tree);
  return servers.map((s) => {
    const c = s.children!;
    const names = find(c, 'server_name').flatMap((d) => d.args);
    const listens = find(c, 'listen').map((l) => { const a = l.args[0] ?? ''; const m = a.match(/(\d+)$/); return { raw: l.args.join(' '), port: m ? Number(m[1]) : 80, ssl: l.args.includes('ssl') || /(^|:)443$/.test(a), isDefault: l.args.includes('default_server') || l.args.includes('default') }; });
    const certs = find(c, 'ssl_certificate').map((d) => d.args[0]);
    const locations: Loc[] = find(c, 'location').map((l) => {
      const lc = l.children ?? [];
      const pp = find(lc, 'proxy_pass')[0] ?? find(lc, 'fastcgi_pass')[0] ?? find(lc, 'uwsgi_pass')[0] ?? find(lc, 'grpc_pass')[0];
      const r = find(lc, 'return')[0];
      return { path: l.args.join(' '), proxy: pp?.args[0], root: (find(lc, 'root')[0] ?? find(lc, 'alias')[0])?.args[0], ret: r ? r.args.join(' ') : undefined };
    });
    const root = find(c, 'root')[0]?.args[0] ?? '';
    const ret = find(c, 'return')[0];
    const redirect = ret && /^3\d\d$/.test(ret.args[0] ?? '') ? ret.args.slice(1).join(' ') : '';
    const proxyLoc = locations.find((l) => l.path === '/' && l.proxy) ?? locations.find((l) => l.proxy);
    const serverProxy = find(c, 'proxy_pass')[0]?.args[0];
    const resolve = (u: string) => { const m = u.match(/^https?:\/\/([^/:]+)\/?$/); return m && upstreams.has(m[1]) ? `${u} → ${upstreams.get(m[1])}` : u; };
    let kind: NginxServer['kind'] = 'other', target = '';
    if (proxyLoc?.proxy || serverProxy) { kind = 'proxy'; target = resolve((proxyLoc?.proxy ?? serverProxy)!); }
    else if (redirect) { kind = 'redirect'; target = redirect; }
    else if (root || locations.some((l) => l.root)) { kind = 'static'; target = root || locations.find((l) => l.root)!.root!; }
    const httpsRedirect = !!redirect && redirect.startsWith('https://') || locations.some((l) => /^3\d\d\s+https:\/\//.test(l.ret ?? ''));
    return { names, listens, ssl: listens.some((l) => l.ssl) || certs.length > 0, certs, root, locations, kind, target, httpsRedirect };
  });
}

export interface NginxSite { file: RawFile; name: string; servers: NginxServer[]; }

export const siteName = (path: string) => path.split('/').pop()!.replace(/\.disabled$/, '').replace(/\.conf$/, '');

export function buildSites(files: RawFile[]): NginxSite[] {
  return files.map((f) => ({ file: f, name: siteName(f.path), servers: extractServers(f.content) }));
}

// ------------------------------------------------------------------ plantillas de sitios nuevos
export interface NewSite { names: string[]; type: 'proxy' | 'static' | 'redirect'; target: string; spa: boolean; /** Escuchar también en IPv6 (solo si el servidor lo soporta: si no, nginx -t falla). */ ipv6?: boolean; }

export const DOMAIN_RE = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function validateNewSite(s: NewSite): string | null {
  if (!s.names.length) return 'Indica al menos un dominio.';
  for (const n of s.names) if (!(DOMAIN_RE.test(n) || n === '_')) return `Dominio no válido: «${n}».`;
  const t = s.target.trim();
  if (s.type === 'proxy' && !/^(https?:\/\/)?[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(t) && !/^https?:\/\/unix:\/[A-Za-z0-9._\/-]+:\/?$/.test(t)) return 'Destino del proxy no válido. Ejemplos: 127.0.0.1:3000 · http://localhost:8080 · https://servicio.interno';
  if (s.type === 'static' && !/^\/[A-Za-z0-9._\/-]*$/.test(t)) return 'La carpeta debe ser una ruta absoluta sin espacios (por ejemplo /var/www/mi-sitio).';
  if (s.type === 'redirect' && !/^https?:\/\/[A-Za-z0-9._:\/-]+$/.test(t)) return 'El destino de la redirección debe empezar por http:// o https://';
  return null;
}

export function buildSiteConfig(s: NewSite): string {
  const err = validateNewSite(s);
  if (err) throw new Error(err);
  const names = s.names.join(' '), t = s.target.trim();
  const head = `server {\n    listen 80;\n${s.ipv6 === false ? '' : '    listen [::]:80;\n'}    server_name ${names};\n`;
  if (s.type === 'proxy') {
    const url = /^https?:\/\//.test(t) ? t : 'http://' + t;
    return head + `\n    location / {\n        proxy_pass ${url};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n`;
  }
  if (s.type === 'static') return head + `\n    root ${t};\n    index index.html index.htm;\n\n    location / {\n        try_files $uri $uri/ ${s.spa ? '/index.html' : '=404'};\n    }\n}\n`;
  return head + `\n    return 301 ${t.replace(/\/+$/, '')}$request_uri;\n}\n`;
}

export function fileNameFor(names: string[]): string {
  return (names[0] ?? 'sitio').toLowerCase().replace(/^\*\./, 'wildcard.').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'sitio';
}

// ------------------------------------------------------------------ scripts con privilegios
/**
 * Con sudo que pide contraseña, la primera línea de la entrada estándar es la contraseña (nunca va en la línea de comandos).
 * `S` ejecuta un comando como root: directamente si ya lo es, con `sudo -n` si no pide contraseña, o alimentando `sudo -S`.
 */
export const SUDO_PRELUDE = String.raw`export LC_ALL=C
__PW=""
S() { if [ "$(id -u)" = 0 ]; then "$@"; elif [ -n "$__PW" ]; then printf '%s\n' "$__PW" | sudo -S -p '' "$@"; else sudo -n "$@"; fi; }
if [ "$(id -u)" != 0 ] && ! sudo -n true 2>/dev/null; then
  IFS= read -r __PW
  if ! printf '%s\n' "$__PW" | sudo -S -p '' true >/dev/null 2>&1; then echo "SUDO_FAIL"; exit 9; fi
fi
`;

const BK = `${NGINX_DIR}/arkpm-backups`;
const reloadCmd = (bin: string) => `S ${sq(bin)} -s reload 2>/dev/null || S systemctl reload nginx 2>/dev/null || S service nginx reload 2>/dev/null`;

export function ctlScript(bin: string, action: 'start' | 'stop' | 'restart' | 'reload'): string {
  const cmds = {
    start: `S systemctl start nginx 2>/dev/null || S service nginx start 2>/dev/null || S ${sq(bin)}`,
    stop: `S systemctl stop nginx 2>/dev/null || S service nginx stop 2>/dev/null || S ${sq(bin)} -s stop`,
    restart: `S systemctl restart nginx 2>/dev/null || S service nginx restart 2>/dev/null || { S ${sq(bin)} -s stop; sleep 1; S ${sq(bin)}; }`,
    reload: reloadCmd(bin),
  }[action];
  return SUDO_PRELUDE + `OUT=$({ ${cmds}; } 2>&1); RC=$?\nsleep 0.8\nif pgrep -x nginx >/dev/null 2>&1; then echo "RESULT=active"; else echo "RESULT=inactive"; fi\necho "RC=$RC"\necho "$OUT" | tail -5\n`;
}

export const testScript = (bin: string): string => SUDO_PRELUDE + `OUT=$(S ${sq(bin)} -t 2>&1); RC=$?\nif [ $RC -eq 0 ]; then echo TEST_OK; else echo TEST_FAIL; fi\necho "$OUT"\n`;

/**
 * Instala `tmp` (subido antes por SFTP) como `dest` con copia de seguridad, prueba la configuración y la REVIERTE si falla.
 * Con `link` también crea el enlace de sites-enabled (alta de un sitio nuevo).
 */
export function installScript(bin: string, tmp: string, dest: string, o: { link?: string; reload: boolean }): string {
  const link = o.link ? sq(o.link) : '';
  return SUDO_PRELUDE + [
    `BK=${sq(BK)}; F=${sq(dest)}; TMP=${sq(tmp)}; TS=$(date +%Y%m%d-%H%M%S); HAD=0; MADE_LINK=0`,
    'S mkdir -p "$BK"',
    'if [ -e "$F" ]; then HAD=1; S cp -a "$F" "$BK/$(basename "$F").$TS" || { echo BACKUP_FAIL; exit 5; }; fi',
    'S install -m 644 -o root -g root "$TMP" "$F" || { echo INSTALL_FAIL; exit 6; }',
    ...(link ? [`if [ ! -e ${link} ]; then S ln -s "$F" ${link} && MADE_LINK=1; fi`] : []),
    `if ! OUT=$(S ${sq(bin)} -t 2>&1); then`,
    '  if [ "$HAD" = 1 ]; then S cp -a "$BK/$(basename "$F").$TS" "$F"; else S rm -f "$F"; fi',
    ...(link ? [`  [ "$MADE_LINK" = 1 ] && S rm -f ${link}`] : []),
    '  echo TEST_FAIL; echo "$OUT"; rm -f "$TMP"; exit 4',
    'fi',
    'rm -f "$TMP"',
    ...(o.reload ? [reloadCmd(bin) + ' ; echo RELOADED'] : []),
    'echo OK',
  ].join('\n') + '\n';
}

/** Habilitar / deshabilitar según el tipo de archivo. Debian: enlace en sites-enabled; conf.d: renombrar a .disabled. */
export function toggleScript(bin: string, kind: FileKind, path: string, enable: boolean): string {
  const name = path.split('/').pop()!;
  let act: string, undo: string;
  if (kind === 'available') {
    const link = `${NGINX_DIR}/sites-enabled/${name}`;
    act = enable ? `S ln -sf ${sq(path)} ${sq(link)}` : `S rm -f ${sq(link)}`;
    undo = enable ? `S rm -f ${sq(link)}` : `S ln -sf ${sq(path)} ${sq(link)}`;
  } else if (kind === 'confd') {
    const on = path.replace(/\.disabled$/, ''), off = on + '.disabled';
    act = enable ? `S mv ${sq(off)} ${sq(on)}` : `S mv ${sq(on)} ${sq(off)}`;
    undo = enable ? `S mv ${sq(on)} ${sq(off)}` : `S mv ${sq(off)} ${sq(on)}`;
  } else {
    const dst = `${NGINX_DIR}/sites-available/${name}`;
    act = enable ? `S mv ${sq(dst)} ${sq(path)}` : `S mv ${sq(path)} ${sq(dst)}`;
    undo = enable ? `S mv ${sq(path)} ${sq(dst)}` : `S mv ${sq(dst)} ${sq(path)}`;
  }
  return SUDO_PRELUDE + `${act} || { echo ACTION_FAIL; exit 6; }\nif ! OUT=$(S ${sq(bin)} -t 2>&1); then ${undo}; echo TEST_FAIL; echo "$OUT"; exit 4; fi\n${reloadCmd(bin)}\necho OK\n`;
}

export function deleteScript(bin: string, kind: FileKind, path: string): string {
  const name = path.split('/').pop()!;
  const extra = kind === 'available' ? `S rm -f ${sq(`${NGINX_DIR}/sites-enabled/${name}`)}` : ':';
  return SUDO_PRELUDE + [
    `BK=${sq(BK)}; F=${sq(path)}; TS=$(date +%Y%m%d-%H%M%S)`,
    'S mkdir -p "$BK"', 'S cp -a "$F" "$BK/$(basename "$F").$TS" || { echo BACKUP_FAIL; exit 5; }',
    `S rm -f "$F"; ${extra}`,
    `if ! OUT=$(S ${sq(bin)} -t 2>&1); then S cp -a "$BK/$(basename "$F").$TS" "$F"; ${kind === 'available' ? `S ln -sf "$F" ${sq(`${NGINX_DIR}/sites-enabled/${name}`)}` : ':'}; echo TEST_FAIL; echo "$OUT"; exit 4; fi`,
    reloadCmd(bin), 'echo OK',
  ].join('\n') + '\n';
}

export const logScript = (kind: 'error' | 'access', lines: number): string =>
  SUDO_PRELUDE + `S tail -n ${Math.max(10, Math.min(2000, Math.floor(lines)))} ${sq(`/var/log/nginx/${kind}.log`)} 2>&1\n`;

export function certInfoScript(paths: string[]): string {
  return SUDO_PRELUDE + paths.map((p) => `E=$(S openssl x509 -noout -enddate -in ${sq(p)} 2>/dev/null | cut -d= -f2); echo "CERT|${p.replace(/[|\n]/g, '')}|$E"`).join('\n') + '\nexit 0\n';
}

export function parseCerts(out: string): Map<string, Date | null> {
  const m = new Map<string, Date | null>();
  for (const l of out.split('\n')) { if (!l.startsWith('CERT|')) continue; const [, path, end] = l.trim().split('|'); const d = end ? new Date(end.replace(/ GMT$/, ' UTC')) : null; m.set(path, d && !isNaN(d.getTime()) ? d : null); }
  return m;
}

export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export function certbotScript(domains: string[], email: string): string {
  if (!EMAIL_RE.test(email)) throw new Error('Correo no válido.');
  for (const d of domains) if (!DOMAIN_RE.test(d) || d.startsWith('*')) throw new Error(`Dominio no válido para el certificado: «${d}».`);
  return SUDO_PRELUDE + `S certbot --nginx ${domains.map((d) => '-d ' + sq(d)).join(' ')} --non-interactive --agree-tos -m ${sq(email)} --redirect 2>&1\necho "RC=$?"\n`;
}
