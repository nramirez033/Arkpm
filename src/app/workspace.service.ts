import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ConnectionService } from './connection.service';
import { AppConfig, DEFAULT_CONFIG, Pm2Group, TrackedApp, uid } from './models';
import { Pm2Service, Pm2Verb } from './pm2.service';
import { ServerInfo, parseServerInfo, serverInfoScript } from './remote';
import { StoreService } from './store.service';
import { ToastService } from './dialog.service';

export type Tab = 'estado' | 'logs' | 'archivos' | 'deploy' | 'backup';
/** Pantalla visible en móvil (en tableta y escritorio se muestran juntas). */
export type PhoneView = 'servers' | 'apps' | 'detail';

/** Estado de trabajo: servidor y app seleccionados, lista de PM2 en vivo y navegación. */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  readonly store = inject(StoreService);
  readonly conn = inject(ConnectionService);
  private readonly pm2 = inject(Pm2Service);
  private readonly toast = inject(ToastService);

  readonly profileId = signal<string | null>(null);
  readonly appId = signal<string | null>(null);
  readonly tab = signal<Tab>('estado');
  readonly phoneView = signal<PhoneView>('servers');
  readonly groups = signal<Pm2Group[]>([]);
  readonly loading = signal(false);
  readonly listError = signal('');
  readonly lastUpdate = signal(0);
  readonly busy = signal<string | null>(null);
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
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
    // al cambiar de servidor se limpia la lista y se reinicia el sondeo
    effect(() => { const id = this.profileId(); this.groups.set([]); this.listError.set(''); this.info.set(null); this.infoError.set(''); this.restartPolling(id); }, { allowSignalWrites: true });
  }

  // ---------------------------------------------------------------- navegación
  selectProfile(id: string) { this.profileId.set(id); this.appId.set(null); this.phoneView.set('apps'); }
  selectApp(id: string, tab?: Tab) { this.appId.set(id); if (tab) this.tab.set(tab); this.phoneView.set('detail'); }
  /** Atrás (botón del teléfono / flecha de la cabecera). Devuelve false si ya está en la pantalla inicial. */
  back(): boolean {
    const v = this.phoneView();
    if (v === 'detail') { this.phoneView.set('apps'); return true; }
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
      if (++n % 5 === 0 && !this.appId()) this.refreshInfo();   // la ficha del servidor se renueva cada ~30 s mientras se ve
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
    const a: TrackedApp = { id: uid(), profileId: id, pm2Name: g.name, label: label?.trim() || g.name, dir: '', config: DEFAULT_CONFIG(), createdAt: Date.now() };
    await this.store.saveApp(a);
    return a;
  }
  async updateApp(patch: Partial<Omit<TrackedApp, 'id' | 'profileId'>>) {
    const a = this.app();
    if (a) await this.store.saveApp({ ...a, ...patch });
  }
  async updateConfig(mut: (c: AppConfig) => void) {
    const a = this.app();
    if (!a) return;
    const config = structuredClone(a.config);
    mut(config);
    await this.store.saveApp({ ...a, config });
  }
  async removeApp(id: string) {
    await this.store.deleteApp(id);
    if (this.appId() === id) { this.appId.set(null); this.phoneView.set('apps'); }
  }
}
