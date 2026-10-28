import { Injectable, signal } from '@angular/core';
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import { BackupRecord, DEFAULT_CONFIG, DeployRecord, ServerProfile, TrackedApp } from './models';
import { platformKind } from './transport';

interface Row { kind: string; id: string; json: string; }
interface Backend { init(): Promise<void>; all(): Promise<Row[]>; put(kind: string, id: string, json: string): Promise<void>; del(kind: string, id: string): Promise<void>; }

const DDL = 'CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, id))';

/** Electron: la base vive en el proceso principal (better-sqlite3). */
class ElectronBackend implements Backend {
  private api = window.electronAPI;
  init() { return this.api.dbExec(DDL); }
  all(): Promise<Row[]> { return this.api.dbAll('SELECT kind, id, json FROM docs'); }
  put(kind: string, id: string, json: string) { return this.api.dbRun('INSERT OR REPLACE INTO docs (kind, id, json) VALUES (?,?,?)', [kind, id, json]); }
  del(kind: string, id: string) { return this.api.dbRun('DELETE FROM docs WHERE kind = ? AND id = ?', [kind, id]); }
}

/** Android: @capacitor-community/sqlite. */
class CapacitorBackend implements Backend {
  private static readonly NAME = 'arkpm';
  private conn: SQLiteDBConnection | null = null;
  private async db() {
    if (this.conn) return this.conn;
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    const consistent = (await sqlite.checkConnectionsConsistency()).result;
    const exists = (await sqlite.isConnection(CapacitorBackend.NAME, false)).result;
    const c = consistent && exists ? await sqlite.retrieveConnection(CapacitorBackend.NAME, false) : await sqlite.createConnection(CapacitorBackend.NAME, false, 'no-encryption', 1, false);
    await c.open();
    this.conn = c;
    return c;
  }
  async init() { await (await this.db()).execute(DDL); }
  async all() { return ((await (await this.db()).query('SELECT kind, id, json FROM docs')).values ?? []) as Row[]; }
  async put(kind: string, id: string, json: string) { await (await this.db()).run('INSERT OR REPLACE INTO docs (kind, id, json) VALUES (?,?,?)', [kind, id, json], true); }
  async del(kind: string, id: string) { await (await this.db()).run('DELETE FROM docs WHERE kind = ? AND id = ?', [kind, id], true); }
}

/** Navegador (solo desarrollo de la interfaz) o si SQLite falla. */
class LocalStorageBackend implements Backend {
  private rows = new Map<string, Row>();
  async init() { try { for (const r of JSON.parse(localStorage.getItem('arkpm:docs') || '[]') as Row[]) this.rows.set(r.kind + '/' + r.id, r); } catch { /* vacío */ } }
  async all() { return [...this.rows.values()]; }
  private save() { try { localStorage.setItem('arkpm:docs', JSON.stringify([...this.rows.values()])); } catch { /* sin espacio */ } }
  async put(kind: string, id: string, json: string) { this.rows.set(kind + '/' + id, { kind, id, json }); this.save(); }
  async del(kind: string, id: string) { this.rows.delete(kind + '/' + id); this.save(); }
}

/** Persistencia local: servidores, apps agregadas, huellas de servidores, historial y ajustes (documentos JSON en SQLite). */
@Injectable({ providedIn: 'root' })
export class StoreService {
  readonly profiles = signal<ServerProfile[]>([]);
  readonly apps = signal<TrackedApp[]>([]);
  readonly backups = signal<BackupRecord[]>([]);
  readonly deploys = signal<DeployRecord[]>([]);
  fallbackReason: string | null = null;
  /** Sube cada vez que se guarda una huella de servidor (para volver a sincronizar el vigilante). */
  readonly pinsTick = signal(0);
  private pins = new Map<string, string>();
  private settings = new Map<string, unknown>();
  private be: Backend = platformKind() === 'electron' ? new ElectronBackend() : platformKind() === 'android' ? new CapacitorBackend() : new LocalStorageBackend();
  readonly ready: Promise<void> = this.load();

  private async load() {
    try { await this.be.init(); } catch (e: any) { this.fallbackReason = String(e?.message || e); this.be = new LocalStorageBackend(); await this.be.init(); }
    const rows = await this.be.all();
    const parse = <T>(k: string) => rows.filter((r) => r.kind === k).map((r) => { try { return JSON.parse(r.json) as T; } catch { return null; } }).filter((x): x is T => !!x);
    this.profiles.set(parse<ServerProfile>('profile').sort((a, b) => a.createdAt - b.createdAt));
    this.apps.set(parse<TrackedApp>('app').map((a) => ({ ...a, config: this.mergeConfig(a.config) })).sort((a, b) => a.createdAt - b.createdAt));
    this.backups.set(parse<BackupRecord>('backup').sort((a, b) => b.createdAt - a.createdAt));
    this.deploys.set(parse<DeployRecord>('deploy').sort((a, b) => b.at - a.at));
    for (const r of rows) {
      if (r.kind === 'pin') { try { this.pins.set(r.id, JSON.parse(r.json).fp); } catch { /* ignora */ } }
      if (r.kind === 'setting') { try { this.settings.set(r.id, JSON.parse(r.json)); } catch { /* ignora */ } }
    }
  }

  /** Completa con los valores por defecto lo que falte (configuraciones de versiones anteriores). */
  private mergeConfig(c: Partial<TrackedApp['config']> | undefined): TrackedApp['config'] {
    const d = DEFAULT_CONFIG();
    return { deploy: { ...d.deploy, ...(c?.deploy ?? {}) }, backup: { ...d.backup, ...(c?.backup ?? {}) } };
  }

  // ---- servidores ----
  async saveProfile(p: ServerProfile) {
    await this.ready;
    await this.be.put('profile', p.id, JSON.stringify(p));
    this.profiles.update((l) => (l.some((x) => x.id === p.id) ? l.map((x) => (x.id === p.id ? p : x)) : [...l, p]));
  }
  async deleteProfile(id: string) {
    await this.ready;
    for (const a of this.apps().filter((a) => a.profileId === id)) await this.deleteApp(a.id);
    await this.be.del('profile', id);
    this.profiles.update((l) => l.filter((x) => x.id !== id));
  }

  // ---- apps ----
  async saveApp(a: TrackedApp) {
    await this.ready;
    await this.be.put('app', a.id, JSON.stringify(a));
    this.apps.update((l) => (l.some((x) => x.id === a.id) ? l.map((x) => (x.id === a.id ? a : x)) : [...l, a]));
  }
  async deleteApp(id: string) {
    await this.ready;
    await this.be.del('app', id);
    for (const b of this.backups().filter((b) => b.appId === id)) await this.be.del('backup', b.id);
    for (const d of this.deploys().filter((d) => d.appId === id)) await this.be.del('deploy', d.id);
    this.apps.update((l) => l.filter((x) => x.id !== id));
    this.backups.update((l) => l.filter((x) => x.appId !== id));
    this.deploys.update((l) => l.filter((x) => x.appId !== id));
  }

  // ---- huellas de servidores SSH ----
  pinKey = (host: string, port: number) => `${host.toLowerCase()}:${port}`;
  getPin(host: string, port: number): string | null { return this.pins.get(this.pinKey(host, port)) ?? null; }
  async setPin(host: string, port: number, fp: string) {
    await this.ready;
    this.pins.set(this.pinKey(host, port), fp);
    await this.be.put('pin', this.pinKey(host, port), JSON.stringify({ fp, at: Date.now() }));
    this.pinsTick.update((n) => n + 1);
  }

  // ---- historial ----
  async addBackup(b: BackupRecord) {
    await this.ready;
    await this.be.put('backup', b.id, JSON.stringify(b));
    this.backups.update((l) => [b, ...l]);
  }
  async deleteBackup(id: string) {
    await this.ready;
    await this.be.del('backup', id);
    this.backups.update((l) => l.filter((x) => x.id !== id));
  }
  async addDeploy(d: DeployRecord) {
    await this.ready;
    await this.be.put('deploy', d.id, JSON.stringify(d));
    const all = [d, ...this.deploys()];
    // se conservan los últimos 30 por app
    const seen = new Map<string, number>();
    const keep: DeployRecord[] = [];
    for (const x of all) {
      const n = (seen.get(x.appId) ?? 0) + 1;
      seen.set(x.appId, n);
      if (n <= 30) keep.push(x); else await this.be.del('deploy', x.id);
    }
    this.deploys.set(keep);
  }

  // ---- ajustes sueltos ----
  getSetting<T>(key: string, def: T): T { return (this.settings.has(key) ? this.settings.get(key) : def) as T; }
  async setSetting(key: string, value: unknown) {
    await this.ready;
    this.settings.set(key, value);
    await this.be.put('setting', key, JSON.stringify(value));
  }
}
