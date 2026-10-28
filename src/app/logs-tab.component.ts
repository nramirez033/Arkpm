import { Component, ElementRef, OnDestroy, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionService, StreamHandle } from './connection.service';
import { DialogService, ToastService } from './dialog.service';
import { IconComponent } from './icon.component';
import { stripAnsi } from './job';
import { sq } from './remote';
import { WorkspaceService } from './workspace.service';

interface Line { t: string; e: boolean; s: 'out' | 'err'; }
type Kind = 'out' | 'err' | 'both';
const MAX = 2500, KEEP = 2000;
const ERR_RE = /\b(error|exception|fatal|unhandled|ECONN\w*|ENOENT|EADDRINUSE|ERR_[A-Z_]+|TypeError|ReferenceError)\b/i;
const WARN_RE = /\b(warn(ing)?|deprecated)\b/i;

/** Logs de PM2 en vivo: `tail -F` sobre los archivos de log de la app, con filtro, pausa y seguimiento automático. */
@Component({
  selector: 'app-logs-tab',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="col full">
      <div class="row wrapr">
        <div class="seg"><button [class.on]="kind() === 'out'" (click)="setKind('out')">Salida</button><button [class.on]="kind() === 'err'" (click)="setKind('err')">Errores</button><button [class.on]="kind() === 'both'" (click)="setKind('both')">Ambos</button></div>
        <select style="width:auto" [ngModel]="count()" (ngModelChange)="count.set(+$event); restart()" aria-label="Líneas iniciales">
          <option [value]="100">100 líneas</option><option [value]="300">300 líneas</option><option [value]="1000">1000 líneas</option></select>
        <div class="grow search"><app-icon name="search" [size]="15" /><input [ngModel]="filter()" (ngModelChange)="filter.set($event)" placeholder="Filtrar…" /></div>
        <button class="btn sm" [class.sec]="live()" (click)="toggleLive()">{{ live() ? 'En vivo' : 'Pausado' }}<app-icon [name]="live() ? 'pause' : 'play'" [size]="14" /></button>
        <button class="btn sm ghost icon" (click)="menu()" aria-label="Más"><app-icon name="more" /></button>
      </div>
      @if (!path(); as _) { <div class="banner"><app-icon name="alert" /><div>PM2 no informó archivos de log para esta app (¿usa <code>--no-log</code> o aún no inició?).</div></div> }
      @if (error()) { <div class="banner err"><app-icon name="alert" /><div>{{ error() }}</div></div> }
      <div class="boxwrap">
        <div #box class="logbox" [class.nowrap]="!wrap()" (scroll)="onScroll()">
          @for (l of shown(); track $index) { <div class="ln" [class.e]="l.e" [class.w]="!l.e && l.w">{{ l.t }}</div> }
          @if (!shown().length) { <div class="mut">{{ loading() ? 'Cargando…' : filter() ? 'Ninguna línea coincide con el filtro.' : 'Sin líneas todavía.' }}</div> }
        </div>
        @if (!follow() && shown().length) { <button class="btn sm down" (click)="toEnd()"><app-icon name="chevrons-down" [size]="16" />Ir al final</button> }
      </div>
      <div class="row small mut"><span>{{ shown().length }} líneas{{ filter() ? ' (filtradas)' : '' }}</span><span class="grow"></span>
        <label class="chk" style="min-height:24px"><input type="checkbox" [ngModel]="wrap()" (ngModelChange)="wrap.set($event)" /><span>Ajustar línea</span></label></div>
    </div>`,
  styles: [`
    :host { display:flex; flex-direction:column; flex:1; min-height:0; } .full { flex:1; min-height:0; }
    .boxwrap { position:relative; flex:1; min-height:200px; display:flex; } .logbox { flex:1; min-width:0; }
    .down { position:absolute; right:14px; bottom:12px; box-shadow:0 4px 16px rgba(0,0,0,.5); }
    .search { display:flex; align-items:center; gap:6px; background:var(--field); border-radius:8px; padding-left:10px; min-width:130px; } .search input { border:0; background:transparent; }
  `],
})
export class LogsTabComponent implements OnDestroy {
  readonly active = input(true);
  readonly ws = inject(WorkspaceService);
  private readonly conn = inject(ConnectionService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);
  private readonly box = viewChild<ElementRef<HTMLDivElement>>('box');

  readonly kind = signal<Kind>('out');
  readonly count = signal(300);
  readonly live = signal(true);
  readonly wrap = signal(true);
  readonly filter = signal('');
  readonly follow = signal(true);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly lines = signal<(Line & { w: boolean })[]>([]);
  private handles: StreamHandle[] = [];
  private gen = 0;
  private partial: Record<string, string> = { out: '', err: '' };

  readonly shown = () => { const f = this.filter().trim().toLowerCase(); const l = this.lines(); return f ? l.filter((x) => x.t.toLowerCase().includes(f)) : l; };
  path() { const g = this.ws.group(); return g ? (this.kind() === 'err' ? g.errLog : g.outLog) || (this.kind() === 'both' ? g.errLog : '') : ''; }

  constructor() {
    // se conecta al abrir la pestaña (o al cambiar de app) y se corta al salir de ella
    effect(() => {
      const on = this.active(), has = !!this.ws.group()?.outLog || !!this.ws.group()?.errLog, connected = this.ws.state() === 'connected';
      untracked(() => { if (on && has && connected) { if (!this.handles.length) this.restart(); } else if (!on) this.stop(); });
    });
    effect(() => { this.lines(); this.shown(); queueMicrotask(() => { if (this.follow()) this.toEnd(false); }); });
  }

  ngOnDestroy() { this.stop(); }

  setKind(k: Kind) { this.kind.set(k); this.restart(); }
  toggleLive() { this.live.update((v) => !v); if (this.live()) this.restart(); else this.stop(); }

  stop() { this.gen++; for (const h of this.handles) h.stop(); this.handles = []; }

  async restart() {
    this.stop();
    const g = this.ws.group(), pid = this.ws.profileId();
    if (!g || !pid) return;
    const files: { f: string; s: 'out' | 'err' }[] = [];
    if ((this.kind() !== 'err') && g.outLog) files.push({ f: g.outLog, s: 'out' });
    if ((this.kind() !== 'out') && g.errLog) files.push({ f: g.errLog, s: 'err' });
    if (!files.length) { this.lines.set([]); return; }
    const gen = ++this.gen;
    this.lines.set([]); this.error.set(''); this.loading.set(true); this.follow.set(true);
    this.partial = { out: '', err: '' };
    try {
      for (const { f, s } of files) {
        const cmd = `tail -n ${this.count()} ${this.live() ? '-F' : ''} -- ${sq(f)} 2>&1`;
        const h = await this.conn.stream(pid, cmd, (d) => { if (gen === this.gen) this.feed(s, d); }, { pty: true, raw: true });
        if (gen !== this.gen) { h.stop(); return; }
        this.handles.push(h);
        h.done.then((code) => { if (gen === this.gen && code && code !== 0 && !this.lines().length) this.error.set('No se pudo leer ' + f); });
      }
    } catch (e: any) { this.error.set(String(e?.message ?? e)); }
    finally { setTimeout(() => this.loading.set(false), 400); }
  }

  private feed(s: 'out' | 'err', chunk: string) {
    const text = this.partial[s] + stripAnsi(chunk).replace(/\r/g, '');
    const parts = text.split('\n');
    this.partial[s] = parts.pop() ?? '';
    if (!parts.length) return;
    const add = parts.map((t) => ({ t, s, e: s === 'err' || ERR_RE.test(t), w: WARN_RE.test(t) }));
    this.lines.update((l) => { const n = l.concat(add); return n.length > MAX ? n.slice(n.length - KEEP) : n; });
  }

  onScroll() {
    const el = this.box()?.nativeElement;
    if (!el) return;
    this.follow.set(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }
  toEnd(force = true) {
    const el = this.box()?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (force) this.follow.set(true);
  }

  async menu() {
    const r = await this.dialogs.menu('Logs', [
      { id: 'reload', label: 'Recargar', icon: 'refresh' },
      { id: 'copy', label: 'Copiar lo que se ve', icon: 'copy' },
      { id: 'clear', label: 'Limpiar la vista', icon: 'close' },
      { id: 'flush', label: 'Vaciar los logs en el servidor (pm2 flush)', icon: 'trash', danger: true },
    ]);
    if (r === 'reload') { this.live.set(true); this.restart(); }
    else if (r === 'copy') { try { await navigator.clipboard.writeText(this.shown().map((l) => l.t).join('\n')); this.toast.ok('Copiado'); } catch { this.toast.show('No se pudo copiar', 'err'); } }
    else if (r === 'clear') this.lines.set([]);
    else if (r === 'flush') {
      const g = this.ws.group();
      if (g && await this.dialogs.confirm({ title: 'Vaciar logs', message: `Se vaciarán los archivos de log de «${g.name}» en el servidor. No se puede deshacer.`, okText: 'Vaciar', danger: true })) {
        const r2 = await this.conn.run(this.ws.profileId()!, `${this.ws.profile()?.pm2Cmd || 'pm2'} flush ${sq(g.name)} 2>&1`);
        if (r2.code === 0) { this.toast.ok('Logs vaciados'); this.lines.set([]); } else this.toast.show(r2.stdout.trim() || 'No se pudo vaciar', 'err');
      }
    }
  }
}
