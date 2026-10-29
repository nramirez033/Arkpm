import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { cleanError, type DesktopOptions, type MonitorConfig, type MonitorStatus, type NotifyPermission, type ConnectOpts, type ConnectResult, type ExecResult, type LocalFile, type ProgressEvent, type SshTransport, type StreamEvent, type UploadItem } from './transport';
import type { RemoteEntry } from './models';

/** Plugin Kotlin: android-native/kotlin/ArkpmSshPlugin.kt (JSch). */
export interface ArkpmSshPlugin {
  connect(o: ConnectOpts): Promise<ConnectResult>;
  disconnect(o: { sessionId: string }): Promise<void>;
  exec(o: { sessionId: string; cmd: string; timeoutMs?: number; stdin?: string }): Promise<ExecResult>;
  streamStart(o: { sessionId: string; cmd: string; pty?: boolean }): Promise<{ streamId: string }>;
  streamStop(o: { streamId: string }): Promise<void>;
  list(o: { sessionId: string; path: string }): Promise<{ entries: RemoteEntry[] }>;
  stat(o: { sessionId: string; path: string }): Promise<{ exists: boolean; isDir?: boolean; size?: number; mtime?: number }>;
  readFile(o: { sessionId: string; path: string; maxBytes: number }): Promise<{ data: string; size: number; truncated: boolean }>;
  writeFile(o: { sessionId: string; path: string; data: string }): Promise<void>;
  uploadMany(o: { sessionId: string; jobId: string; items: UploadItem[] }): Promise<void>;
  download(o: { sessionId: string; jobId: string; remote: string; destDir: string; name: string }): Promise<{ path: string; size: number }>;
  cancelJob(o: { jobId: string }): Promise<void>;
  pickFiles(o: { multi: boolean }): Promise<{ files: LocalFile[] }>;
  pickSaveDir(): Promise<{ uri?: string; label?: string }>;
  secretSave(o: { id: string; value: string }): Promise<void>;
  secretLoad(o: { id: string }): Promise<{ value?: string | null }>;
  secretDelete(o: { id: string }): Promise<void>;
  monitorConfigure(o: { config: string }): Promise<void>;
  monitorStatus(): Promise<{ servers: MonitorStatus[] }>;
  monitorMute(o: { serverId: string; name: string }): Promise<void>;
  notifyTest(): Promise<void>;
  notifPermission(): Promise<{ state: NotifyPermission }>;
  requestNotifPermission(): Promise<{ state: NotifyPermission }>;
  notifyBackground(): Promise<void>;
  openBatterySettings(): Promise<void>;
  addListener(ev: 'stream', cb: (e: StreamEvent) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'progress', cb: (e: ProgressEvent) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'closed', cb: (e: { sessionId: string }) => void): Promise<PluginListenerHandle>;
}

const Plugin = registerPlugin<ArkpmSshPlugin>('ArkpmSsh');

/** Android (móvil y tablet): llama al plugin nativo. En un navegador normal falla con un mensaje claro. */
export class CapacitorTransport implements SshTransport {
  readonly kind = Capacitor.isNativePlatform() ? ('android' as const) : ('web' as const);
  readonly canPickFolder = false;

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    if (!Capacitor.isNativePlatform()) throw new Error('Esta función necesita la app de escritorio (Electron) o la de Android.');
    try { return await fn(); } catch (e) { throw cleanError(e); }
  }

  connect(o: ConnectOpts) { return this.call(() => Plugin.connect(o)); }
  disconnect(sessionId: string) { return this.call(() => Plugin.disconnect({ sessionId })); }
  exec(sessionId: string, cmd: string, o?: { timeoutMs?: number; stdin?: string }) { return this.call(() => Plugin.exec({ sessionId, cmd, ...o })); }
  async streamStart(sessionId: string, cmd: string, o?: { pty?: boolean }) { return (await this.call(() => Plugin.streamStart({ sessionId, cmd, pty: !!o?.pty }))).streamId; }
  streamStop(streamId: string) { return this.call(() => Plugin.streamStop({ streamId })); }
  async list(sessionId: string, path: string) { return (await this.call(() => Plugin.list({ sessionId, path }))).entries; }
  stat(sessionId: string, path: string) { return this.call(() => Plugin.stat({ sessionId, path })); }
  readFile(sessionId: string, path: string, maxBytes: number) { return this.call(() => Plugin.readFile({ sessionId, path, maxBytes })); }
  writeFile(sessionId: string, path: string, data: string) { return this.call(() => Plugin.writeFile({ sessionId, path, data })); }
  uploadMany(sessionId: string, jobId: string, items: UploadItem[]) { return this.call(() => Plugin.uploadMany({ sessionId, jobId, items })); }
  download(sessionId: string, jobId: string, remote: string, destDir: string, name: string) { return this.call(() => Plugin.download({ sessionId, jobId, remote, destDir, name })); }
  cancelJob(jobId: string) { return this.call(() => Plugin.cancelJob({ jobId })); }

  async pickFiles(o?: { multi?: boolean }) { return (await this.call(() => Plugin.pickFiles({ multi: o?.multi !== false }))).files; }
  async pickFolder() { return null; }
  async walkLocal() { return []; }
  async pickSaveDir() { const r = await this.call(() => Plugin.pickSaveDir()); return r.uri ? { ref: r.uri, label: r.label || r.uri } : null; }
  async showSaved() { /* en Android no hay «mostrar en carpeta»: el aviso ya indica dónde quedó */ }

  secretSave(id: string, value: string) { return this.call(() => Plugin.secretSave({ id, value })); }
  async secretLoad(id: string) { return (await this.call(() => Plugin.secretLoad({ id }))).value ?? null; }
  secretDelete(id: string) { return this.call(() => Plugin.secretDelete({ id })); }

  monitorConfigure(cfg: MonitorConfig) { return this.call(() => Plugin.monitorConfigure({ config: JSON.stringify(cfg) })); }
  async monitorStatus() { return (await this.call(() => Plugin.monitorStatus())).servers; }
  monitorMute(serverId: string, name: string) { return this.call(() => Plugin.monitorMute({ serverId, name })); }
  async desktopGet(): Promise<DesktopOptions | null> { return null; }
  async desktopSet(): Promise<DesktopOptions | null> { return null; }
  notifyTest() { return this.call(() => Plugin.notifyTest()); }
  async notifyPermission() { return (await this.call(() => Plugin.notifPermission())).state; }
  async requestNotifyPermission() { return (await this.call(() => Plugin.requestNotifPermission())).state; }
  notifyBackground() { return this.call(() => Plugin.notifyBackground()); }
  openBatterySettings() { return this.call(() => Plugin.openBatterySettings()); }
  onNotifyClick(_cb: (e: { serverId: string; app: string | null }) => void) { return () => {}; }

  private listen<T>(ev: string, cb: (e: T) => void): () => void {
    if (!Capacitor.isNativePlatform()) return () => {};
    let h: PluginListenerHandle | null = null, dead = false;
    (Plugin.addListener as any)(ev, cb).then((x: PluginListenerHandle) => { if (dead) x.remove(); else h = x; });
    return () => { dead = true; h?.remove(); };
  }
  onStream(cb: (e: StreamEvent) => void) { return this.listen('stream', cb); }
  onProgress(cb: (e: ProgressEvent) => void) { return this.listen('progress', cb); }
  onClosed(cb: (sessionId: string) => void) { return this.listen<{ sessionId: string }>('closed', (e) => cb(e.sessionId)); }
}
