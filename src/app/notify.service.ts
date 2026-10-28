import { Injectable, effect, inject, signal } from '@angular/core';
import { App } from '@capacitor/app';
import { MonitorConfig, MonitorStatus, NotifyPermission, TRANSPORT } from './transport';
import { StoreService } from './store.service';

export interface NotifSettings {
  /** Avisos del sistema cuando algo pasa en un servicio o en la conexión. */
  enabled: boolean;
  /** Seguir vigilando con la app cerrada (bandeja en escritorio, servicio en primer plano en Android). */
  background: boolean;
  /** Cada cuántos segundos se revisan los servidores. */
  interval: number;
  events: { started: boolean; stopped: boolean; errored: boolean; connection: boolean };
  /** Servidores vigilados (los que no aparecen se vigilan). */
  servers: Record<string, boolean>;
}

const DEFAULTS: NotifSettings = { enabled: false, background: false, interval: 30, events: { started: true, stopped: true, errored: true, connection: true }, servers: {} };

/** Ajustes de notificaciones y puente con el vigilante nativo (Electron: proceso principal · Android: servicio). */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  private readonly t = inject(TRANSPORT);
  private readonly store = inject(StoreService);
  readonly settings = signal<NotifSettings>(DEFAULTS);
  readonly permission = signal<NotifyPermission>('prompt');
  readonly status = signal<MonitorStatus[]>([]);
  private loaded = false;
  private lastBgNotice = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.store.ready.then(async () => {
      const saved = this.store.getSetting<Partial<NotifSettings>>('notif', {});
      this.settings.set({ ...DEFAULTS, ...saved, events: { ...DEFAULTS.events, ...(saved.events ?? {}) }, servers: { ...(saved.servers ?? {}) } });
      this.loaded = true;
      this.permission.set(await this.t.notifyPermission().catch(() => 'denied'));
    });
    // cualquier cambio de ajustes, servidores o huellas se envía al vigilante nativo
    effect(() => {
      this.settings(); this.store.profiles(); this.store.pinsTick();
      if (this.loaded) this.scheduleSync();
    });
    if (this.t.kind === 'android') {
      App.addListener('appStateChange', ({ isActive }) => {
        const s = this.settings();
        if (!isActive && s.enabled && s.background && Date.now() - this.lastBgNotice > 10 * 60 * 1000) { this.lastBgNotice = Date.now(); this.t.notifyBackground().catch(() => { /* nada */ }); }
      }).catch(() => { /* sin plugin */ });
    }
  }

  serverOn(id: string) { return this.settings().servers[id] !== false; }

  buildConfig(): MonitorConfig {
    const s = this.settings();
    return {
      enabled: s.enabled, background: s.enabled && s.background, interval: s.interval, events: s.events,
      servers: this.store.profiles().map((p) => ({
        id: p.id, name: p.name, host: p.host, port: p.port, username: p.username, auth: p.auth, pm2Cmd: p.pm2Cmd || 'pm2', shellInit: p.shellInit,
        fingerprint: this.store.getPin(p.host, p.port), notify: s.servers[p.id] !== false,
      })),
    };
  }

  private scheduleSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), 400);
  }
  async sync() { try { await this.t.monitorConfigure(this.buildConfig()); } catch { /* navegador sin vigilante */ } }

  async update(patch: Partial<Omit<NotifSettings, 'events' | 'servers'>> & { events?: Partial<NotifSettings['events']> }): Promise<void> {
    const cur = this.settings();
    const next: NotifSettings = { ...cur, ...patch, events: { ...cur.events, ...(patch.events ?? {}) } };
    if (patch.enabled && !cur.enabled) {
      this.permission.set(await this.t.requestNotifyPermission().catch(() => 'denied'));
      if (this.permission() === 'denied') next.enabled = false;   // sin permiso del sistema no tiene sentido activarlo
    }
    if (!next.enabled) next.background = false;
    this.settings.set(next);
    await this.store.setSetting('notif', next);
  }

  async setServer(id: string, on: boolean) {
    const next = { ...this.settings(), servers: { ...this.settings().servers, [id]: on } };
    this.settings.set(next);
    await this.store.setSetting('notif', next);
  }

  async refreshStatus() { this.status.set(await this.t.monitorStatus().catch(() => [])); }
  test() { return this.t.notifyTest(); }
  batterySettings() { return this.t.openBatterySettings(); }
  onClick(cb: (e: { serverId: string; app: string | null }) => void) { return this.t.onNotifyClick(cb); }

  /** La app acaba de actuar sobre este servicio (iniciar/detener/reiniciar/crear): el vigilante no debe avisar de ello. */
  mute(profileId: string, name: string) { if (this.settings().enabled) this.t.monitorMute(profileId, name).catch(() => { /* nada */ }); }
}
