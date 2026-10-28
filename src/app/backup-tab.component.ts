import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BackupService, ServerBackup } from './backup.service';
import { ConnectionService } from './connection.service';
import { DialogService, ToastService } from './dialog.service';
import { addExcludes, cleanRules, compileRules, removeExcludes } from './exclude';
import { errText, fmtBytes, fmtDate } from './format';
import { IconComponent } from './icon.component';
import { Job } from './job';
import { BackupConfig } from './models';
import { joinPath } from './remote';
import { WorkspaceService } from './workspace.service';

interface TNode { path: string; name: string; isDir: boolean; depth: number; open: boolean; loading: boolean; kids: TNode[] | null; }
type TState = 'on' | 'off' | 'part' | 'locked';
const isPlain = (r: string) => /^\/[^*?]*$/.test(r);

/** Backup de los archivos de la app: eliges qué entra (árbol con casillas + patrones), se comprime en el servidor y se descarga al dispositivo. */
@Component({
  selector: 'app-backup-tab',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="wrap">
      <div class="card">
        <h3>1 · Qué incluir</h3>
        <div class="seg" style="margin-bottom:10px">
          <button [class.on]="cfg().mode === 'all-except'" (click)="setMode('all-except')">Todo, menos lo que desmarque</button>
          <button [class.on]="cfg().mode === 'only'" (click)="setMode('only')">Solo lo que marque</button>
        </div>
        <div class="tree">
          @if (treeLoading()) { <div class="mut pad">Leyendo carpeta…</div> }
          @if (treeError()) { <div class="banner err"><app-icon name="alert" /><div>{{ treeError() }}</div></div> }
          @for (n of rows(); track n.path) {
            @let s = state(n);
            <div class="tr" [style.padding-left.px]="8 + n.depth * 20">
              <button class="tg" (click)="toggleOpen(n)" [style.visibility]="n.isDir ? 'visible' : 'hidden'" aria-label="Abrir o cerrar"><app-icon [name]="n.open ? 'chevron-down' : 'chevron-right'" [size]="16" /></button>
              <button class="ck" [class.on]="s === 'on'" [class.part]="s === 'part'" [disabled]="s === 'locked'" (click)="toggle(n)" [attr.aria-label]="'Incluir ' + n.name">
                @if (s === 'on') { <app-icon name="check" [size]="14" /> } @else if (s === 'part') { <app-icon name="minus" [size]="14" /> }</button>
              <app-icon [name]="n.isDir ? 'folder' : 'file-text'" [size]="17" [style.color]="n.isDir ? 'var(--warn)' : 'var(--mut)'" />
              <span class="grow ell" [class.dim]="s === 'off' || s === 'locked'">{{ n.name }}</span>
              @if (s === 'locked') { <span class="badge warn small">por patrón</span> }
            </div>
          }
          @if (n0() === 0 && !treeLoading() && !treeError()) { <div class="mut pad">La carpeta está vacía.</div> }
        </div>
        @if (cfg().mode === 'all-except' && plainEx().length) {
          <div class="chips">@for (r of plainEx(); track r) { <span class="badge warn">{{ r }}<button class="x" (click)="dropRule(r)" aria-label="Quitar">×</button></span> }</div>
        }
        <div class="field" style="margin-top:12px"><label>Patrones que nunca se incluyen (uno por línea)</label>
          <textarea rows="3" class="mono" [ngModel]="patternText()" (change)="setPatterns($any($event.target).value)" placeholder="node_modules&#10;*.log&#10;**/cache"></textarea>
          <div class="hint"><code>node_modules</code> en cualquier nivel · <code>*.log</code> por extensión · <code>/carpeta/archivo</code> ruta exacta.</div></div>
        <div class="row wrapr">
          <button class="btn sec" (click)="preview()" [disabled]="previewing()"><app-icon name="eye" />{{ previewing() ? 'Calculando…' : 'Vista previa' }}</button>
          @if (pv(); as p) { <span class="mut"><b>{{ p.files }}</b> archivos · ≈ {{ size(p.bytes) }} sin comprimir</span> }
        </div>
      </div>

      <div class="card">
        <h3>2 · Dónde guardar</h3>
        <div class="row wrapr">
          <div class="grow"><div class="lbl">Carpeta en este dispositivo</div><div class="ell mono">{{ cfg().saveDirLabel || 'Sin elegir (se te pedirá al crear el backup)' }}</div></div>
          <button class="btn sec" (click)="chooseDir()"><app-icon name="folder" />Elegir carpeta</button>
        </div>
        <label class="chk" style="margin-top:8px"><input type="checkbox" [ngModel]="cfg().keepOnServer" (ngModelChange)="set('keepOnServer', $event)" /><span>Dejar también una copia en el servidor (<span class="mono">~/.arkpm/backups</span>)</span></label>
        @if (cfg().keepOnServer) { <div class="row" style="margin-left:28px"><span class="mut small">Conservar las últimas</span><input type="number" min="1" max="50" style="width:80px" [ngModel]="cfg().keepCount" (change)="set('keepCount', +$any($event.target).value || 5)" /><span class="mut small">copias</span></div> }
      </div>

      <div class="card">
        <h3>3 · Crear backup</h3>
        <div class="row wrapr">
          <button class="btn" (click)="create()" [disabled]="job.running() || !ws.appDir()"><app-icon name="archive" />Crear backup ahora</button>
          @if (job.running()) { <button class="btn sec" (click)="job.cancel()">Cancelar</button> }
        </div>
        @if (job.running() || job.done()) {
          <div style="margin-top:12px"><div class="row"><b class="grow">{{ job.phase() }}</b>@if (job.pct() !== null) { <span class="mut">{{ job.pct() }}%</span> }</div>
            <div class="bar" [class.ind]="job.running() && job.pct() === null" style="margin:8px 0"><div [style.width.%]="job.pct() ?? 100" [style.background]="job.error() ? 'var(--err)' : ''"></div></div>
            @if (job.done()) { <div class="banner" [class.err]="!!job.error()" [class.info]="!job.error()"><app-icon [name]="job.error() ? 'alert' : 'check'" /><div class="grow">{{ job.error() || 'Backup guardado.' }}</div>
              @if (!job.error() && last()) { <button class="btn sm sec" (click)="show(last()!)">Mostrar</button> }</div> }</div>
        }
      </div>

      <div class="card">
        <div class="row"><h3 class="grow" style="margin:0">Guardados en este dispositivo</h3></div>
        @for (b of local(); track b.id) {
          <div class="row brow"><app-icon name="archive" class="mut" /><div class="grow" style="min-width:0"><div class="ell">{{ b.name }}</div><div class="small mut ell">{{ size(b.size) }} · {{ date(b.createdAt) }}</div></div>
            @if (conn.kind === 'electron') { <button class="btn sm sec" (click)="show(b.location)">Mostrar</button> }
            <button class="btn sm ghost icon" (click)="forget(b.id)" aria-label="Quitar del historial" title="Quitar del historial"><app-icon name="close" /></button></div>
        }
        @if (!local().length) { <div class="mut small">Todavía no creaste backups con esta app.</div> }
      </div>

      <div class="card">
        <div class="row"><h3 class="grow" style="margin:0">Copias en el servidor</h3><button class="btn sm ghost icon" (click)="loadServer()" aria-label="Actualizar"><app-icon name="refresh" [class.spin]="srvLoading()" /></button></div>
        <div class="hint" style="margin-bottom:6px">Incluye las copias previas de cada deploy.</div>
        @for (b of server(); track b.name) {
          <div class="row brow"><app-icon name="hard-drive" class="mut" /><div class="grow" style="min-width:0"><div class="ell">{{ b.name }}</div><div class="small mut">{{ size(b.size) }} · {{ date(b.mtime) }}</div></div>
            <button class="btn sm sec icon" (click)="downloadServer(b)" aria-label="Descargar" title="Descargar"><app-icon name="download" /></button>
            <button class="btn sm sec icon" (click)="restore(b)" aria-label="Restaurar" title="Restaurar"><app-icon name="rollback" /></button>
            <button class="btn sm ghost icon" (click)="removeServer(b)" aria-label="Eliminar" title="Eliminar"><app-icon name="trash" /></button></div>
        }
        @if (!server().length) { <div class="mut small">No hay copias guardadas en el servidor.</div> }
      </div>
    </div>`,
  styles: [`
    .wrap { display:flex; flex-direction:column; gap:12px; max-width:860px; }
    .tree { border:1px solid var(--line); border-radius:10px; max-height:340px; overflow:auto; background:#121313; }
    .tr { display:flex; align-items:center; gap:6px; min-height:var(--hit); padding-right:10px; } .tr:hover { background:rgba(255,255,255,.04); }
    .tg { background:none; border:0; color:var(--mut); width:24px; height:24px; padding:0; cursor:pointer; display:grid; place-items:center; }
    .ck { width:22px; height:22px; flex:none; border-radius:6px; border:2px solid var(--mut); background:transparent; color:#04120e; display:grid; place-items:center; padding:0; cursor:pointer; }
    .ck.on { background:var(--acc); border-color:var(--acc); } .ck.part { border-color:var(--acc); color:var(--acc); } .ck:disabled { opacity:.35; cursor:default; }
    .dim { opacity:.5; text-decoration:line-through; text-decoration-color:var(--mut); }
    .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; } .x { background:none; border:0; color:inherit; font-size:16px; line-height:1; cursor:pointer; padding:0 0 0 2px; }
    .brow { padding:8px 0; border-bottom:1px solid var(--line); } .brow:last-child { border:0; }
  `],
})
export class BackupTabComponent implements OnInit {
  readonly ws = inject(WorkspaceService);
  readonly conn = inject(ConnectionService);
  private readonly backups = inject(BackupService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);

  readonly job = new Job();
  readonly size = fmtBytes; readonly date = fmtDate;
  readonly cfg = computed<BackupConfig>(() => this.ws.app()!.config.backup);
  readonly local = computed(() => this.ws.store.backups().filter((b) => b.appId === this.ws.appId()));
  readonly server = signal<ServerBackup[]>([]);
  readonly srvLoading = signal(false);
  readonly roots = signal<TNode[]>([]);
  readonly tick = signal(0);
  readonly treeLoading = signal(false);
  readonly treeError = signal('');
  readonly previewing = signal(false);
  readonly pv = signal<{ files: number; bytes: number } | null>(null);
  readonly last = signal<string | null>(null);

  readonly plainEx = computed(() => this.cfg().excludes.filter(isPlain));
  readonly patterns = computed(() => this.cfg().excludes.filter((r) => !isPlain(r)));
  readonly patternText = computed(() => this.patterns().join('\n'));
  private readonly patRules = computed(() => compileRules(this.patterns()));
  private readonly exRules = computed(() => compileRules(this.cfg().excludes));
  private readonly inRules = computed(() => compileRules(this.cfg().includes));
  readonly rows = computed(() => { this.tick(); const out: TNode[] = []; const walk = (l: TNode[]) => { for (const n of l) { out.push(n); if (n.open && n.kids) walk(n.kids); } }; walk(this.roots()); return out; });
  readonly n0 = computed(() => this.roots().length);

  ngOnInit() { this.loadTree(); this.loadServer(); }

  // ---------------------------------------------------------------- árbol
  private async children(rel: string, depth: number): Promise<TNode[]> {
    const abs = rel ? joinPath(this.ws.appDir(), rel) : this.ws.appDir();
    const l = await this.conn.list(this.ws.profileId()!, abs);
    return l.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })))
      .map((e) => ({ path: rel ? rel + '/' + e.name : e.name, name: e.name, isDir: e.isDir, depth, open: false, loading: false, kids: null }));
  }
  async loadTree() {
    if (!this.ws.appDir() || this.ws.state() !== 'connected') return;
    this.treeLoading.set(true); this.treeError.set('');
    try { this.roots.set(await this.children('', 0)); } catch (e) { this.treeError.set(errText(e)); }
    finally { this.treeLoading.set(false); }
  }
  async toggleOpen(n: TNode) {
    if (!n.isDir) return;
    if (!n.open && !n.kids) {
      n.loading = true;
      try { n.kids = await this.children(n.path, n.depth + 1); } catch (e) { this.toast.err(e); n.kids = []; }
      n.loading = false;
    }
    n.open = !n.open;
    this.tick.update((v) => v + 1);
  }

  state(n: TNode): TState {
    const c = this.cfg();
    if (this.patRules().test(n.path)) return 'locked';
    const under = (rules: string[]) => rules.some((r) => r.startsWith('/' + n.path + '/'));
    if (c.mode === 'all-except') return this.exRules().test(n.path) ? 'off' : under(this.plainEx()) ? 'part' : 'on';
    return this.inRules().test(n.path) ? 'on' : under(c.includes) ? 'part' : 'off';
  }

  async toggle(n: TNode) {
    const s = this.state(n), c = this.cfg();
    if (c.mode === 'all-except') {
      if (s === 'on' || s === 'part') await this.ws.updateConfig((x) => (x.backup.excludes = addExcludes(x.backup.excludes, [n.path])));
      else {
        const r = removeExcludes(c.excludes, [n.path]);
        if (r.still.length) { this.toast.show(`«${n.name}» sigue excluido por «${r.still[0].rule}». Quita esa regla o vuelve a marcar la carpeta superior.`, 'info'); return; }
        await this.ws.updateConfig((x) => (x.backup.excludes = r.rules));
      }
    } else if (s === 'on') {
      if (!c.includes.includes('/' + n.path)) { this.toast.show('Está incluido porque marcaste una carpeta superior: desmarca esa carpeta.', 'info'); return; }
      await this.ws.updateConfig((x) => (x.backup.includes = x.backup.includes.filter((r) => r !== '/' + n.path)));
    } else await this.ws.updateConfig((x) => (x.backup.includes = cleanRules([...x.backup.includes.filter((r) => !r.startsWith('/' + n.path + '/')), '/' + n.path])));
    this.pv.set(null);
  }

  async dropRule(r: string) { await this.ws.updateConfig((x) => (x.backup.excludes = x.backup.excludes.filter((y) => y !== r))); this.pv.set(null); }
  async setPatterns(raw: string) { await this.ws.updateConfig((x) => (x.backup.excludes = cleanRules([...x.backup.excludes.filter(isPlain), ...raw.split('\n')]))); this.pv.set(null); }
  async setMode(m: 'all-except' | 'only') { await this.ws.updateConfig((x) => (x.backup.mode = m)); this.pv.set(null); }
  async set<K extends keyof BackupConfig>(k: K, v: BackupConfig[K]) { await this.ws.updateConfig((x) => (x.backup[k] = v)); }

  async preview() {
    const a = this.ws.app();
    if (!a) return;
    this.previewing.set(true);
    try { this.pv.set(await this.backups.preview(a, this.ws.appDir())); } catch (e) { this.toast.err(e); this.pv.set(null); }
    finally { this.previewing.set(false); }
  }

  // ---------------------------------------------------------------- crear
  async chooseDir(): Promise<boolean> {
    const p = await this.conn.pickSaveDir();
    if (!p) return false;
    await this.ws.updateConfig((x) => { x.backup.saveDir = p.ref; x.backup.saveDirLabel = p.label; });
    return true;
  }

  async create() {
    const a = this.ws.app();
    if (!a) return;
    if (!this.cfg().saveDir && !(await this.chooseDir())) return;
    const fresh = this.ws.app()!;
    this.last.set(null);
    this.job.start();
    try {
      const rec = await this.backups.createAndDownload(fresh, this.ws.appDir(), fresh.config.backup.saveDir, this.job);
      this.last.set(rec.location);
      this.job.step('Backup completado', 100); this.job.finish();
      this.toast.ok('Backup guardado: ' + rec.name);
      if (fresh.config.backup.keepOnServer) this.loadServer();
    } catch (e) { this.job.say('✖ ' + errText(e)); this.job.finish(errText(e)); }
  }

  show(p: string) { this.conn.showSaved(p).catch((e) => this.toast.err(e)); }
  async forget(id: string) { await this.ws.store.deleteBackup(id); }

  // ---------------------------------------------------------------- copias del servidor
  async loadServer() {
    const a = this.ws.app();
    if (!a || this.ws.state() !== 'connected') return;
    this.srvLoading.set(true);
    try { this.server.set(await this.backups.listServer(a)); } catch { this.server.set([]); }
    finally { this.srvLoading.set(false); }
  }
  async downloadServer(b: ServerBackup) {
    const a = this.ws.app()!;
    if (!this.cfg().saveDir && !(await this.chooseDir())) return;
    this.job.start();
    try { const r = await this.backups.downloadRemote(a, `${this.backups.serverDir(a)}/${b.name}`, b.name, this.ws.app()!.config.backup.saveDir, this.job); this.last.set(r.location); this.job.finish(); this.toast.ok('Descargado: ' + b.name); }
    catch (e) { this.job.finish(errText(e)); }
  }
  async restore(b: ServerBackup) {
    const a = this.ws.app()!, dir = this.ws.appDir();
    if (!(await this.dialogs.confirm({ title: 'Restaurar copia', danger: true, okText: 'Restaurar', message: `La carpeta ${dir} quedará igual al contenido de ${b.name} (salvo los archivos que conservas en el deploy). Los cambios posteriores se perderán.\nLa app no se reinicia sola.` }))) return;
    this.job.start();
    try { await this.backups.restoreServer(a, dir, b.name, this.job); this.job.step('Restauración completada'); this.job.finish(); this.toast.ok('Restaurado. Reinicia la app para que tome los cambios.'); }
    catch (e) { this.job.finish(errText(e)); this.toast.err(e); }
  }
  async removeServer(b: ServerBackup) {
    if (!(await this.dialogs.confirm({ title: 'Eliminar copia del servidor', message: `Se borrará ${b.name} del servidor.`, okText: 'Eliminar', danger: true }))) return;
    await this.backups.deleteServer(this.ws.app()!, b.name);
    this.loadServer();
  }
}
