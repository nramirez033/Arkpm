// Vigilante de servidores (proceso principal de Electron): consulta `pm2 jlist` cada N segundos con sus propias
// sesiones SSH y avisa de inicios, detenciones, errores y pérdidas de conexión. Sigue funcionando con la ventana oculta.
// La lógica de eventos (diffApps) es pura y está replicada en android-native/kotlin/MonitorEngine.kt.
'use strict';

const ENV_INIT =
  'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; ' +
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"; ';

function wrapScript(script, init = '') {
  const full = ENV_INIT + (String(init).trim() ? String(init).trim() + '\n' : '') + script;
  return `bash -lc "$(printf %s ${Buffer.from(full, 'utf8').toString('base64')} | base64 -d)"`;
}

/** `pm2 jlist` puede ir precedido de avisos: se toma la línea que es el JSON. */
function extractJson(out) {
  const lines = String(out).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l === '[]' || l.startsWith('[{')) { try { return JSON.parse(l); } catch { /* sigue */ } }
  }
  throw new Error('PM2 no devolvió una lista válida: ' + String(out).trim().split('\n').slice(-2).join(' ').slice(0, 160));
}

/** Procesos de PM2 → { nombre: { status, restarts } } con las instancias de un mismo nombre agrupadas. */
function groupApps(procs) {
  const by = {};
  for (const p of procs) {
    const e = p.pm2_env || {};
    (by[p.name] = by[p.name] || []).push({ status: e.status, restarts: Number(e.restart_time || 0) });
  }
  const out = {};
  for (const [name, ps] of Object.entries(by)) {
    const on = ps.filter((p) => p.status === 'online').length;
    const status = on === ps.length ? 'online' : on > 0 ? 'partial'
      : ps.some((p) => p.status === 'errored') ? 'errored'
      : ps.some((p) => p.status === 'launching' || p.status === 'stopping' || p.status === 'waiting restart') ? 'launching' : 'stopped';
    out[name] = { status, restarts: ps.reduce((a, p) => a + p.restarts, 0) };
  }
  return out;
}

/**
 * Compara dos fotos del estado y devuelve los eventos. `merged` es la nueva línea base: los estados transitorios
 * («launching») no la cambian para no avisar de falsos positivos.
 */
function diffApps(prev, next) {
  const events = [], merged = {};
  for (const [name, n] of Object.entries(next)) {
    const p = prev[name];
    if (n.status === 'launching') { merged[name] = p || n; continue; }
    merged[name] = n;
    if (!p) {
      if (n.status === 'online') events.push({ kind: 'started', name, text: `«${name}» apareció en PM2 y está en línea` });
      else if (n.status === 'errored') events.push({ kind: 'errored', name, text: `«${name}» terminó con error` });
      continue;
    }
    if (p.status !== 'online' && n.status === 'online') events.push({ kind: 'started', name, text: `«${name}» se inició` });
    else if (p.status === 'online' && n.status === 'stopped') events.push({ kind: 'stopped', name, text: `«${name}» se detuvo` });
    else if (p.status !== 'errored' && n.status === 'errored') events.push({ kind: 'errored', name, text: `«${name}» terminó con error` });
    else if (p.status === 'online' && n.status === 'partial') events.push({ kind: 'errored', name, text: `«${name}» tiene instancias caídas` });
    else if (p.status === 'online' && n.status === 'online' && n.restarts > p.restarts) {
      const k = n.restarts - p.restarts;
      events.push({ kind: 'restart', name, text: `«${name}» se reinició inesperadamente${k > 1 ? ` (${k} veces)` : ''}` });
    }
  }
  for (const name of Object.keys(prev)) if (!(name in next)) events.push({ kind: 'stopped', name, text: `«${name}» ya no está registrada en PM2` });
  return { events, merged };
}

const EVENT_SETTING = { started: 'started', stopped: 'stopped', errored: 'errored', restart: 'errored', connection: 'connection' };

class Monitor {
  /**
   * @param {{ ssh: any, notify: (n: {title:string, body:string, serverId:string, app?:string}) => void,
   *           loadSecret: (id: string) => Promise<{password?:string, privateKey?:string, passphrase?:string}|null>, log?: Function }} o
   */
  constructor(o) {
    this.ssh = o.ssh; this.notify = o.notify; this.loadSecret = o.loadSecret; this.log = o.log || (() => {});
    this.cfg = { enabled: false, background: false, interval: 30, events: {}, servers: [] };
    this.states = new Map(); this.mutes = new Map(); this.lastRestartNotice = new Map();
    this.timer = null; this.running = false;
  }

  configure(cfg) {
    this.cfg = { enabled: !!cfg.enabled, background: !!cfg.background, interval: Math.max(1, Number(cfg.interval) || 30), events: cfg.events || {}, servers: cfg.servers || [] };
    const ids = new Set(this.cfg.servers.map((s) => s.id));
    for (const [id, st] of this.states) if (!ids.has(id)) { this._drop(st); this.states.delete(id); }
    for (const sv of this.cfg.servers) {          // si cambió el destino o las credenciales, se reinicia la sesión
      const st = this.states.get(sv.id), sig = [sv.host, sv.port, sv.username, sv.auth, sv.fingerprint].join('|');
      if (st && st.sig !== sig) { this._drop(st); this.states.delete(sv.id); }
    }
    this.stop();
    if (this.cfg.enabled && this.cfg.servers.some((s) => s.notify)) { this.running = true; this._schedule(500); }
  }

  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; }
  shutdown() { this.stop(); for (const st of this.states.values()) this._drop(st); this.states.clear(); }
  _drop(st) { if (st.sid) { try { this.ssh.disconnect(st.sid); } catch { /* nada */ } st.sid = null; } }
  _schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this._tick(), ms); }

  /** El usuario acaba de actuar sobre este servicio desde la app: no se avisa de lo que provoque. */
  mute(serverId, name, ms = 25000) { this.mutes.set(serverId + '|' + name, Date.now() + ms); }

  status() {
    return this.cfg.servers.map((s) => {
      const st = this.states.get(s.id);
      return { id: s.id, state: !s.notify ? 'off' : st ? st.state : 'pending', reason: st ? st.reason : '' };
    });
  }

  async _tick() {
    if (!this.running) return;
    for (const sv of this.cfg.servers) { if (!this.running) break; if (sv.notify) await this._poll(sv).catch((e) => this.log('poll', e.message)); }
    if (this.running) this._schedule(this.cfg.interval * 1000);
  }

  async pollOnce() { for (const sv of this.cfg.servers) if (sv.notify) await this._poll(sv); }

  _ev(kind) { return this.cfg.events[EVENT_SETTING[kind]] !== false; }

  _emit(sv, kind, name, text) {
    if (!this._ev(kind)) return;
    if (name) {
      const until = this.mutes.get(sv.id + '|' + name);
      if (until && until > Date.now()) return;
    }
    if (kind === 'restart') {   // un bucle de reinicios avisaría en cada revisión: como mucho una vez cada 5 minutos
      const k = sv.id + '|' + name, last = this.lastRestartNotice.get(k) || 0;
      if (Date.now() - last < 5 * 60 * 1000) return;
      this.lastRestartNotice.set(k, Date.now());
    }
    this.notify({ title: name ? `${sv.name} · ${name}` : sv.name, body: text, serverId: sv.id, app: name || undefined });
  }

  async _poll(sv) {
    let st = this.states.get(sv.id);
    if (!st) { st = { sid: null, up: false, wasDown: false, apps: null, state: 'pending', reason: '', authNotified: false, sig: [sv.host, sv.port, sv.username, sv.auth, sv.fingerprint].join('|') }; this.states.set(sv.id, st); }
    try {
      if (!st.sid) {
        if (!sv.fingerprint) { st.state = 'skipped'; st.reason = 'Servidor sin verificar: conéctate una vez desde la app'; return; }
        const sec = (await this.loadSecret(sv.id)) || {};
        if (sv.auth === 'password' ? !sec.password : !sec.privateKey) { st.state = 'skipped'; st.reason = sv.auth === 'password' ? 'Guarda la contraseña en este equipo para vigilar este servidor' : 'Falta la clave privada guardada'; return; }
        const r = await this.ssh.connect({ host: sv.host, port: sv.port, username: sv.username, password: sv.auth === 'password' ? sec.password : undefined, privateKey: sv.auth === 'key' ? sec.privateKey : undefined, passphrase: sec.passphrase, expectedFingerprint: sv.fingerprint });
        if (!r.ok) {
          if (r.code !== 'NETWORK') {   // credenciales o huella: no se reintenta cada vez hasta que el usuario lo arregle
            st.state = 'skipped'; st.reason = r.message;
            if (!st.authNotified) { st.authNotified = true; this._emit(sv, 'connection', '', `No se pudo iniciar sesión: ${r.message}`); }
            return;
          }
          throw new Error(r.message);
        }
        st.sid = r.sessionId; st.authNotified = false;
      }
      const out = await this.ssh.exec(st.sid, wrapScript(`${sv.pm2Cmd || 'pm2'} jlist`, sv.shellInit), { timeoutMs: 25000 });
      let procs;
      try { procs = extractJson(out.stdout); }
      catch (e) { st.state = 'error'; st.reason = e.message; return; }   // la conexión está bien; PM2 no respondió
      if (!st.up) { st.up = true; if (st.wasDown) { st.wasDown = false; this._emit(sv, 'connection', '', 'Conexión restablecida'); } }
      const next = groupApps(procs);
      if (st.apps) {
        const { events, merged } = diffApps(st.apps, next);
        st.apps = merged;
        for (const e of events) this._emit(sv, e.kind, e.name, e.text);
      } else st.apps = next;   // primera lectura: línea base, sin avisos
      st.state = 'up'; st.reason = '';
    } catch (e) {
      this._drop(st);
      if (st.up) { st.up = false; st.wasDown = true; this._emit(sv, 'connection', '', 'Se perdió la conexión con el servidor'); }
      st.state = 'down'; st.reason = e.message;
    }
  }
}

module.exports = { Monitor, diffApps, groupApps, extractJson, wrapScript };
