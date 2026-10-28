import { cleanError, type MonitorConfig, type MonitorStatus, type NotifyPermission, type ConnectOpts, type ConnectResult, type ExecResult, type LocalFile, type ProgressEvent, type SshTransport, type StreamEvent, type UploadItem } from './transport';
import type { RemoteEntry } from './models';

/** Escritorio: todo pasa por IPC al proceso principal (electron/main.js → electron/ssh.js). */
export class ElectronTransport implements SshTransport {
  readonly kind = 'electron' as const;
  readonly canPickFolder = true;
  private get api() { return window.electronAPI; }

  private async call<T>(p: Promise<T>): Promise<T> { try { return await p; } catch (e) { throw cleanError(e); } }

  connect(o: ConnectOpts): Promise<ConnectResult> { return this.call(this.api.sshConnect(o)); }
  disconnect(id: string) { return this.call<void>(this.api.sshDisconnect(id)); }
  exec(id: string, cmd: string, o?: { timeoutMs?: number; stdin?: string }): Promise<ExecResult> { return this.call(this.api.sshExec(id, cmd, o ?? {})); }
  streamStart(id: string, cmd: string, o?: { pty?: boolean }) { return this.call<string>(this.api.sshStreamStart(id, cmd, o ?? {})); }
  streamStop(sid: string) { return this.call<void>(this.api.sshStreamStop(sid)); }
  list(id: string, path: string): Promise<RemoteEntry[]> { return this.call(this.api.sshList(id, path)); }
  stat(id: string, path: string) { return this.call<any>(this.api.sshStat(id, path)); }
  readFile(id: string, path: string, max: number) { return this.call<any>(this.api.sshReadFile(id, path, max)); }
  writeFile(id: string, path: string, b64: string) { return this.call<void>(this.api.sshWriteFile(id, path, b64)); }
  uploadMany(id: string, job: string, items: UploadItem[]) { return this.call<void>(this.api.sshUploadMany(id, job, items)); }
  download(id: string, job: string, remote: string, dir: string, name: string) { return this.call<any>(this.api.sshDownload(id, job, remote, dir, name)); }
  cancelJob(job: string) { return this.call<void>(this.api.sshCancelJob(job)); }

  pickFiles(o?: { multi?: boolean; title?: string }): Promise<LocalFile[]> { return this.call(this.api.pickFiles(o ?? {})); }
  pickFolder() { return this.call<{ root: string; name: string } | null>(this.api.pickFolder()); }
  walkLocal(root: string, rules: string[]) { return this.call<{ path: string; size: number }[]>(this.api.walkLocal(root, rules)); }
  async pickSaveDir() { const p: string | null = await this.call(this.api.pickSaveDir()); return p ? { ref: p, label: p } : null; }
  showSaved(path: string) { return this.call<void>(this.api.showItem(path)); }

  secretSave(id: string, v: string) { return this.call<void>(this.api.secretSave(id, v)); }
  secretLoad(id: string) { return this.call<string | null>(this.api.secretLoad(id)); }
  secretDelete(id: string) { return this.call<void>(this.api.secretDelete(id)); }

  monitorConfigure(cfg: MonitorConfig) { return this.call<void>(this.api.monitorConfigure(cfg)); }
  monitorStatus() { return this.call<MonitorStatus[]>(this.api.monitorStatus()); }
  monitorMute(serverId: string, name: string) { return this.call<void>(this.api.monitorMute(serverId, name)); }
  notifyTest() { return this.call<void>(this.api.notifyTest()); }
  notifyPermission() { return this.call<NotifyPermission>(this.api.notifyPermission()); }
  requestNotifyPermission() { return this.notifyPermission(); }
  async notifyBackground() { /* en escritorio el aviso lo da el proceso principal al ocultar la ventana */ }
  async openBatterySettings() { /* no aplica */ }
  onNotifyClick(cb: (e: { serverId: string; app: string | null }) => void) { return this.api.onNotifyClick(cb); }

  onStream(cb: (e: StreamEvent) => void) { return this.api.onSshStream((streamId: string, kind: 'data' | 'close', payload: any) => cb(kind === 'data' ? { streamId, kind, data: payload } : { streamId, kind, code: payload })); }
  onProgress(cb: (e: ProgressEvent) => void) { return this.api.onSshProgress((jobId: string, loaded: number, total: number, current: string) => cb({ jobId, loaded, total, current })); }
  onClosed(cb: (sessionId: string) => void) { return this.api.onSshClosed(cb); }
}
