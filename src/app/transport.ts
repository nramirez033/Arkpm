import { InjectionToken } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { ElectronTransport } from './electron-transport';
import { CapacitorTransport } from './capacitor-transport';
import type { RemoteEntry } from './models';

export type PlatformKind = 'electron' | 'android' | 'web';
export const platformKind = (): PlatformKind => (window.electronAPI ? 'electron' : Capacitor.isNativePlatform() ? 'android' : 'web');

export interface ConnectOpts {
  host: string; port: number; username: string;
  password?: string; privateKey?: string; passphrase?: string;
  /** Huella SHA256 fijada del servidor; si falta o no coincide la conexión se rechaza ANTES de enviar credenciales. */
  expectedFingerprint?: string | null;
}
export type ConnectErrorCode = 'HOSTKEY_UNKNOWN' | 'HOSTKEY_CHANGED' | 'AUTH_FAILED' | 'KEY_PASSPHRASE' | 'NETWORK';
export type ConnectResult =
  | { ok: true; sessionId: string; fingerprint: string | null }
  | { ok: false; code: ConnectErrorCode; message: string; fingerprint?: string | null };

/** Lo que la capa nativa necesita para vigilar un servidor (las credenciales las lee ella misma del almacén seguro). */
export interface MonitorServer {
  id: string; name: string; host: string; port: number; username: string; auth: 'password' | 'key';
  pm2Cmd: string; shellInit: string; fingerprint: string | null; notify: boolean;
}
export interface MonitorConfig {
  enabled: boolean; background: boolean; interval: number;
  events: { started: boolean; stopped: boolean; errored: boolean; connection: boolean };
  servers: MonitorServer[];
}
export interface MonitorStatus { id: string; state: 'up' | 'down' | 'skipped' | 'error' | 'pending' | 'off'; reason: string; }
export type NotifyPermission = 'granted' | 'denied' | 'prompt';
/** Opciones propias de la app de escritorio. `supported` = el sistema permite registrar el inicio automático (Windows/macOS, versión instalada o portable). */
export interface DesktopOptions { autoStart: boolean; startHidden: boolean; minimizeToBackground: boolean; confirmClose: boolean; supported: boolean; platform: string; }

export interface ExecResult { code: number; stdout: string; stderr: string; }
export interface LocalFile { ref: string; name: string; size: number; }
export interface UploadItem { local: string; remote: string; size: number; }
export interface ProgressEvent { jobId: string; loaded: number; total: number; current: string; }
export interface StreamEvent { streamId: string; kind: 'data' | 'close'; data?: string; code?: number | null; }

/**
 * Contrato entre la app y la capa nativa que habla SSH/SFTP.
 *  - Escritorio: ssh2 en el proceso principal de Electron (electron/ssh.js).
 *  - Android:    plugin Kotlin con JSch (android-native/kotlin/ArkpmSshPlugin.kt).
 * La lógica (PM2, deploy, backup) está en TypeScript y es la misma en ambas.
 */
export interface SshTransport {
  readonly kind: PlatformKind;
  /** Elegir una carpeta local entera para subirla (solo escritorio). */
  readonly canPickFolder: boolean;
  connect(o: ConnectOpts): Promise<ConnectResult>;
  disconnect(sessionId: string): Promise<void>;
  exec(sessionId: string, cmd: string, o?: { timeoutMs?: number; stdin?: string }): Promise<ExecResult>;
  streamStart(sessionId: string, cmd: string, o?: { pty?: boolean }): Promise<string>;
  streamStop(streamId: string): Promise<void>;
  list(sessionId: string, path: string): Promise<RemoteEntry[]>;
  stat(sessionId: string, path: string): Promise<{ exists: boolean; isDir?: boolean; size?: number; mtime?: number }>;
  readFile(sessionId: string, path: string, maxBytes: number): Promise<{ data: string; size: number; truncated: boolean }>;
  writeFile(sessionId: string, path: string, dataB64: string): Promise<void>;
  uploadMany(sessionId: string, jobId: string, items: UploadItem[]): Promise<void>;
  download(sessionId: string, jobId: string, remote: string, destDir: string, name: string): Promise<{ path: string; size: number }>;
  cancelJob(jobId: string): Promise<void>;
  pickFiles(o?: { multi?: boolean; title?: string }): Promise<LocalFile[]>;
  pickFolder(): Promise<{ root: string; name: string } | null>;
  walkLocal(root: string, rules: string[]): Promise<{ path: string; size: number }[]>;
  /** Devuelve ruta (escritorio) o URI de árbol (Android) y una etiqueta legible. */
  pickSaveDir(): Promise<{ ref: string; label: string } | null>;
  showSaved(path: string): Promise<void>;
  secretSave(id: string, value: string): Promise<void>;
  secretLoad(id: string): Promise<string | null>;
  secretDelete(id: string): Promise<void>;
  /** Vigilante de servidores (avisos de inicio/detención/error/conexión). Escritorio: proceso principal. Android: servicio nativo. */
  monitorConfigure(cfg: MonitorConfig): Promise<void>;
  monitorStatus(): Promise<MonitorStatus[]>;
  monitorMute(serverId: string, name: string): Promise<void>;
  notifyTest(): Promise<void>;
  /** Solo escritorio (en Android devuelve null). */
  desktopGet(): Promise<DesktopOptions | null>;
  desktopSet(patch: Partial<Pick<DesktopOptions, 'autoStart' | 'startHidden' | 'minimizeToBackground' | 'confirmClose'>>): Promise<DesktopOptions | null>;
  notifyPermission(): Promise<NotifyPermission>;
  requestNotifyPermission(): Promise<NotifyPermission>;
  /** Android: avisa de que la app pasó a segundo plano y sigue vigilando. */
  notifyBackground(): Promise<void>;
  openBatterySettings(): Promise<void>;
  onNotifyClick(cb: (e: { serverId: string; app: string | null }) => void): () => void;
  onStream(cb: (e: StreamEvent) => void): () => void;
  onProgress(cb: (e: ProgressEvent) => void): () => void;
  onClosed(cb: (sessionId: string) => void): () => void;
}

export const TRANSPORT = new InjectionToken<SshTransport>('SshTransport', {
  providedIn: 'root',
  factory: () => (platformKind() === 'electron' ? new ElectronTransport() : new CapacitorTransport()),
});

/** Quita el prefijo que Electron/Capacitor agregan a los errores remotos. */
export function cleanError(e: unknown): Error {
  const m = String((e as any)?.message ?? e ?? 'Error desconocido')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^Error: /, '');
  return new Error(m);
}
