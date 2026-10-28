import { Injectable, inject } from '@angular/core';
import { ConnectionService } from './connection.service';
import { Pm2Group, Pm2Proc, Pm2Status, ServerProfile } from './models';
import { Pm2NewSpec, extractJson, pm2NewScript, pm2Script } from './remote';
import { NotifyService } from './notify.service';
import { StoreService } from './store.service';

export type Pm2Verb = 'start' | 'stop' | 'restart' | 'reload' | 'delete';

const STATUSES: Pm2Status[] = ['online', 'stopped', 'errored', 'launching', 'stopping', 'one-launch-status'];

function toProc(p: any): Pm2Proc {
  const e = p.pm2_env ?? {};
  return {
    pmId: Number(p.pm_id ?? e.pm_id ?? 0), name: String(p.name ?? e.name ?? ''),
    status: (STATUSES.includes(e.status) ? e.status : 'unknown') as Pm2Status,
    cpu: Number(p.monit?.cpu ?? 0), memory: Number(p.monit?.memory ?? 0),
    startedAt: e.status === 'online' ? Number(e.pm_uptime ?? 0) : 0,
    restarts: Number(e.restart_time ?? 0), unstable: Number(e.unstable_restarts ?? 0), pid: Number(p.pid ?? 0),
    mode: e.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
    script: String(e.pm_exec_path ?? ''), args: Array.isArray(e.args) ? e.args.join(' ') : String(e.args ?? ''),
    cwd: String(e.pm_cwd ?? ''), outLog: String(e.pm_out_log_path ?? ''), errLog: String(e.pm_err_log_path ?? ''),
    interpreter: String(e.exec_interpreter ?? ''), nodeVersion: String(e.node_version ?? ''), namespace: String(e.namespace ?? ''),
  };
}

export function group(procs: Pm2Proc[]): Pm2Group[] {
  const by = new Map<string, Pm2Proc[]>();
  for (const p of procs) by.set(p.name, [...(by.get(p.name) ?? []), p]);
  return [...by].map(([name, ps]) => {
    const on = ps.filter((p) => p.status === 'online').length;
    const status: Pm2Group['status'] = on === ps.length ? 'online' : on > 0 ? 'partial'
      : ps.some((p) => p.status === 'errored') ? 'errored' : ps.some((p) => p.status === 'launching') ? 'launching' : 'stopped';
    return {
      name, procs: ps, status,
      cpu: ps.reduce((a, p) => a + p.cpu, 0), memory: ps.reduce((a, p) => a + p.memory, 0), restarts: ps.reduce((a, p) => a + p.restarts, 0),
      startedAt: Math.min(...ps.filter((p) => p.startedAt).map((p) => p.startedAt), Infinity) === Infinity ? 0 : Math.min(...ps.filter((p) => p.startedAt).map((p) => p.startedAt)),
      cwd: ps[0].cwd, outLog: ps[0].outLog, errLog: ps[0].errLog,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

@Injectable({ providedIn: 'root' })
export class Pm2Service {
  private readonly conn = inject(ConnectionService);
  private readonly store = inject(StoreService);
  private readonly notify = inject(NotifyService);

  private cmd(p: ServerProfile) { return (p.pm2Cmd || 'pm2').trim() || 'pm2'; }
  private prof(id: string) { const p = this.store.profiles().find((x) => x.id === id); if (!p) throw new Error('El servidor ya no existe'); return p; }

  async list(profileId: string): Promise<Pm2Group[]> {
    const p = this.prof(profileId);
    const r = await this.conn.run(profileId, `${this.cmd(p)} jlist`, { timeoutMs: 30000 });
    if (/command not found|not found: pm2|No such file/i.test(r.stderr + r.stdout) && !r.stdout.includes('[{')) {
      throw new Error('PM2 no está instalado o no está en el PATH de este usuario. Revisa «Comando de PM2» y «Preparar entorno» en los ajustes avanzados del servidor.');
    }
    return group(extractJson(r.stdout).map(toProc));
  }

  async action(profileId: string, verb: Pm2Verb, name: string, updateEnv = false): Promise<string> {
    const p = this.prof(profileId);
    this.notify.mute(profileId, name);   // lo hace el usuario desde la app: el vigilante no debe avisar
    const r = await this.conn.run(profileId, pm2Script(this.cmd(p), verb, name, updateEnv), { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(this.tail(r.stdout + r.stderr) || `pm2 ${verb} terminó con código ${r.code}`);
    return r.stdout;
  }

  /** Registra y arranca un servicio nuevo con «pm2 start». Con `save` también ejecuta «pm2 save». */
  async create(profileId: string, spec: Pm2NewSpec, save: boolean): Promise<string> {
    const p = this.prof(profileId);
    this.notify.mute(profileId, spec.name);
    const r = await this.conn.run(profileId, pm2NewScript(this.cmd(p), spec), { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(this.tail(r.stdout + r.stderr) || `pm2 start terminó con código ${r.code}`);
    if (save) await this.save(profileId).catch(() => { /* no crítico */ });
    return r.stdout;
  }

  async save(profileId: string) {
    const r = await this.conn.run(profileId, `${this.cmd(this.prof(profileId))} save --force 2>&1`);
    if (r.code !== 0) throw new Error(this.tail(r.stdout + r.stderr));
  }

  private tail(s: string) { return s.replace(/\u001b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join('\n'); }
}
