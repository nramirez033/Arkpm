import { Injectable, inject, signal } from '@angular/core';
import { DialogService } from './dialog.service';
import { Secret, ServerProfile } from './models';
import { wrap } from './remote';
import { StoreService } from './store.service';
import { ExecResult, ProgressEvent, StreamEvent, TRANSPORT, UploadItem } from './transport';

export type ConnState = 'disconnected' | 'connecting' | 'connected' | 'error';
interface Live { sessionId: string; home: string; }
export interface StreamHandle { stop(): void; done: Promise<number | null>; }

/** Sesiones SSH por servidor: conexión, huella del servidor, credenciales, reconexión y envoltorio de comandos. */
@Injectable({ providedIn: 'root' })
export class ConnectionService {
  private readonly t = inject(TRANSPORT);
  private readonly store = inject(StoreService);
  private readonly dialogs = inject(DialogService);

  readonly states = signal<Record<string, ConnState>>({});
  readonly errors = signal<Record<string, string>>({});
  private live = new Map<string, Live>();
  private connecting = new Map<string, Promise<Live>>();
  /** Credenciales que el usuario no quiso guardar: solo viven mientras la app está abierta. */
  private mem = new Map<string, Secret>();
  private handlers = new Map<string, (e: StreamEvent) => void>();
  private early = new Map<string, StreamEvent[]>();

  constructor() {
    this.t.onClosed((sid) => {
      for (const [pid, l] of this.live) if (l.sessionId === sid) { this.live.delete(pid); this.setState(pid, 'disconnected'); }
    });
    this.t.onStream((e) => {
      const h = this.handlers.get(e.streamId);
      if (h) h(e);
      else { const a = this.early.get(e.streamId) ?? []; if (a.length < 500) a.push(e); this.early.set(e.streamId, a); }
    });
  }

  get kind() { return this.t.kind; }
  get canPickFolder() { return this.t.canPickFolder; }
  state(profileId: string): ConnState { return this.states()[profileId] ?? 'disconnected'; }
  error(profileId: string): string { return this.errors()[profileId] ?? ''; }
  isConnected(profileId: string) { return this.live.has(profileId); }
  home(profileId: string) { return this.live.get(profileId)?.home ?? ''; }
  onProgress(cb: (e: ProgressEvent) => void) { return this.t.onProgress(cb); }

  private setState(id: string, s: ConnState, err = '') {
    this.states.update((m) => ({ ...m, [id]: s }));
    this.errors.update((m) => ({ ...m, [id]: err }));
  }
  private profile(id: string): ServerProfile {
    const p = this.store.profiles().find((x) => x.id === id);
    if (!p) throw new Error('El servidor ya no existe');
    return p;
  }

  // ---------------------------------------------------------------- conexión
  async loadSecret(p: ServerProfile): Promise<Secret> {
    const m = this.mem.get(p.id);
    if (m) return m;
    try { const raw = await this.t.secretLoad(p.id); if (raw) return JSON.parse(raw) as Secret; } catch { /* sin almacén seguro */ }
    return {};
  }
  async saveSecret(p: ServerProfile, s: Secret) {
    if (p.remember || (p.auth === 'key' && s.privateKey)) {
      const keep: Secret = { privateKey: s.privateKey, ...(p.remember ? { password: s.password, passphrase: s.passphrase } : {}) };
      await this.t.secretSave(p.id, JSON.stringify(keep));
    }
  }
  async forgetSecret(id: string) { this.mem.delete(id); try { await this.t.secretDelete(id); } catch { /* nada */ } }

  /** Conecta (o devuelve la sesión viva). Con `interactive` puede preguntar contraseña y confirmar la huella del servidor. */
  connect(profileId: string, interactive = true): Promise<Live> {
    const live = this.live.get(profileId);
    if (live) return Promise.resolve(live);
    let p = this.connecting.get(profileId);
    if (!p) {
      p = this.doConnect(this.profile(profileId), interactive).finally(() => this.connecting.delete(profileId));
      this.connecting.set(profileId, p);
    }
    return p;
  }

  private async doConnect(p: ServerProfile, interactive: boolean): Promise<Live> {
    this.setState(p.id, 'connecting');
    try {
      // Primero se verifica el servidor (sin enviar credenciales): así nunca se pide ni se envía la contraseña a un equipo no confiable.
      if (!this.store.getPin(p.host, p.port)) {
        const probe = await this.t.connect({ host: p.host, port: p.port, username: p.username, expectedFingerprint: null });
        if (probe.ok) await this.t.disconnect(probe.sessionId).catch(() => { /* nada */ });
        else if (probe.code === 'HOSTKEY_UNKNOWN') {
          if (!interactive) throw new Error('Servidor no verificado todavía: conecta manualmente desde la lista de servidores');
          if (!(await this.dialogs.hostKey(p, probe.fingerprint ?? '', false))) throw new Error('Conexión cancelada: no se confió en la huella del servidor');
          await this.store.setPin(p.host, p.port, probe.fingerprint ?? '');
        } else if (probe.code === 'NETWORK') throw new Error(probe.message);
      }
      let secret = await this.loadSecret(p);
      for (let attempt = 0; attempt < 5; attempt++) {
        if (p.auth === 'password' && !secret.password) {
          const a = interactive ? await this.dialogs.secret(p, 'password', attempt > 0) : null;
          if (!a) throw new Error(interactive ? 'Conexión cancelada' : 'Falta la contraseña: conecta manualmente desde la lista de servidores');
          secret = { ...secret, password: a.value };
          this.mem.set(p.id, secret);
          if (a.remember && !p.remember) { p = { ...p, remember: true }; await this.store.saveProfile(p); }
        }
        if (p.auth === 'key' && !secret.privateKey) throw new Error('Este servidor no tiene clave privada guardada: edítalo y pégala de nuevo');
        const r = await this.t.connect({
          host: p.host, port: p.port, username: p.username,
          password: p.auth === 'password' ? secret.password : undefined,
          privateKey: p.auth === 'key' ? secret.privateKey : undefined,
          passphrase: p.auth === 'key' ? secret.passphrase : undefined,
          expectedFingerprint: this.store.getPin(p.host, p.port),
        });
        if (r.ok) {
          const home = await this.homeOf(r.sessionId);
          const l = { sessionId: r.sessionId, home };
          this.live.set(p.id, l);
          this.mem.set(p.id, secret);
          await this.saveSecret(p, secret).catch(() => { /* sin almacén seguro: no se recuerda */ });
          this.setState(p.id, 'connected');
          return l;
        }
        if (r.code === 'HOSTKEY_UNKNOWN' || r.code === 'HOSTKEY_CHANGED') {
          if (!interactive) throw new Error(r.code === 'HOSTKEY_CHANGED' ? 'La huella del servidor cambió' : 'Servidor no verificado todavía');
          const yes = await this.dialogs.hostKey(p, r.fingerprint ?? '', r.code === 'HOSTKEY_CHANGED');
          if (!yes) throw new Error('Conexión cancelada: no se confió en la huella del servidor');
          await this.store.setPin(p.host, p.port, r.fingerprint ?? '');
          continue;
        }
        if (r.code === 'AUTH_FAILED' && p.auth === 'password' && interactive) { secret = { ...secret, password: undefined }; this.mem.delete(p.id); continue; }
        if (r.code === 'KEY_PASSPHRASE' && interactive) {
          const a = await this.dialogs.secret(p, 'passphrase', !!secret.passphrase);
          if (!a) throw new Error('Conexión cancelada');
          secret = { ...secret, passphrase: a.value };
          continue;
        }
        throw new Error(r.message);
      }
      throw new Error('No se pudo conectar');
    } catch (e: any) {
      this.setState(p.id, 'error', String(e?.message ?? e));
      throw e;
    }
  }

  private async homeOf(sessionId: string): Promise<string> {
    const r = await this.t.exec(sessionId, 'echo "$HOME"', { timeoutMs: 15000 });
    return r.stdout.trim() || '/';
  }

  async disconnect(profileId: string) {
    const l = this.live.get(profileId);
    this.live.delete(profileId);
    this.setState(profileId, 'disconnected');
    if (l) await this.t.disconnect(l.sessionId).catch(() => { /* ya cerrada */ });
  }

  /** Prueba credenciales sin guardar nada (botón «Probar conexión» del formulario). */
  async test(p: ServerProfile, s: Secret): Promise<{ ok: boolean; message: string; needsTrust?: string }> {
    const r = await this.t.connect({ host: p.host, port: p.port, username: p.username, password: p.auth === 'password' ? s.password : undefined, privateKey: p.auth === 'key' ? s.privateKey : undefined, passphrase: p.auth === 'key' ? s.passphrase : undefined, expectedFingerprint: this.store.getPin(p.host, p.port) });
    if (r.ok) { await this.t.disconnect(r.sessionId).catch(() => { /* nada */ }); return { ok: true, message: 'Conexión correcta' }; }
    if (r.code === 'HOSTKEY_UNKNOWN') return { ok: false, message: 'Servidor nuevo: se pedirá confirmar su huella al conectar', needsTrust: r.fingerprint ?? '' };
    return { ok: false, message: r.message };
  }

  // ---------------------------------------------------------------- operaciones
  private async sid(profileId: string): Promise<string> { return (await this.connect(profileId)).sessionId; }

  /** Ejecuta con reconexión automática (una vez) si la sesión se cerró. */
  private async withSession<T>(profileId: string, fn: (sid: string) => Promise<T>): Promise<T> {
    try { return await fn(await this.sid(profileId)); }
    catch (e: any) {
      if (!/Sesión SSH cerrada|closed|not connected/i.test(String(e?.message))) throw e;
      this.live.delete(profileId);
      return await fn(await this.sid(profileId));
    }
  }

  /** Script de shell en un bash de login (PATH y nvm cargados). */
  run(profileId: string, script: string, o?: { timeoutMs?: number; stdin?: string }): Promise<ExecResult> {
    const init = this.profile(profileId).shellInit;
    return this.withSession(profileId, (sid) => this.t.exec(sid, wrap(script, init), o));
  }

  /** Igual que run pero en streaming (instalaciones, logs): devuelve un manejador para parar y esperar el final. */
  async stream(profileId: string, script: string, onData: (text: string) => void, o?: { pty?: boolean; raw?: boolean }): Promise<StreamHandle> {
    const init = this.profile(profileId).shellInit;
    const cmd = o?.raw ? script : wrap(script, init);
    const sid = await this.sid(profileId);
    const streamId = await this.t.streamStart(sid, cmd, { pty: !!o?.pty });
    let resolve!: (c: number | null) => void;
    const done = new Promise<number | null>((r) => (resolve = r));
    const handle = (e: StreamEvent) => {
      if (e.kind === 'data') onData(e.data ?? '');
      else { this.handlers.delete(streamId); this.early.delete(streamId); resolve(e.code ?? null); }
    };
    this.handlers.set(streamId, handle);
    for (const e of this.early.get(streamId) ?? []) handle(e);
    this.early.delete(streamId);
    return { stop: () => { this.t.streamStop(streamId).catch(() => { /* ya terminó */ }); }, done };
  }

  list(profileId: string, path: string) { return this.withSession(profileId, (sid) => this.t.list(sid, path)); }
  stat(profileId: string, path: string) { return this.withSession(profileId, (sid) => this.t.stat(sid, path)); }
  readFile(profileId: string, path: string, max: number) { return this.withSession(profileId, (sid) => this.t.readFile(sid, path, max)); }
  writeFile(profileId: string, path: string, b64: string) { return this.withSession(profileId, (sid) => this.t.writeFile(sid, path, b64)); }
  uploadMany(profileId: string, jobId: string, items: UploadItem[]) { return this.withSession(profileId, (sid) => this.t.uploadMany(sid, jobId, items)); }
  download(profileId: string, jobId: string, remote: string, destDir: string, name: string) { return this.withSession(profileId, (sid) => this.t.download(sid, jobId, remote, destDir, name)); }
  cancelJob(jobId: string) { return this.t.cancelJob(jobId); }
  pickFiles(o?: { multi?: boolean }) { return this.t.pickFiles(o); }
  pickFolder() { return this.t.pickFolder(); }
  walkLocal(root: string, rules: string[]) { return this.t.walkLocal(root, rules); }
  pickSaveDir() { return this.t.pickSaveDir(); }
  showSaved(path: string) { return this.t.showSaved(path); }
}
