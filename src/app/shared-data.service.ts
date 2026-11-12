import { Injectable, inject } from '@angular/core';
import { ConnectionService } from './connection.service';
import { AppConfig, AppNote, DEFAULT_CONFIG, SharedConfig } from './models';
import { SharedRead, parseSharedRead, sharedDeleteScript, sharedDir, sharedReadScript, sharedWriteScript } from './remote';

export type WriteResult = 'ok' | 'conflict';

/** Acceso a `<carpeta de la app>/.arkpm` en el servidor: notas y configuración compartidas entre usuarios y conexiones. */
@Injectable({ providedIn: 'root' })
export class SharedDataService {
  private readonly conn = inject(ConnectionService);

  async read(profileId: string, appDir: string): Promise<SharedRead> {
    const r = await this.conn.run(profileId, sharedReadScript(sharedDir(appDir)), { timeoutMs: 30000 });
    return parseSharedRead(r.stdout);
  }

  private async write(profileId: string, appDir: string, rel: string, field: 'updatedAt' | 'rev', expected: number | null, obj: unknown): Promise<WriteResult> {
    // el código de salida de «bash -l» no es fiable en todos los servidores: se decide por lo que imprime el script
    const r = await this.conn.run(profileId, sharedWriteScript(sharedDir(appDir), rel, field, expected), { stdin: JSON.stringify(obj), timeoutMs: 30000 });
    if (/CONFLICT/.test(r.stdout)) return 'conflict';
    if (/\bOK\b/.test(r.stdout)) return 'ok';
    throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || 'No se pudo escribir en el servidor');
  }

  writeNote(profileId: string, appDir: string, n: AppNote, expectedUpdatedAt: number | null) {
    const { id, text, createdAt, updatedAt, author } = n;
    return this.write(profileId, appDir, `notes/${id}.json`, 'updatedAt', expectedUpdatedAt, { id, text, createdAt, updatedAt, author });
  }
  async deleteNote(profileId: string, appDir: string, id: string) { await this.conn.run(profileId, sharedDeleteScript(sharedDir(appDir), id), { timeoutMs: 20000 }); }
  writeConfig(profileId: string, appDir: string, cfg: SharedConfig, expectedRev: number | null) { return this.write(profileId, appDir, 'config.json', 'rev', expectedRev, cfg); }
}

/** Completa con valores por defecto lo que falte (archivo editado a mano o de otra versión). */
export function normalizeShared(raw: any): SharedConfig | null {
  if (!raw || typeof raw !== 'object' || !raw.deploy || !raw.backup) return null;
  const d = DEFAULT_CONFIG();
  const { saveDir: _a, saveDirLabel: _b, ...bk } = d.backup;
  return { rev: Number(raw.rev) || 0, updatedAt: Number(raw.updatedAt) || 0, updatedBy: String(raw.updatedBy ?? ''), deploy: { ...d.deploy, ...raw.deploy }, backup: { ...bk, ...raw.backup } };
}

export const stripDevice = (b: AppConfig['backup']): SharedConfig['backup'] => { const { saveDir: _a, saveDirLabel: _b, ...rest } = b; return rest; };

/** Configuración del servidor + los datos que solo valen en este dispositivo (carpeta de destino de los backups). */
export const mergeShared = (local: AppConfig, srv: SharedConfig): AppConfig => ({
  deploy: structuredClone(srv.deploy),
  backup: { ...structuredClone(srv.backup), saveDir: local.backup.saveDir, saveDirLabel: local.backup.saveDirLabel },
});
