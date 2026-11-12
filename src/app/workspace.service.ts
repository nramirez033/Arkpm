import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ConnectionService } from './connection.service';
import { AppConfig, AppNote, DEFAULT_CONFIG, Pm2Group, TrackedApp, uid } from './models';
import { SharedDataService, mergeShared, normalizeShared, stripDevice } from './shared-data.service';
import { Pm2Service, Pm2Verb } from './pm2.service';
import { ServerInfo, parseServerInfo, serverInfoScript, sharedDir } from './remote';
import { StoreService } from './store.service';
import { ToastService } from './dialog.service';

export type Tab = 'estado' | 'archivos' | 'deploy' | 'backup' | 'terminal' | 'notas' | 'logs';
/** Pantalla visible en móvil (en tableta y escritorio se muestran juntas). */
export type PhoneView = 'servers' | 'apps' | 'detail';
/** Pestaña de la vista de servidor en móvil (barra inferior). */
export type ServerTab = 'estado' | 'apps' | 'acciones' | 'nginx';

/** Estado de trabajo: servidor y app seleccionados, lista de PM2 en vivo y navegación. */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  readonly store = inject(StoreService);
  readonly conn = inject(ConnectionService);
  private readonly pm2 = inject(Pm2Service);
  private readonly toast = inject(ToastService);
  private readonly shared = inject(SharedDataService);

  readonly profileId = signal<string | null>(null);
  readonly appId = signal<string | null>(null);
  readonly tab = signal<Tab>('estado');
  readonly phoneView = signal<PhoneView>('servers');
  readonly serverTab = signal<ServerTab>('apps');
  readonly groups = signal<Pm2Group[]>([]);
  readonly loading = signal(false);
  readonly listError = signal('');
  readonly lastUpdate = signal(0);
  readonly busy = signal<string | null>(null);
  /**
   * Estado de las notas y la configuración compartidas en el servidor (`<carpeta de la app>/.arkpm`):
   * ok = se guardan allí · readonly/unavailable = sin permiso de escritura (solo en este dispositivo) · offline = sin conexión.
   */
  readonly sharedState = signal<'unknown' | 'ok' | 'readonly' | 'unavailable' | 'offline'>('unknown');
  readonly sharedPath = computed(() => { const d = this.appDir(); return d ? sharedDir(d) : ''; });
  private syncing: Promise<void> | null = null;
  private pendingMuts = new Map<string, ((c: AppConfig) => void)[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Información del servidor seleccionado (disco, memoria, SO, hardware). */
  readonly info = signal<ServerInfo | null>(null);
  readonly infoError = signal('');
  readonly infoLoading = signal(false);
  readonly infoAt = signal(0);
  private infoPending: Promise<void> | null = null;

  readonly profile = computed(() => this.store.profiles().find((p) => p.id === this.profileId()) ?? null);
  readonly apps = computed(() => this.store.apps().filter((a) => a.profileId === this.profileId()));
  readonly app = computed(() => this.store.apps().find((a) => a.id === this.appId()) ?? null);
  readonly group = computed(() => { const a = this.app(); return a ? this.groups().find((g) => g.name === a.pm2Name) ?? null : null; });
  /** Carpeta de la app en el servidor: la elegida o, si no, la de PM2. */
  readonly appDir = computed(() => this.app()?.dir || this.group()?.cwd || '');
  readonly state = computed(() => { const id = this.profileId(); return id ? this.conn.states()[id] ?? 'disconnected' : 'disconnected'; });

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.refresh(); this.syncShared(); } });
    // al elegir una app (o al conectar / conocer su carpeta) se sincronizan sus notas y su configuración con el servidor
    effect(() => { const id = this.appId(), dir = this.appDir(), st = this.state(); untracked(() => { if (!id || !dir) return; if (st === 'connected') this.syncShared(); else this.sharedState.set('offline'); }); }, { allowSignalWrites: true });
    // al cambiar de servidor se limpia la lista y se reinicia el sondeo
    effect(() => { const id = this.profileId(); this.groups.set([]); this.listError.set(''); this.info.set(null); this.infoError.set(''); this.restartPolling(id); }, { allowSignalWrites: true });
  }

  // ---------------------------------------------------------------- navegación
  selectProfile(id: string) { this.profileId.set(id); this.appId.set(null); this.serverTab.set('apps'); this.phoneView.set('apps'); }
  selectApp(id: string, tab?: Tab) { this.appId.set(id); if (tab) this.tab.set(tab); this.phoneView.set('detail'); }
  /** Atrás (botón del teléfono / flecha de la cabecera). Devuelve false si ya está en la pantalla inicial. */
  back(): boolean {
    const v = this.phoneView();
    if (v === 'detail') { this.serverTab.set('apps'); this.phoneView.set('apps'); return true; }
    if (v === 'apps') { this.phoneView.set('servers'); return true; }
    return false;
  }

  // ---------------------------------------------------------------- PM2
  private restartPolling(id: string | null) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!id) return;
    let n = 0;
    this.timer = setInterval(() => {
      if (document.hidden || !this.conn.isConnected(id)) return;
      this.refresh();
      if (++n % 5 === 0 && !this.appId()) this.refreshInfo();
      if (n % 4 === 0 && this.appId()) this.syncShared();   // ~24 s: refleja lo que editaron otros usuarios   // la ficha del servidor se renueva cada ~30 s mientras se ve
    }, 6000);
  }

  async connect(id?: string) {
    const pid = id ?? this.profileId();
    if (!pid) return;
    try { await this.conn.connect(pid); await this.refresh(true); this.refreshInfo(); }
    catch (e: any) { this.listError.set(String(e?.message ?? e)); }
  }

  private pending: Promise<void> | null = null;
  /** Actualiza la lista de PM2. Si ya hay una consulta en curso, espera a esa en vez de lanzar otra. */
  refresh(force = false): Promise<void> {
    const id = this.profileId();
    if (!id) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!this.conn.isConnected(id) && !force) return Promise.resolve();
    if (!this.groups().length) this.loading.set(true);
    this.pending = (async () => {
      try {
        const g = await this.pm2.list(id);
        if (this.profileId() === id) { this.groups.set(g); this.listError.set(''); this.lastUpdate.set(Date.now()); }
      } catch (e: any) {
        if (this.profileId() === id) this.listError.set(String(e?.message ?? e));
      } finally { this.pending = null; this.loading.set(false); }
    })();
    return this.pending;
  }

  /** Lee la ficha del servidor (SO, uptime, CPU, memoria, discos, hardware). */
  refreshInfo(): Promise<void> {
    const id = this.profileId();
    if (!id || !this.conn.isConnected(id)) return Promise.resolve();
    if (this.infoPending) return this.infoPending;
    this.infoLoading.set(true);
    this.infoPending = (async () => {
      try {
        const r = await this.conn.run(id, serverInfoScript(), { timeoutMs: 25000 });
        const i = parseServerInfo(r.stdout);
        if (this.profileId() === id) { this.info.set(i); this.infoError.set(''); this.infoAt.set(Date.now()); }
      } catch (e: any) { if (this.profileId() === id) this.infoError.set(String(e?.message ?? e)); }
      finally { this.infoPending = null; this.infoLoading.set(false); }
    })();
    return this.infoPending;
  }

  async act(verb: Pm2Verb, name: string, updateEnv = false) {
    const id = this.profileId();
    if (!id) return;
    this.busy.set(verb + ':' + name);
    try {
      await this.pm2.action(id, verb, name, updateEnv);
      this.toast.ok({ start: 'Iniciada', stop: 'Detenida', restart: 'Reiniciada', reload: 'Recargada', delete: 'Eliminada de PM2' }[verb] + ': ' + name);
    } catch (e) { this.toast.err(e); }
    finally { this.busy.set(null); await this.refresh(true); }
  }

  // ---------------------------------------------------------------- apps agregadas
  async addApp(g: Pm2Group, label?: string): Promise<TrackedApp> {
    const id = this.profileId()!;
    const existing = this.store.apps().find((a) => a.profileId === id && a.pm2Name === g.name);
    if (existing) return existing;
    const a: TrackedApp = { id: uid(), profileId: id, pm2Name: g.name, label: label?.trim() || g.name, dir: '', config: this.store.sharedConfigFor(id, g.name) ?? DEFAULT_CONFIG(), createdAt: Date.now() };
    await this.store.saveApp(a);
    return a;
  }
  async updateApp(patch: Partial<Omit<TrackedApp, 'id' | 'profileId'>>) {
    const a = this.app();
    if (a) await this.store.saveApp({ ...a, ...patch });
  }
  // ---------------------------------------------------------------- datos compartidos en el servidor
  private get writable() { return this.sharedState() === 'ok' && this.state() === 'connected'; }

  /** Lee `.arkpm` del servidor y deja la copia local (espejo) al día: configuración y notas. */
  syncShared(): Promise<void> {
    const a = this.app(), pid = this.profileId(), dir = this.appDir();
    if (!a || !pid || !dir) return Promise.resolve();
    if (this.state() !== 'connected') { this.sharedState.set('offline'); return Promise.resolve(); }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const r = await this.shared.read(pid, dir);
        if (this.appId() !== a.id) return;
        this.sharedState.set(r.state === 'rw' || r.state === 'new' ? 'ok' : r.state === 'ro' ? 'readonly' : 'unavailable');
        await this.reconcileConfig(a, r.config);
        await this.reconcileNotes(a, pid, dir, r.notes);
      } catch { this.sharedState.set('offline'); }
      finally { this.syncing = null; }
    })();
    return this.syncing;
  }

  private async reconcileConfig(a: TrackedApp, raw: unknown) {
    const key = this.store.appKey(a.profileId, a.pm2Name), meta = this.store.getSyncMeta(key), srv = normalizeShared(raw);
    const cur = this.store.apps().find((x) => x.id === a.id) ?? a;
    const overwriteWithLocal = (): ((c: AppConfig) => void)[] => { const d = structuredClone(cur.config.deploy), b = stripDevice(cur.config.backup); return [(c) => { c.deploy = structuredClone(d); c.backup = { ...c.backup, ...structuredClone(b) }; }]; };
    if (srv) {
      if (meta.dirty && this.writable) await this.pushConfig(a, overwriteWithLocal());          // cambios hechos sin conexión: se suben
      else if (srv.rev !== meta.rev) {                                                         // otro usuario cambió algo: se trae
        await this.store.saveApp({ ...cur, config: mergeShared(cur.config, srv) });
        await this.store.setSyncMeta(key, { rev: srv.rev, dirty: false });
      }
    } else if (this.writable) await this.pushConfig(a, []);                                    // primera vez: se sube la de este dispositivo
  }

  /** Lee–modifica–escribe la configuración en el servidor con control de revisión (reintenta si alguien escribió a la vez). */
  private async pushConfig(a: TrackedApp, muts: ((c: AppConfig) => void)[]): Promise<boolean> {
    const pid = a.profileId, dir = this.appDir(), key = this.store.appKey(a.profileId, a.pm2Name), author = this.profile()?.username ?? '';
    for (let i = 0; i < 4; i++) {
      try {
        const srv = normalizeShared((await this.shared.read(pid, dir)).config);
        const local = this.store.apps().find((x) => x.id === a.id)?.config ?? a.config;
        const cfg: AppConfig = srv ? mergeShared(local, srv) : structuredClone(local);
        for (const m of muts) m(cfg);
        const payload = { rev: (srv?.rev ?? 0) + 1, updatedAt: Date.now(), updatedBy: author, deploy: cfg.deploy, backup: stripDevice(cfg.backup) };
        if ((await this.shared.writeConfig(pid, dir, payload, srv ? srv.rev : null)) === 'ok') {
          const cur = this.store.apps().find((x) => x.id === a.id);
          if (cur) await this.store.saveApp({ ...cur, config: cfg });
          await this.store.setSyncMeta(key, { rev: payload.rev, dirty: false });
          return true;
        }
      } catch { return false; }
    }
    return false;
  }

  private async reconcileNotes(a: TrackedApp, pid: string, dir: string, remote: any[]) {
    const key = this.store.appKey(a.profileId, a.pm2Name);
    const mirror = this.store.notes().filter((n) => n.key === key);
    const ids = new Set(remote.map((n) => n.id));
    for (const r of remote) {
      const l = mirror.find((x) => x.id === r.id);
      if (!l || l.updatedAt !== r.updatedAt || l.text !== r.text || !l.synced) await this.store.saveNote({ id: r.id, key, text: String(r.text ?? ''), createdAt: Number(r.createdAt) || 0, updatedAt: Number(r.updatedAt) || 0, author: String(r.author ?? ''), synced: true });
    }
    for (const l of mirror) {
      if (ids.has(l.id)) continue;
      if (l.synced) await this.store.deleteNote(l.id);                                  // otro usuario la borró
      else if (this.writable) { try { if ((await this.shared.writeNote(pid, dir, l, null)) === 'ok') await this.store.saveNote({ ...l, synced: true }); } catch { /* se reintenta en la próxima */ } }
    }
  }

  /** Guarda una nota en el servidor. 'conflict': otro usuario la editó desde que se abrió. 'local': no hubo acceso y quedó solo en este dispositivo. */
  async persistNote(n: AppNote, expectedUpdatedAt: number | null): Promise<'ok' | 'conflict' | 'local'> {
    const a = this.app(), pid = this.profileId(), dir = this.appDir();
    if (a && pid && dir && this.writable) {
      try {
        const res = await this.shared.writeNote(pid, dir, n, expectedUpdatedAt);
        if (res === 'conflict') return 'conflict';
        await this.store.saveNote({ ...n, synced: true });
        return 'ok';
      } catch { /* sin acceso: queda local */ }
    }
    await this.store.saveNote({ ...n, synced: false });
    return 'local';
  }

  /** Elimina una nota para todos los usuarios. Si es compartida y no hay acceso al servidor no se puede (reaparecería). */
  async removeNote(n: AppNote): Promise<boolean> {
    const pid = this.profileId(), dir = this.appDir();
    if (n.synced) {
      if (!pid || !dir || !this.writable) { this.toast.show('Sin acceso de escritura al servidor: no se puede eliminar una nota compartida ahora.', 'err'); return false; }
      try { await this.shared.deleteNote(pid, dir, n.id); } catch (e) { this.toast.err(e); return false; }
    }
    await this.store.deleteNote(n.id);
    return true;
  }

  async updateConfig(mut: (c: AppConfig) => void) {
    const a = this.app();
    if (!a) return;
    const config = structuredClone(a.config);
    mut(config);
    await this.store.saveApp({ ...a, config });                                   // la pantalla responde al instante
    const key = this.store.appKey(a.profileId, a.pm2Name);
    await this.store.setSyncMeta(key, { ...this.store.getSyncMeta(key), dirty: true });   // hasta que el servidor lo confirme
    this.pendingMuts.set(a.id, [...(this.pendingMuts.get(a.id) ?? []), mut]);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushConfig(), 500);
  }

  private async flushConfig() {
    this.flushTimer = null;
    const a = this.app();
    if (!a) return;
    const muts = this.pendingMuts.get(a.id) ?? [];
    if (!muts.length || !this.writable) return;        // sigue marcada como pendiente: se sube al volver el acceso
    this.pendingMuts.delete(a.id);
    await this.pushConfig(a, muts);
  }

  async removeApp(id: string) {
    await this.store.deleteApp(id);
    if (this.appId() === id) { this.appId.set(null); this.phoneView.set('apps'); }
  }
}
