// Capa SSH/SFTP del proceso principal de Electron (ssh2). No depende de Electron: se puede probar con Node.
// Todas las operaciones devuelven datos simples serializables por IPC.
'use strict';
const { Client } = require('ssh2');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { compileRules } = require('./rules');

const MAX_EXEC_OUTPUT = 32 * 1024 * 1024;
const fpFromHex = (hex) => 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
/** Comilla simple segura para shell. */
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function friendly(e) {
  const m = String((e && e.message) || e);
  if (e && e.level === 'client-authentication') return 'Usuario o credenciales incorrectos';
  if (/ECONNREFUSED/.test(m)) return 'Conexión rechazada: ¿está activo el servidor SSH y es correcto el puerto?';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'No se encontró el servidor (revisa el nombre o la IP)';
  if (/ETIMEDOUT|Timed out|EHOSTUNREACH|ENETUNREACH/.test(m)) return 'El servidor no responde (tiempo agotado o sin ruta)';
  if (/passphrase/i.test(m)) return 'La clave privada está cifrada: indica su frase de contraseña';
  if (/Cannot parse privateKey|Unsupported key format/i.test(m)) return 'No se pudo leer la clave privada (formato no soportado)';
  return m;
}

class SshManager {
  /** @param {(channel: string, ...args: any[]) => void} emit */
  constructor(emit) {
    this.emit = emit || (() => {});
    this.sessions = new Map();
    this.streams = new Map();
    this.jobs = new Map();
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s || s.closed) throw new Error('Sesión SSH cerrada. Vuelve a conectar.');
    return s;
  }

  // ---------------------------------------------------------------- conexión
  connect(o) {
    return new Promise((resolve) => {
      const conn = new Client();
      let seen = null, issue = null, done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      conn.on('ready', () => {
        const id = crypto.randomUUID();
        const s = { id, conn, closed: false, sftp: null };
        this.sessions.set(id, s);
        conn.on('close', () => { s.closed = true; this.sessions.delete(id); this._dropStreams(id); this.emit('ssh:closed', id); });
        conn.on('error', () => { /* el cierre se avisa por 'close' */ });
        finish({ ok: true, sessionId: id, fingerprint: seen });
      });
      conn.on('error', (e) => {
        if (issue) return finish({ ok: false, code: issue, fingerprint: seen, message: issue === 'HOSTKEY_CHANGED' ? 'La huella del servidor cambió' : 'Servidor desconocido' });
        const m = String(e && e.message || e);
        const code = e && e.level === 'client-authentication' ? 'AUTH_FAILED' : /passphrase/i.test(m) ? 'KEY_PASSPHRASE' : 'NETWORK';
        finish({ ok: false, code, message: friendly(e) });
      });
      if (o.password) conn.on('keyboard-interactive', (_n, _i, _l, prompts, reply) => reply(prompts.map(() => o.password)));
      try {
        conn.connect({
          host: o.host, port: Number(o.port) || 22, username: o.username,
          password: o.password || undefined,
          privateKey: o.privateKey || undefined, passphrase: o.passphrase || undefined,
          tryKeyboard: !!o.password,
          readyTimeout: 15000, keepaliveInterval: 15000, keepaliveCountMax: 4,
          hostHash: 'sha256',
          hostVerifier: (hex) => {
            seen = fpFromHex(hex);
            if (o.expectedFingerprint && o.expectedFingerprint === seen) return true;
            issue = o.expectedFingerprint ? 'HOSTKEY_CHANGED' : 'HOSTKEY_UNKNOWN';
            return false;
          },
        });
      } catch (e) {
        finish({ ok: false, code: /passphrase/i.test(String(e.message)) ? 'KEY_PASSPHRASE' : 'NETWORK', message: friendly(e) });
      }
    });
  }

  disconnect(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this._dropStreams(id);
    try { s.conn.end(); } catch { /* ya cerrada */ }
  }
  disconnectAll() { for (const id of [...this.sessions.keys()]) this.disconnect(id); }

  // ---------------------------------------------------------------- comandos
  exec(id, cmd, { timeoutMs = 60000, stdin } = {}) {
    const s = this.get(id);
    return new Promise((resolve, reject) => {
      s.conn.exec(cmd, (err, ch) => {
        if (err) return reject(err);
        const out = [], er = [];
        let size = 0, timer = null, finished = false;
        const grab = (arr) => (d) => { size += d.length; if (size <= MAX_EXEC_OUTPUT) arr.push(d); };
        ch.on('data', grab(out));
        ch.stderr.on('data', grab(er));
        ch.on('close', (code, signal) => {
          if (finished) return;
          finished = true; clearTimeout(timer);
          resolve({ code: code == null ? (signal ? 128 : 0) : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(er).toString('utf8') });
        });
        if (timeoutMs) timer = setTimeout(() => { if (finished) return; finished = true; try { ch.close(); } catch { /* nada */ } reject(new Error('Tiempo de espera agotado')); }, timeoutMs);
        ch.end(stdin == null ? undefined : stdin);
      });
    });
  }

  /** Comando de larga duración (logs en vivo, instalaciones…). Con pty, al cerrar el canal el proceso remoto recibe SIGHUP. */
  streamStart(id, cmd, { pty = false } = {}) {
    const s = this.get(id);
    return new Promise((resolve, reject) => {
      s.conn.exec(cmd, { pty }, (err, ch) => {
        if (err) return reject(err);
        const streamId = crypto.randomUUID();
        const dec = new StringDecoder('utf8');
        let buf = '', timer = null;
        const flush = () => { timer = null; if (buf) { const b = buf; buf = ''; this.emit('ssh:stream', streamId, 'data', b); } };
        const push = (d) => { buf += dec.write(d); if (buf.length > 64 * 1024) { clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, 60); };
        ch.on('data', push);
        ch.stderr.on('data', push);
        ch.on('close', (code) => {
          clearTimeout(timer); buf += dec.end(); flush();
          this.streams.delete(streamId);
          this.emit('ssh:stream', streamId, 'close', code == null ? null : code);
        });
        this.streams.set(streamId, { ch, sessionId: id });
        resolve(streamId);
      });
    });
  }
  streamStop(streamId) {
    const st = this.streams.get(streamId);
    if (!st) return;
    try { st.ch.signal('KILL'); } catch { /* algunos servidores no lo admiten */ }
    try { st.ch.close(); } catch { /* nada */ }
  }
  _dropStreams(sessionId) { for (const [k, v] of this.streams) if (v.sessionId === sessionId) { try { v.ch.close(); } catch { /* nada */ } this.streams.delete(k); } }

  // ---------------------------------------------------------------- SFTP
  _openSftp(s) { return new Promise((res, rej) => s.conn.sftp((e, sftp) => (e ? rej(e) : res(sftp)))); }
  async _sftp(s) {
    if (s.sftp) return s.sftp;
    const sftp = await this._openSftp(s);
    sftp.on('close', () => { if (s.sftp === sftp) s.sftp = null; });
    s.sftp = sftp;
    return sftp;
  }
  static _p(sftp, fn, ...args) { return new Promise((res, rej) => sftp[fn](...args, (e, r) => (e ? rej(e) : res(r)))); }

  async list(id, dir) {
    const s = this.get(id), sftp = await this._sftp(s);
    const items = await SshManager._p(sftp, 'readdir', dir);
    const base = dir.endsWith('/') ? dir : dir + '/';
    const out = await Promise.all(items.filter((i) => i.filename !== '.' && i.filename !== '..').map(async (i) => {
      const a = i.attrs;
      let isDir = a.isDirectory(), isLink = a.isSymbolicLink(), size = a.size, mtime = a.mtime * 1000, mode = a.mode & 0o7777, broken = false;
      if (isLink) {
        try { const t = await SshManager._p(sftp, 'stat', base + i.filename); isDir = t.isDirectory(); size = t.size; } catch { broken = true; }
      }
      return { name: i.filename, isDir, isLink, size, mtime, mode, broken, owner: a.uid, group: a.gid };
    }));
    return out;
  }

  async stat(id, p) {
    const s = this.get(id), sftp = await this._sftp(s);
    try { const a = await SshManager._p(sftp, 'stat', p); return { exists: true, isDir: a.isDirectory(), size: a.size, mtime: a.mtime * 1000 }; }
    catch { return { exists: false }; }
  }

  async readFile(id, p, maxBytes = 1024 * 1024) {
    const s = this.get(id), sftp = await this._sftp(s);
    const st = await SshManager._p(sftp, 'stat', p);
    const want = Math.min(st.size, maxBytes);
    const chunks = [];
    await new Promise((resolve, reject) => {
      if (want === 0) return resolve();
      const rs = sftp.createReadStream(p, { start: 0, end: want - 1 });
      rs.on('data', (d) => chunks.push(d)); rs.on('end', resolve); rs.on('error', reject);
    });
    return { data: Buffer.concat(chunks).toString('base64'), size: st.size, truncated: st.size > maxBytes };
  }

  async writeFile(id, p, dataB64) {
    const s = this.get(id), sftp = await this._sftp(s);
    await SshManager._p(sftp, 'writeFile', p, Buffer.from(dataB64, 'base64'));
  }

  // ---------------------------------------------------------------- transferencias
  /** Sube una lista de archivos [{local, remote, size}] con varios canales SFTP en paralelo. */
  async uploadMany(id, jobId, items, { concurrency = 4 } = {}) {
    const s = this.get(id);
    const job = { cancelled: false, sftps: [] };
    this.jobs.set(jobId, job);
    const total = items.reduce((a, i) => a + (i.size || 0), 0);
    let loaded = 0, last = 0, current = '';
    const report = (force) => { const n = Date.now(); if (force || n - last > 120) { last = n; this.emit('ssh:progress', jobId, loaded, total, current); } };
    try {
      const dirs = [...new Set(items.map((i) => path.posix.dirname(i.remote)))];
      if (dirs.length) {
        const r = await this.exec(id, `bash -c ${sq('while IFS= read -r d; do mkdir -p -- "$d" || exit 1; done')}`, { stdin: dirs.join('\n') + '\n', timeoutMs: 120000 });
        if (r.code !== 0) throw new Error('No se pudieron crear las carpetas remotas: ' + (r.stderr || r.stdout).trim());
      }
      const n = Math.max(1, Math.min(concurrency, items.length));
      const sftps = [];
      for (let i = 0; i < n; i++) sftps.push(await this._openSftp(s));
      job.sftps = sftps;
      let idx = 0, failure = null;
      const worker = async (sftp) => {
        while (!job.cancelled && !failure) {
          const it = items[idx++];
          if (!it) return;
          current = it.remote;
          await new Promise((resolve, reject) => {
            let prev = 0;
            sftp.fastPut(it.local, it.remote, { concurrency: 16, chunkSize: 32768, step: (t) => { loaded += t - prev; prev = t; report(false); } }, (e) => {
              if (e) return reject(e);
              loaded += (it.size || 0) - prev; resolve();
            });
          }).catch((e) => { failure = failure || e; });
        }
      };
      await Promise.all(sftps.map(worker));
      if (job.cancelled) throw new Error('Cancelado');
      if (failure) throw failure;
      report(true);
    } finally {
      for (const x of job.sftps) { try { x.end(); } catch { /* nada */ } }
      this.jobs.delete(jobId);
    }
  }

  /** Descarga un archivo remoto a destDir/name (si existe, "name (1)"). Devuelve la ruta final. */
  async download(id, jobId, remote, destDir, name) {
    const s = this.get(id);
    const job = { cancelled: false, sftps: [] };
    this.jobs.set(jobId, job);
    let sftp;
    try {
      sftp = await this._openSftp(s);
      job.sftps.push(sftp);
      const st = await SshManager._p(sftp, 'stat', remote);
      await fsp.mkdir(destDir, { recursive: true });
      const ext = name.includes('.') ? name.slice(name.indexOf('.')) : '';
      const stem = ext ? name.slice(0, name.indexOf('.')) : name;
      let target = path.join(destDir, name), k = 1;
      while (fs.existsSync(target)) target = path.join(destDir, `${stem} (${k++})${ext}`);
      const part = target + '.part';
      let last = 0;
      await new Promise((resolve, reject) => {
        sftp.fastGet(remote, part, { concurrency: 16, chunkSize: 32768, step: (t, _c, total) => { const n = Date.now(); if (n - last > 120) { last = n; this.emit('ssh:progress', jobId, t, total, name); } } }, (e) => (e ? reject(e) : resolve()));
      });
      if (job.cancelled) throw new Error('Cancelado');
      await fsp.rename(part, target);
      this.emit('ssh:progress', jobId, st.size, st.size, name);
      return { path: target, size: st.size };
    } catch (e) {
      try { await fsp.rm(path.join(destDir, name) + '.part', { force: true }); } catch { /* nada */ }
      throw job.cancelled ? new Error('Cancelado') : e;
    } finally {
      try { sftp && sftp.end(); } catch { /* nada */ }
      this.jobs.delete(jobId);
    }
  }

  cancelJob(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return;
    j.cancelled = true;
    for (const x of j.sftps) { try { x.end(); } catch { /* nada */ } }
  }
}

// ---------------------------------------------------------------- archivos locales
/** Recorre una carpeta local aplicando reglas de exclusión; devuelve [{path (con /), size}]. */
async function walkLocal(root, rules = [], limit = 200000) {
  const test = compileRules(rules).test;
  const out = [];
  async function rec(rel) {
    if (out.length >= limit) return;
    let ents;
    try { ents = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (test(r)) continue;
      if (e.isDirectory()) await rec(r);
      else if (e.isFile()) {
        try { const st = await fsp.stat(path.join(root, r)); out.push({ path: r, size: st.size }); } catch { /* ilegible */ }
      }
    }
  }
  await rec('');
  return out;
}

module.exports = { SshManager, walkLocal, sq, fpFromHex };
