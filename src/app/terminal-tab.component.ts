import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionService, StreamHandle } from './connection.service';
import { DialogService, ToastService } from './dialog.service';
import { IconComponent } from './icon.component';
import { stripAnsi } from './job';
import { LayoutService } from './layout.service';
import { NotifyService } from './notify.service';
import { isRiskyCommand, parseTermMarker, terminalScript } from './remote';
import { StoreService } from './store.service';
import { WorkspaceService } from './workspace.service';

interface TLine { t: string; k: 'cmd' | 'out' | 'err' | 'sys'; }
const MAX_LINES = 3000;
const QUICK = ['ls -la', 'git pull', 'git log --oneline -5', 'npm install', 'npm run build', 'cat package.json', 'df -h .', 'du -sh * | sort -h', 'pm2 status'];

/**
 * Consola de la app: cada comando se ejecuta en la carpeta de la app (el `cd` se mantiene entre comandos), con el PATH
 * del usuario y nvm. No es una shell interactiva: los programas que esperan teclado (nano, top, ssh…) no funcionan;
 * la entrada estándar está vacía para que nada se quede colgado.
 */
@Component({
  selector: 'app-terminal-tab',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="col full">
      <div class="row wrapr">
        <div class="grow mono small ell mut" [title]="cwd()"><app-icon name="folder" [size]="14" /> {{ shortCwd() }}</div>
        @if (cwd() !== ws.appDir()) { <button class="btn sm sec" (click)="cwd.set(ws.appDir())" title="Volver a la carpeta de la app"><app-icon name="package" [size]="15" />Carpeta de la app</button> }
        @if (running()) { <button class="btn sm danger" (click)="stop()"><app-icon name="stop" [size]="15" />Detener</button> }
        <button class="btn sm ghost icon" (click)="clear()" aria-label="Limpiar" title="Limpiar (Ctrl+L)"><app-icon name="trash" /></button>
      </div>

      <div #box class="logbox term" (click)="focusInput()">
        @if (!lines().length && !partial()) {
          <div class="mut">Escribe un comando y pulsa Enter: se ejecuta en <span class="mono">{{ ws.appDir() || 'la carpeta de la app' }}</span> como <b>{{ user() }}</b>. El <code>cd</code> se mantiene entre comandos.<br>
            No admite programas interactivos (<code>nano</code>, <code>top</code>, <code>vim</code>…); usa por ejemplo <code>top -bn1</code>. Ctrl+C detiene el comando en curso.</div>
        }
        @for (l of lines(); track $index) { <div class="ln" [class.cmd]="l.k === 'cmd'" [class.e]="l.k === 'err'" [class.s]="l.k === 'sys'">{{ l.t }}</div> }
        @if (partial()) { <div class="ln">{{ partial() }}</div> }
        @if (running()) { <div class="ln mut spin-dots">▍</div> }
      </div>

      <div class="chips">@for (q of quick; track q) { <button class="chip" (click)="fill(q)">{{ q }}</button> }</div>

      <div class="prompt row">
        <span class="mono small mut ps">{{ prompt() }}</span>
        <input #inp class="mono grow" [(ngModel)]="text" (keydown)="onKey($event)" [disabled]="false" placeholder="comando…" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" />
        <button class="btn icon" (click)="submit()" [disabled]="running() || !text.trim()" aria-label="Ejecutar" title="Ejecutar (Enter)"><app-icon name="play" [size]="18" /></button>
      </div>
    </div>`,
  styles: [`
    :host { display:flex; flex-direction:column; flex:1; min-height:0; } .full { flex:1; min-height:0; }
    .term { flex:1; min-height:160px; cursor:text; } .ln.cmd { color:var(--acc2); font-weight:600; }
    .chips { display:flex; gap:6px; overflow-x:auto; padding-bottom:2px; scrollbar-width:none; } .chips::-webkit-scrollbar { display:none; }
    .chip { flex:none; border:1px solid var(--line); background:var(--field); color:var(--mut); border-radius:999px; padding:3px 10px; font:12px "Cascadia Mono",Consolas,monospace; cursor:pointer; white-space:nowrap; min-height:26px; } .chip:hover { color:var(--txt); border-color:var(--acc); }
    .prompt { background:var(--field); border-radius:10px; padding:2px 4px 2px 12px; } .ps { white-space:nowrap; max-width:42%; overflow:hidden; text-overflow:ellipsis; }
    .prompt input { background:transparent; border:0; }
  `],
})
export class TerminalTabComponent implements OnDestroy {
  readonly active = input(true);
  readonly ws = inject(WorkspaceService);
  readonly layout = inject(LayoutService);
  private readonly conn = inject(ConnectionService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);
  private readonly notify = inject(NotifyService);
  private readonly store = inject(StoreService);
  private readonly box = viewChild<ElementRef<HTMLDivElement>>('box');
  private readonly inp = viewChild<ElementRef<HTMLInputElement>>('inp');

  readonly quick = QUICK;
  readonly lines = signal<TLine[]>([]);
  readonly partial = signal('');
  readonly running = signal(false);
  readonly cwd = signal('');
  text = '';
  private history: string[] = [];
  private hi = -1;
  private handle: StreamHandle | null = null;

  readonly user = computed(() => this.ws.profile()?.username ?? '');
  readonly shortCwd = computed(() => this.short(this.cwd()));
  readonly prompt = computed(() => `${this.user()}@${this.ws.profile()?.host ?? ''}:${this.short(this.cwd())}$`);

  constructor() {
    effect(() => { const d = this.ws.appDir(); if (d && !this.cwd()) this.cwd.set(d); }, { allowSignalWrites: true });
    effect(() => { this.lines(); this.partial(); queueMicrotask(() => { const el = this.box()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }); });
    effect(() => { if (this.active() && !this.layout.touch) queueMicrotask(() => this.inp()?.nativeElement.focus()); });
    const a = this.ws.app();
    if (a) this.history = this.store.getSetting<string[]>('termhist:' + a.id, []);
  }

  ngOnDestroy() { this.handle?.stop(); }

  private short(p: string) { const home = this.conn.home(this.ws.profileId() ?? ''); return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p; }
  focusInput() { if (!getSelection()?.toString()) this.inp()?.nativeElement.focus(); }
  fill(c: string) { this.text = c; this.inp()?.nativeElement.focus(); }
  clear() { this.lines.set([]); this.partial.set(''); }
  stop() { this.handle?.stop(); }

  onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (this.history.length) { this.hi = Math.min(this.hi + 1, this.history.length - 1); this.text = this.history[this.history.length - 1 - this.hi]; } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.hi = Math.max(this.hi - 1, -1); this.text = this.hi < 0 ? '' : this.history[this.history.length - 1 - this.hi]; }
    else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); this.clear(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c' && this.running() && !getSelection()?.toString()) { e.preventDefault(); this.stop(); }
  }

  async submit() {
    const cmd = this.text.trim();
    if (!cmd || this.running()) return;
    if (/^(clear|cls)$/.test(cmd)) { this.text = ''; this.clear(); return; }
    if (isRiskyCommand(cmd) && !(await this.dialogs.confirm({ title: 'Comando delicado', danger: true, okText: 'Ejecutar', message: `Este comando puede borrar o dañar datos en el servidor:\n\n${cmd}\n\nSe ejecutará como ${this.user()} en ${this.cwd()}.` }))) return;
    this.text = ''; this.hi = -1;
    if (this.history[this.history.length - 1] !== cmd) { this.history.push(cmd); this.history = this.history.slice(-100); const a = this.ws.app(); if (a) this.store.setSetting('termhist:' + a.id, this.history); }
    await this.run(cmd);
  }

  private push(l: TLine) { this.lines.update((a) => { const n = a.concat(l); return n.length > MAX_LINES ? n.slice(n.length - MAX_LINES + 500) : n; }); }

  private async run(cmd: string) {
    const pid = this.ws.profileId(), app = this.ws.app();
    if (!pid || !app) return;
    this.push({ t: `${this.prompt()} ${cmd}`, k: 'cmd' });
    this.running.set(true);
    if (/\bpm2\b/.test(cmd)) this.notify.mute(pid, app.pm2Name);   // lo escribió el usuario: el vigilante no debe avisar de ello
    let buf = '', gotMarker = false;
    const handleLine = (raw: string) => {
      const line = stripAnsi(raw.includes('\r') ? raw.split('\r').filter((x, i, a) => x || i === a.length - 1).pop()! : raw);
      const m = parseTermMarker(line);
      if (m) {
        gotMarker = true; this.cwd.set(m.cwd);
        this.lines.update((a) => (a.length && a[a.length - 1].t === '' && a[a.length - 1].k === 'out' ? a.slice(0, -1) : a));
        if (m.code !== 0) this.push({ t: `✖ código de salida ${m.code}`, k: 'err' });
      } else this.push({ t: line, k: 'out' });
    };
    try {
      this.handle = await this.conn.stream(pid, terminalScript(this.cwd() || this.ws.appDir(), this.ws.appDir(), cmd), (d) => {
        buf += d.replace(/\r\n/g, '\n');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
        this.partial.set(stripAnsi(buf.includes('\r') ? buf.split('\r').pop()! : buf));
      }, { pty: true });
      const code = await this.handle.done;
      if (buf) { handleLine(buf); buf = ''; }
      this.partial.set('');
      if (!gotMarker) this.push({ t: code === null ? '■ comando detenido' : `■ el comando terminó (código ${code})`, k: 'sys' });
    } catch (e: any) { this.toast.err(e); }
    finally { this.handle = null; this.running.set(false); this.partial.set(''); }
  }
}
