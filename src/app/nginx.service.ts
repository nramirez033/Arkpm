import { Injectable, inject } from '@angular/core';
import { toBase64 } from './bytes';
import { ConnectionService } from './connection.service';
import { DialogService } from './dialog.service';
import { NginxProbe, NginxSite, FileKind, buildSites, certbotScript, certInfoScript, ctlScript, deleteScript, installScript, logScript, nginxProbeScript, nginxReadScript, parseCerts, parseNginxFiles, parseNginxProbe, testScript, toggleScript } from './nginx';
import { StoreService } from './store.service';

export interface OpResult { ok: boolean; reloaded?: boolean; output: string; }

/**
 * Administración de nginx por SSH. Leer es posible sin privilegios; cambiar algo exige root o sudo. Si el sudo del usuario pide
 * contraseña se pregunta una vez y se recuerda SOLO en memoria mientras la app esté abierta (viaja por la entrada estándar,
 * nunca en la línea de comandos).
 */
@Injectable({ providedIn: 'root' })
export class NginxService {
  private readonly conn = inject(ConnectionService);
  private readonly dialogs = inject(DialogService);
  private readonly store = inject(StoreService);
  private sudoPw = new Map<string, string>();

  forgetSudo(profileId: string) { this.sudoPw.delete(profileId); }
  hasSudo(profileId: string) { return this.sudoPw.has(profileId); }

  async probe(pid: string): Promise<NginxProbe> {
    const r = await this.conn.run(pid, nginxProbeScript(), { timeoutMs: 30000 });
    return parseNginxProbe(r.stdout);
  }

  async sites(pid: string): Promise<NginxSite[]> {
    const r = await this.conn.run(pid, nginxReadScript(), { timeoutMs: 40000 });
    const files = parseNginxFiles(r.stdout);
    if (!files.length) throw new Error('No se pudo leer /etc/nginx (¿otra ruta de instalación o sin permiso de lectura?).');
    return buildSites(files).sort((a, b) => (a.file.kind === 'main' ? -1 : b.file.kind === 'main' ? 1 : a.name.localeCompare(b.name)));
  }

  /** Ejecuta un script con privilegios, pidiendo la contraseña de sudo si hace falta. */
  private async priv(pid: string, probe: NginxProbe, script: string, timeoutMs = 90000): Promise<string> {
    if (probe.sudo === 'none') throw new Error('Este usuario no tiene sudo en el servidor: solo puede ver la configuración. Entra con un usuario con permisos (root o sudo).');
    const profile = this.store.profiles().find((p) => p.id === pid);
    for (let attempt = 0; attempt < 3; attempt++) {
      let pw: string | undefined;
      if (probe.sudo === 'password') {
        pw = this.sudoPw.get(pid);
        if (pw === undefined) {
          const a = profile ? await this.dialogs.secret(profile, 'sudo', attempt > 0) : null;
          if (!a) throw new Error('Cancelado: hace falta la contraseña de sudo.');
          pw = a.value;
        }
      }
      const r = await this.conn.run(pid, script, { stdin: pw === undefined ? undefined : pw + '\n', timeoutMs });
      if (/SUDO_FAIL/.test(r.stdout)) { this.sudoPw.delete(pid); if (probe.sudo !== 'password') throw new Error('sudo rechazó el comando.'); continue; }
      if (pw !== undefined) this.sudoPw.set(pid, pw);
      return r.stdout + (r.stderr ? '\n' + r.stderr : '');
    }
    throw new Error('La contraseña de sudo no fue aceptada.');
  }

  async ctl(pid: string, probe: NginxProbe, action: 'start' | 'stop' | 'restart' | 'reload'): Promise<{ active: boolean; output: string }> {
    const out = await this.priv(pid, probe, ctlScript(probe.bin, action));
    return { active: /RESULT=active/.test(out), output: out.replace(/RESULT=\w+\n?|RC=\d+\n?/g, '').trim() };
  }

  async test(pid: string, probe: NginxProbe): Promise<OpResult> {
    const out = await this.priv(pid, probe, testScript(probe.bin));
    return { ok: /TEST_OK/.test(out), output: out.replace(/TEST_(OK|FAIL)\n?/, '').trim() };
  }

  /** Guarda el contenido en `dest` con copia de seguridad; si nginx -t lo rechaza, se restaura lo anterior. */
  async save(pid: string, probe: NginxProbe, dest: string, content: string, o: { link?: string; reload: boolean }): Promise<OpResult> {
    const tmp = `/tmp/arkpm-nginx-${Math.random().toString(36).slice(2, 10)}.conf`;
    await this.conn.writeFile(pid, tmp, toBase64(new TextEncoder().encode(content.endsWith('\n') ? content : content + '\n')));
    try {
      const out = await this.priv(pid, probe, installScript(probe.bin, tmp, dest, o));
      return { ok: /\nOK\s*$|^OK\s*$/.test(out.trim()) || out.trim().endsWith('OK'), reloaded: /RELOADED/.test(out), output: out.replace(/\b(OK|RELOADED|TEST_FAIL)\b\n?/g, '').trim() };
    } finally { this.conn.run(pid, `rm -f ${JSON.stringify(tmp)}`).catch(() => { /* limpieza */ }); }
  }

  async toggle(pid: string, probe: NginxProbe, kind: FileKind, path: string, enable: boolean): Promise<OpResult> {
    const out = await this.priv(pid, probe, toggleScript(probe.bin, kind, path, enable));
    return { ok: out.trim().endsWith('OK'), output: out.replace(/\b(OK|TEST_FAIL|ACTION_FAIL)\b\n?/g, '').trim() };
  }

  async remove(pid: string, probe: NginxProbe, kind: FileKind, path: string): Promise<OpResult> {
    const out = await this.priv(pid, probe, deleteScript(probe.bin, kind, path));
    return { ok: out.trim().endsWith('OK'), output: out.replace(/\b(OK|TEST_FAIL|BACKUP_FAIL)\b\n?/g, '').trim() };
  }

  async logs(pid: string, probe: NginxProbe, kind: 'error' | 'access', lines: number): Promise<string> {
    return (await this.priv(pid, probe, logScript(kind, lines), 40000)).trim();
  }

  async certs(pid: string, probe: NginxProbe, paths: string[]): Promise<Map<string, Date | null>> {
    if (!paths.length) return new Map();
    return parseCerts(await this.priv(pid, probe, certInfoScript(paths), 40000));
  }

  async certbot(pid: string, probe: NginxProbe, domains: string[], email: string): Promise<OpResult> {
    const out = await this.priv(pid, probe, certbotScript(domains, email), 240000);
    return { ok: /RC=0/.test(out), output: out.replace(/RC=\d+\n?/, '').trim() };
  }
}
