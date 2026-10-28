import { signal } from '@angular/core';
import { ConnectionService } from './connection.service';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Una operación larga (backup, deploy…): fase actual, porcentaje, registro de líneas y cancelación. */
export class Job {
  readonly phase = signal('');
  readonly pct = signal<number | null>(null);
  readonly log = signal<string[]>([]);
  readonly running = signal(false);
  readonly error = signal('');
  readonly done = signal(false);
  cancelled = false;
  private stops = new Set<() => void>();

  say(line: string) { this.log.update((l) => [...l.slice(-499), line]); }
  step(phase: string, pct: number | null = null) { this.phase.set(phase); this.pct.set(pct); this.say('▶ ' + phase); }
  progress(pct: number | null, text?: string) { this.pct.set(pct); if (text) this.phase.set(text); }
  onCancel(fn: () => void): () => void { this.stops.add(fn); return () => this.stops.delete(fn); }
  cancel() { this.cancelled = true; for (const f of [...this.stops]) { try { f(); } catch { /* nada */ } } }
  check() { if (this.cancelled) throw new Error('Cancelado'); }
  start() { this.cancelled = false; this.running.set(true); this.error.set(''); this.done.set(false); this.log.set([]); this.pct.set(null); this.phase.set(''); }
  finish(err = '') { this.running.set(false); this.error.set(err); this.done.set(true); this.stops.clear(); }
}

/** Ejecuta un script remoto mostrando su salida en el registro del trabajo; se puede cancelar. */
export async function runScript(conn: ConnectionService, profileId: string, script: string, job: Job, o?: { quiet?: boolean }): Promise<{ code: number | null; out: string }> {
  let buf = '', out = '';
  const flush = (all: boolean) => {
    const parts = buf.split('\n');
    buf = all ? '' : (parts.pop() ?? '');
    if (all && parts.length && parts[parts.length - 1] === '') parts.pop();
    for (const l of parts) { const t = stripAnsi(l).replace(/\r/g, '').trimEnd(); if (t && !o?.quiet) job.say('  ' + t.slice(0, 400)); }
  };
  const h = await conn.stream(profileId, script, (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); buf += d; flush(false); });
  const off = job.onCancel(() => h.stop());
  const code = await h.done;
  off();
  flush(true);
  if (job.cancelled) throw new Error('Cancelado');
  return { code, out };
}
