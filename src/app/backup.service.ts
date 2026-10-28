import { Injectable, inject } from '@angular/core';
import { ConnectionService } from './connection.service';
import { Job, runScript } from './job';
import { BackupRecord, TrackedApp, uid } from './models';
import { arkDir, backupScript, listBackupsScript, parseBackupList, parsePreview, previewScript, pruneBackupsScript, restoreScript, safeName, sq, stamp, TarSpec } from './remote';
import { StoreService } from './store.service';

export interface ServerBackup { name: string; size: number; mtime: number; }

@Injectable({ providedIn: 'root' })
export class BackupService {
  private readonly conn = inject(ConnectionService);
  private readonly store = inject(StoreService);

  serverDir(app: TrackedApp) { return `${arkDir(this.conn.home(app.profileId))}/backups/${safeName(app.pm2Name)}`; }
  private tmpDir(app: TrackedApp) { return `${arkDir(this.conn.home(app.profileId))}/tmp`; }

  spec(app: TrackedApp, dir: string): TarSpec {
    const b = app.config.backup;
    return { dir, mode: b.mode, includes: b.includes, excludes: b.excludes };
  }

  /** Cuántos archivos y bytes (sin comprimir) entrarían con la selección actual. */
  async preview(app: TrackedApp, dir: string): Promise<{ files: number; bytes: number }> {
    await this.conn.connect(app.profileId);
    const r = await this.conn.run(app.profileId, previewScript(this.spec(app, dir)), { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'No se pudo calcular la vista previa');
    return parsePreview(r.stdout);
  }

  /** Crea el .tar.gz en el servidor y lo descarga a la carpeta elegida en este dispositivo. */
  async createAndDownload(app: TrackedApp, dir: string, saveDir: string, job: Job): Promise<BackupRecord> {
    const keep = app.config.backup.keepOnServer;
    const name = `${safeName(app.label || app.pm2Name)}-${stamp()}.tar.gz`;
    const remote = `${keep ? this.serverDir(app) : this.tmpDir(app)}/${name}`;
    await this.conn.connect(app.profileId);
    job.step('Comprimiendo archivos en el servidor…');
    const r = await runScript(this.conn, app.profileId, backupScript(this.spec(app, dir), remote), job, { quiet: true });
    if (r.code !== 0) { await this.rm(app, remote + '.part'); throw new Error(r.out.trim().split('\n').slice(-3).join(' ') || 'Falló la compresión en el servidor'); }
    const size = Number(r.out.trim().split('\n').pop()) || 0;
    job.say(`  Archivo comprimido: ${name}`);
    try {
      const rec = await this.downloadRemote(app, remote, name, saveDir, job);
      if (keep) await this.conn.run(app.profileId, pruneBackupsScript(this.serverDir(app), app.config.backup.keepCount)).catch(() => { /* no crítico */ });
      return { ...rec, size: rec.size || size };
    } finally {
      if (!keep) await this.rm(app, remote);
    }
  }

  /** Descarga un archivo del servidor a `saveDir` mostrando el avance en el trabajo. */
  async downloadRemote(app: TrackedApp, remote: string, name: string, saveDir: string, job: Job): Promise<BackupRecord> {
    job.step('Descargando al dispositivo…', 0);
    const jobId = uid();
    const off = this.conn.onProgress((e) => { if (e.jobId === jobId && e.total) job.progress(Math.round((e.loaded / e.total) * 100)); });
    const stop = job.onCancel(() => this.conn.cancelJob(jobId));
    try {
      const d = await this.conn.download(app.profileId, jobId, remote, saveDir, name);
      job.check();
      const rec: BackupRecord = { id: uid(), appId: app.id, name, size: d.size, createdAt: Date.now(), location: d.path, note: '' };
      await this.store.addBackup(rec);
      job.progress(100);
      job.say(`  Guardado en ${d.path}`);
      return rec;
    } finally { off(); stop(); }
  }

  /** Copia previa al deploy: siempre «todo excepto» las exclusiones del backup, guardada en ~/.arkpm/backups. */
  async createServerBackup(app: TrackedApp, dir: string, tag: string, job: Job): Promise<ServerBackup & { path: string }> {
    const name = `${safeName(app.pm2Name)}-${stamp()}-${tag}.tar.gz`;
    const path = `${this.serverDir(app)}/${name}`;
    const spec: TarSpec = { dir, mode: 'all-except', includes: [], excludes: app.config.backup.excludes };
    const r = await runScript(this.conn, app.profileId, backupScript(spec, path), job, { quiet: true });
    if (r.code !== 0) { await this.rm(app, path + '.part'); throw new Error(r.out.trim().split('\n').slice(-3).join(' ') || 'No se pudo crear la copia previa'); }
    await this.conn.run(app.profileId, pruneBackupsScript(this.serverDir(app), Math.max(app.config.backup.keepCount, 3))).catch(() => { /* no crítico */ });
    return { name, path, size: Number(r.out.trim().split('\n').pop()) || 0, mtime: Date.now() };
  }

  async listServer(app: TrackedApp): Promise<ServerBackup[]> {
    await this.conn.connect(app.profileId);
    const r = await this.conn.run(app.profileId, listBackupsScript(this.serverDir(app)));
    return parseBackupList(r.stdout);
  }

  async restoreServer(app: TrackedApp, dir: string, name: string, job: Job): Promise<void> {
    const archive = `${this.serverDir(app)}/${name}`;
    job.step('Restaurando archivos…');
    const r = await runScript(this.conn, app.profileId, restoreScript(archive, `${this.tmpDir(app)}/restore-${stamp()}`, dir, app.config.deploy.preserve), job);
    if (r.code !== 0) throw new Error('No se pudo restaurar el backup (código ' + r.code + ')');
  }

  async deleteServer(app: TrackedApp, name: string) { await this.rm(app, `${this.serverDir(app)}/${name}`); }

  private async rm(app: TrackedApp, path: string) { await this.conn.run(app.profileId, `rm -f -- ${sq(path)}`).catch(() => { /* ya no existe */ }); }
}
