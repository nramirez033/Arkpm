import { Injectable, inject } from '@angular/core';
import { BackupService } from './backup.service';
import { ConnectionService } from './connection.service';
import { Job, runScript } from './job';
import { DeployConfig, DeployRecord, TrackedApp, uid } from './models';
import { Pm2Service } from './pm2.service';
import { applyScript, arkDir, extractScript, postScript, safeName, sq, stamp } from './remote';
import { LocalFile, UploadItem } from './transport';
import { StoreService } from './store.service';

export type DeploySource =
  | { kind: 'archive'; file: LocalFile }
  | { kind: 'files'; files: LocalFile[] }
  | { kind: 'folder'; root: string; name: string; files: { path: string; size: number }[] };

export const sourceLabel = (s: DeploySource) => (s.kind === 'archive' ? s.file.name : s.kind === 'files' ? `${s.files.length} archivo(s)` : `Carpeta ${s.name}`);
export const sourceBytes = (s: DeploySource) => (s.kind === 'archive' ? s.file.size : s.kind === 'files' ? s.files.reduce((a, f) => a + f.size, 0) : s.files.reduce((a, f) => a + f.size, 0));
const archiveExt = (n: string) => { const l = n.toLowerCase(); return l.endsWith('.tar.gz') ? '.tar.gz' : l.endsWith('.tgz') ? '.tgz' : l.endsWith('.tar') ? '.tar' : l.endsWith('.zip') ? '.zip' : ''; };
export const isArchiveName = (n: string) => !!archiveExt(n);

export interface DeployResult { record: DeployRecord; backupName: string; }

@Injectable({ providedIn: 'root' })
export class DeployService {
  private readonly conn = inject(ConnectionService);
  private readonly backups = inject(BackupService);
  private readonly pm2 = inject(Pm2Service);
  private readonly store = inject(StoreService);

  /**
   * Flujo: copia previa → subir a una carpeta temporal → (extraer) → aplicar sobre la carpeta de la app →
   * comandos posteriores → reiniciar en PM2 → comprobar que quedó en línea. No se toca la carpeta real
   * hasta que todo se subió bien.
   */
  async deploy(app: TrackedApp, dir: string, src: DeploySource, cfg: DeployConfig, job: Job): Promise<DeployResult> {
    const pid = app.profileId;
    const started = Date.now();
    let backupName = '';
    const home = this.conn.home(pid) || (await this.conn.connect(pid)).home;
    const stage = `${arkDir(home)}/staging/${safeName(app.pm2Name)}/${stamp()}`;
    const content = `${stage}/content`;
    try {
      job.check();
      job.step('Comprobando la carpeta de la app…');
      const st = await this.conn.stat(pid, dir);
      if (!st.exists || !st.isDir) throw new Error(`La carpeta ${dir} no existe en el servidor`);

      if (cfg.backupFirst) {
        job.step('Copia previa en el servidor…');
        const b = await this.backups.createServerBackup(app, dir, 'predeploy', job);
        backupName = b.name;
        job.say(`  Copia guardada: ${b.name}`);
      }

      job.check();
      await this.upload(app, src, stage, content, job);

      if (src.kind === 'archive') {
        job.step('Descomprimiendo en el servidor…');
        const r = await runScript(this.conn, pid, extractScript(`${stage}/upload${archiveExt(src.file.name)}`, content), job);
        if (r.code !== 0) throw new Error('No se pudo descomprimir el paquete (¿está dañado?)');
      }

      job.check();
      job.step(cfg.mode === 'sync' ? 'Reemplazando archivos (sincronizar)…' : 'Copiando archivos (sobrescribir)…');
      const ap = await runScript(this.conn, pid, applyScript({ src: content, dir, mode: cfg.mode, preserve: cfg.preserve, flatten: cfg.flatten && src.kind === 'archive' }), job);
      if (ap.code !== 0) throw new Error('No se pudieron aplicar los archivos (código ' + ap.code + ')');

      if (cfg.postCommands.trim()) {
        job.check();
        job.step('Ejecutando comandos posteriores…');
        const r = await runScript(this.conn, pid, postScript(dir, cfg.postCommands), job);
        if (r.code !== 0) throw new Error('Un comando posterior falló (código ' + r.code + '). La app NO se reinició.');
      }

      if (cfg.after !== 'none') {
        job.check();
        job.step(cfg.after === 'reload' ? 'Recargando en PM2…' : 'Reiniciando en PM2…');
        await this.pm2.action(pid, cfg.after, app.pm2Name, cfg.updateEnv);
        job.step('Comprobando que la app quedó en línea…');
        await new Promise((r) => setTimeout(r, 3000));
        const g = (await this.pm2.list(pid)).find((x) => x.name === app.pm2Name);
        if (!g || g.status !== 'online') {
          const errLog = g?.errLog ? await this.conn.run(pid, `tail -n 15 -- ${sq(g.errLog)} 2>/dev/null`).then((r) => r.stdout.trim()).catch(() => '') : '';
          throw new Error(`La app no quedó en línea (estado: ${g?.status ?? 'desconocido'})${errLog ? '\n' + errLog : ''}`);
        }
        job.say('  La app está en línea');
      }

      const record: DeployRecord = { id: uid(), appId: app.id, at: started, source: sourceLabel(src), ok: true, backup: backupName, summary: `Completado en ${Math.round((Date.now() - started) / 1000)} s` };
      await this.store.addDeploy(record);
      job.step('Deploy completado');
      job.finish();
      return { record, backupName };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const record: DeployRecord = { id: uid(), appId: app.id, at: started, source: sourceLabel(src), ok: false, backup: backupName, summary: msg.split('\n')[0].slice(0, 200) };
      if (msg !== 'Cancelado') await this.store.addDeploy(record);
      job.say('✖ ' + msg);
      job.finish(msg);
      return { record, backupName };
    } finally {
      await this.conn.run(pid, `rm -rf -- ${sq(stage)}`).catch(() => { /* limpieza best-effort */ });
    }
  }

  private async upload(app: TrackedApp, src: DeploySource, stage: string, content: string, job: Job) {
    const items: UploadItem[] =
      src.kind === 'archive' ? [{ local: src.file.ref, remote: `${stage}/upload${archiveExt(src.file.name)}`, size: src.file.size }]
      : src.kind === 'files' ? src.files.map((f) => ({ local: f.ref, remote: `${content}/${f.name}`, size: f.size }))
      : src.files.map((f) => ({ local: joinLocal(src.root, f.path), remote: `${content}/${f.path}`, size: f.size }));
    if (!items.length) throw new Error('No hay archivos para subir');
    const total = items.reduce((a, i) => a + i.size, 0);
    job.step(`Subiendo ${items.length} archivo(s)…`, 0);
    const jobId = uid();
    const off = this.conn.onProgress((e) => {
      if (e.jobId !== jobId) return;
      job.progress(e.total ? Math.round((e.loaded / e.total) * 100) : null, `Subiendo ${items.length} archivo(s)… ${e.current ? e.current.split('/').pop() : ''}`);
    });
    const stop = job.onCancel(() => this.conn.cancelJob(jobId));
    try { await this.conn.uploadMany(app.profileId, jobId, items); }
    finally { off(); stop(); }
    job.check();
    job.progress(100);
    job.say(`  Subidos ${items.length} archivo(s), ${total} bytes`);
  }

  /** Vuelve al estado de la copia previa y reinicia la app. */
  async rollback(app: TrackedApp, dir: string, backupName: string, job: Job): Promise<void> {
    job.start();
    try {
      await this.backups.restoreServer(app, dir, backupName, job);
      if (app.config.deploy.after !== 'none') {
        job.step('Reiniciando en PM2…');
        await this.pm2.action(app.profileId, app.config.deploy.after, app.pm2Name, app.config.deploy.updateEnv);
      }
      job.step('Restauración completada');
      job.finish();
    } catch (e: any) { job.say('✖ ' + e.message); job.finish(String(e.message)); }
  }
}

const joinLocal = (root: string, rel: string) => {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
};
