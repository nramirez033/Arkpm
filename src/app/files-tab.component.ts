import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionService } from './connection.service';
import { DialogService, ToastService } from './dialog.service';
import { addExcludes, compileRules, removeExcludes } from './exclude';
import { errText, fmtBytes, fmtDate, fmtPerm } from './format';
import { IconComponent } from './icon.component';
import { Job } from './job';
import { LayoutService } from './layout.service';
import { RemoteEntry, uid } from './models';
import { arkDir, baseName, isDangerousPath, joinPath, parentPath, sq, stamp } from './remote';
import { toBase64 } from './bytes';
import { WorkspaceService } from './workspace.service';

interface Viewer { path: string; name: string; entry: RemoteEntry; text: string; original: string; truncated: boolean; binary: boolean; tooBig: boolean; loading: boolean; }
type SortKey = 'name' | 'size' | 'mtime';

/** Explorador del servidor por SFTP: navegar, ver/editar texto, subir, descargar, renombrar y borrar. */
@Component({
  selector: 'app-files-tab',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="col full">
      <div class="row">
        <button class="btn sec icon" (click)="up()" [disabled]="path() === '/'" aria-label="Subir un nivel" title="Carpeta superior"><app-icon name="arrow-up" /></button>
        <button class="btn sec icon" (click)="load()" [disabled]="loading()" aria-label="Actualizar" title="Actualizar"><app-icon name="refresh" [class.spin]="loading()" /></button>
        <div class="crumbs grow">
          @for (c of crumbs(); track c.path; let last = $last) {
            <button class="crumb" [class.cur]="last" (click)="go(c.path)">{{ c.name }}</button>@if (!last && c.path !== '/') { <span class="mut">/</span> }
          }
        </div>
        @if (ws.appDir() && path() !== ws.appDir()) { <button class="btn sec sm" (click)="go(ws.appDir())" title="Ir a la carpeta de la app"><app-icon name="package" [size]="15" />App</button> }
      </div>

      @if (selected().size) {
        <div class="row selbar">
          <button class="btn ghost icon sm" (click)="clearSel()" aria-label="Cancelar selección"><app-icon name="close" /></button>
          <b class="grow">{{ selected().size }} seleccionado(s)</b>
          <button class="btn sm icon" (click)="download()" aria-label="Descargar" title="Descargar"><app-icon name="download" [size]="17" /></button>
          <button class="btn sm icon danger" (click)="remove()" aria-label="Eliminar" title="Eliminar"><app-icon name="trash" [size]="17" /></button>
          <button class="btn sm ghost icon" (click)="selMenu()" aria-label="Más"><app-icon name="more" /></button>
        </div>
      } @else {
        <div class="row wrapr">
          <div class="grow search"><app-icon name="search" [size]="15" /><input [ngModel]="filter()" (ngModelChange)="filter.set($event)" placeholder="Filtrar esta carpeta…" /></div>
          <button class="btn sec sm" (click)="newFolder()"><app-icon name="folder-plus" [size]="16" />Carpeta</button>
          <button class="btn sec sm" (click)="upload()"><app-icon name="upload" [size]="16" />Subir aquí</button>
          <button class="btn sec sm" (click)="selectMode.set(!selectMode())" [class.on]="selectMode()"><app-icon name="check-square" [size]="16" />{{ layout.layout() === 'phone' ? '' : 'Seleccionar' }}</button>
          <button class="btn ghost icon sm" (click)="toolMenu()" aria-label="Más"><app-icon name="more" /></button>
        </div>
      }

      @if (job.running() || job.done()) {
        <div class="card jobcard">
          <div class="row"><b class="grow ell">{{ job.phase() }}</b>
            @if (job.running()) { <button class="btn sm sec" (click)="job.cancel()">Cancelar</button> } @else { <button class="btn sm ghost icon" (click)="job.done.set(false)" aria-label="Cerrar"><app-icon name="close" /></button> }</div>
          <div class="bar" [class.ind]="job.running() && job.pct() === null" style="margin-top:8px"><div [style.width.%]="job.pct() ?? 100"></div></div>
          @if (job.error()) { <div class="err small" style="margin-top:6px">{{ job.error() }}</div> }
        </div>
      }
      @if (error()) { <div class="banner err"><app-icon name="alert" /><div>{{ error() }}</div></div> }

      <div class="table">
        @if (layout.layout() !== 'phone') {
          <div class="fr head">
            <span><input type="checkbox" [checked]="allSel()" (change)="toggleAll()" aria-label="Seleccionar todo" /></span>
            <button class="h" (click)="sortBy('name')">Nombre {{ arrow('name') }}</button>
            <button class="h r" (click)="sortBy('size')">Tamaño {{ arrow('size') }}</button>
            <button class="h" (click)="sortBy('mtime')">Modificado {{ arrow('mtime') }}</button><span class="h">Permisos</span>
          </div>
        }
        <div class="rows">
          @for (e of sorted(); track e.name) {
            <div class="fr row-e" [class.sel]="selected().has(e.name)" [class.ex]="excluded(e)" (click)="click(e)">
              @if (layout.layout() !== 'phone' || selectMode() || selected().size) { <span (click)="$event.stopPropagation()"><input type="checkbox" [checked]="selected().has(e.name)" (change)="toggleSel(e.name)" [attr.aria-label]="'Seleccionar ' + e.name" /></span> }
              <span class="nm"><app-icon [name]="e.isDir ? 'folder' : 'file-text'" [size]="20" [style.color]="e.isDir ? 'var(--warn)' : 'var(--mut)'" />
                <span class="grow" style="min-width:0"><span class="ell blk">{{ e.name }}@if (e.isLink) { <span class="mut"> → enlace</span> }</span>
                  @if (layout.layout() === 'phone') { <span class="s ell blk">{{ e.isDir ? 'Carpeta' : size(e.size) }} · {{ date(e.mtime) }}</span> }</span>
                @if (excluded(e)) { <span class="badge warn" title="Excluido del backup">sin backup</span> }</span>
              @if (layout.layout() !== 'phone') { <span class="r mut">{{ e.isDir ? '' : size(e.size) }}</span><span class="mut">{{ date(e.mtime) }}</span><span class="mut mono">{{ perm(e.mode) }}</span> }
            </div>
          }
          @if (!sorted().length && !loading()) { <div class="empty">{{ filter() ? 'Nada coincide con el filtro.' : 'Carpeta vacía.' }}</div> }
        </div>
      </div>
    </div>

    @if (viewer(); as v) {
      <div class="backdrop"><div class="modal wide" role="dialog">
        <header><app-icon name="file-text" /><h3 class="ell">{{ v.name }}</h3><button class="btn ghost icon sm" (click)="closeViewer()" aria-label="Cerrar"><app-icon name="close" /></button></header>
        <div class="body">
          <div class="small mut" style="margin-bottom:10px">{{ size(v.entry.size) }} · {{ date(v.entry.mtime) }} · <span class="mono">{{ perm(v.entry.mode) }}</span><br><span class="mono">{{ v.path }}</span></div>
          @if (v.loading) { <div class="mut">Leyendo…</div> }
          @else if (v.binary) { <div class="banner info"><app-icon name="info" /><div>Es un archivo binario: se puede descargar pero no mostrar.</div></div> }
          @else if (v.tooBig) { <div class="banner info"><app-icon name="info" /><div>El archivo es muy grande para abrirlo aquí. Descárgalo para verlo.</div></div> }
          @else {
            @if (v.truncated) { <div class="banner" style="margin-bottom:8px"><app-icon name="alert" /><div>Se muestra solo el principio del archivo: está en modo solo lectura.</div></div> }
            <textarea class="mono code" rows="18" spellcheck="false" wrap="off" [readOnly]="v.truncated" [ngModel]="v.text" (ngModelChange)="setText($event)"></textarea>
          }
        </div>
        <footer>
          <button class="btn sec icon" (click)="download([v.entry.name]); closeViewer()" aria-label="Descargar" title="Descargar"><app-icon name="download" [size]="18" /></button>
          <button class="btn sec" (click)="rename(v.entry)"><app-icon name="edit" [size]="16" />Renombrar</button>
          <button class="btn sec icon" (click)="remove([v.entry.name]); closeViewer()" aria-label="Eliminar" title="Eliminar"><app-icon name="trash" [size]="18" /></button>
          <span class="grow"></span>
          @if (!v.binary && !v.tooBig && !v.truncated) { <button class="btn" [disabled]="v.text === v.original" (click)="saveViewer()"><app-icon name="save" [size]="16" />Guardar</button> }
        </footer>
      </div></div>
    }`,
  styles: [`
    :host { display:flex; flex-direction:column; flex:1; min-height:0; } .full { flex:1; min-height:0; }
    .crumbs { display:flex; align-items:center; gap:2px; overflow-x:auto; white-space:nowrap; background:var(--field); border-radius:8px; padding:0 6px; min-height:var(--hit); scrollbar-width:none; }
    .crumb { background:none; border:0; color:var(--mut); cursor:pointer; padding:4px 6px; border-radius:6px; font:inherit; } .crumb:hover { background:rgba(255,255,255,.08); color:var(--txt); } .crumb.cur { color:var(--txt); font-weight:600; }
    .search { display:flex; align-items:center; gap:6px; background:var(--field); border-radius:8px; padding-left:10px; min-width:130px; } .search input { border:0; background:transparent; }
    .btn.on { background:var(--acc); color:#04120e; }
    .selbar { background:var(--panel); border-radius:10px; padding:4px 6px; min-height:var(--hit); }
    .table { flex:1; min-height:0; display:flex; flex-direction:column; border:1px solid var(--line); border-radius:12px; background:var(--card); overflow:hidden; } .rows { overflow:auto; flex:1; }
    .fr { display:grid; grid-template-columns:34px minmax(0,1fr) 90px 150px 90px; align-items:center; gap:8px; padding:0 12px; }
    .fr.head { min-height:34px; border-bottom:1px solid var(--line); color:var(--mut); font-size:12px; } .h { background:none; border:0; color:inherit; font:inherit; text-align:left; cursor:pointer; padding:0; } .r { text-align:right; }
    .row-e { min-height:46px; border-bottom:1px solid rgba(255,255,255,.04); cursor:pointer; } .row-e:hover { background:rgba(255,255,255,.04); } .row-e.sel { background:rgba(0,168,132,.14); } .row-e.ex .ell { opacity:.6; text-decoration:line-through; text-decoration-color:var(--warn); }
    .nm { display:flex; align-items:center; gap:10px; min-width:0; } .blk { display:block; } .s { font-size:12px; color:var(--mut); }
    .code { white-space:pre; overflow:auto; min-height:260px; }
    .jobcard { padding:10px 12px; }
    @media (max-width:719px) { .fr { grid-template-columns:minmax(0,1fr); padding:6px 10px; min-height:56px; } .fr:has(input[type=checkbox]) { grid-template-columns:30px minmax(0,1fr); } }
    @media (min-width:720px) { .fr:not(.head) { grid-template-columns:34px minmax(0,1fr) 90px 150px 90px; } }
  `],
})
export class FilesTabComponent {
  readonly active = input(true);
  readonly ws = inject(WorkspaceService);
  readonly layout = inject(LayoutService);
  private readonly conn = inject(ConnectionService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);

  readonly path = signal('');
  readonly entries = signal<RemoteEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly selected = signal<Set<string>>(new Set());
  readonly selectMode = signal(false);
  readonly filter = signal('');
  readonly sort = signal<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true });
  readonly viewer = signal<Viewer | null>(null);
  readonly job = new Job();
  readonly size = fmtBytes; readonly date = fmtDate; readonly perm = fmtPerm;

  private readonly rules = computed(() => compileRules(this.ws.app()?.config.backup.excludes ?? []));
  readonly crumbs = computed(() => {
    const segs = this.path().split('/').filter(Boolean);
    return [{ name: '/', path: '/' }, ...segs.map((s, i) => ({ name: s, path: '/' + segs.slice(0, i + 1).join('/') }))];
  });
  readonly sorted = computed(() => {
    const f = this.filter().trim().toLowerCase(), { key, asc } = this.sort();
    const l = this.entries().filter((e) => !f || e.name.toLowerCase().includes(f));
    const dir = asc ? 1 : -1;
    return l.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : (key === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : key === 'size' ? a.size - b.size : a.mtime - b.mtime) * dir));
  });
  readonly allSel = computed(() => this.sorted().length > 0 && this.sorted().every((e) => this.selected().has(e.name)));

  constructor() {
    effect(() => {
      const on = this.active(), dir = this.ws.appDir(), connected = this.ws.state() === 'connected';
      untracked(() => { if (on && dir && connected && !this.path()) this.go(dir); });
    });
  }

  // ---------------------------------------------------------------- navegación
  async go(p: string) {
    this.path.set(p); this.clearSel(); this.filter.set('');
    await this.load();
  }
  up() { this.go(parentPath(this.path())); }
  async load() {
    const pid = this.ws.profileId(), p = this.path();
    if (!pid || !p) return;
    this.loading.set(true); this.error.set('');
    try { const l = await this.conn.list(pid, p); if (this.path() === p) this.entries.set(l); }
    catch (e) { this.entries.set([]); this.error.set(errText(e)); }
    finally { this.loading.set(false); }
  }
  sortBy(k: SortKey) { this.sort.update((s) => ({ key: k, asc: s.key === k ? !s.asc : true })); }
  arrow(k: SortKey) { const s = this.sort(); return s.key === k ? (s.asc ? '▲' : '▼') : ''; }

  // ---------------------------------------------------------------- selección
  clearSel() { this.selected.set(new Set()); this.selectMode.set(false); }
  toggleSel(n: string) { this.selected.update((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; }); }
  toggleAll() { this.selected.set(this.allSel() ? new Set() : new Set(this.sorted().map((e) => e.name))); }
  click(e: RemoteEntry) {
    if (this.selectMode() || this.selected().size) { this.toggleSel(e.name); return; }
    if (e.isDir) this.go(joinPath(this.path(), e.name)); else this.openFile(e);
  }
  private picked(names?: string[]): RemoteEntry[] { const s = new Set(names ?? this.selected()); return this.entries().filter((e) => s.has(e.name)); }
  private full(e: RemoteEntry) { return joinPath(this.path(), e.name); }

  // ---------------------------------------------------------------- backup (marcas)
  private rel(e: RemoteEntry): string | null {
    const root = this.ws.appDir().replace(/\/+$/, ''), p = this.full(e);
    return root && p.startsWith(root + '/') ? p.slice(root.length + 1) : null;
  }
  excluded(e: RemoteEntry) { const r = this.rel(e); return r !== null && this.rules().test(r); }

  // ---------------------------------------------------------------- acciones
  async newFolder() {
    const n = (await this.dialogs.input({ title: 'Nueva carpeta', label: 'Nombre', okText: 'Crear' }))?.trim();
    if (!n) return;
    if (/[\/\0]/.test(n)) { this.toast.show('El nombre no puede contener «/»', 'err'); return; }
    await this.sh(`mkdir -- ${sq(joinPath(this.path(), n))}`, 'Carpeta creada');
  }

  async rename(e: RemoteEntry) {
    const n = (await this.dialogs.input({ title: 'Renombrar', label: 'Nuevo nombre', value: e.name, okText: 'Renombrar' }))?.trim();
    if (!n || n === e.name) return;
    if (/[\/\0]/.test(n)) { this.toast.show('El nombre no puede contener «/»', 'err'); return; }
    this.closeViewer();
    await this.sh(`[ ! -e ${sq(joinPath(this.path(), n))} ] || { echo "Ya existe «${n.replace(/["$`\\]/g, '')}»"; exit 1; }; mv -- ${sq(this.full(e))} ${sq(joinPath(this.path(), n))}`, 'Renombrado');
  }

  async remove(names?: string[]) {
    const list = this.picked(names);
    if (!list.length) return;
    const home = this.conn.home(this.ws.profileId()!);
    const bad = list.find((e) => isDangerousPath(this.full(e), home));
    if (bad) { this.toast.show(`Por seguridad no se puede borrar ${this.full(bad)} desde la app`, 'err'); return; }
    const hasDir = list.some((e) => e.isDir);
    if (!(await this.dialogs.confirm({
      title: 'Eliminar del servidor', danger: true, okText: 'Eliminar',
      message: `Se eliminarán ${list.length} elemento(s) de ${this.path()}${hasDir ? ' (las carpetas con todo su contenido)' : ''}. No se puede deshacer.`,
      details: list.slice(0, 30).map((e) => e.name + (e.isDir ? '/' : '')),
    }))) return;
    this.clearSel();
    await this.sh(`rm -rf -- ${list.map((e) => sq(this.full(e))).join(' ')}`, 'Eliminado');
  }

  private async sh(script: string, okMsg: string) {
    try {
      const r = await this.conn.run(this.ws.profileId()!, script);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'El servidor rechazó la operación');
      this.toast.ok(okMsg);
    } catch (e) { this.toast.err(e); }
    await this.load();
  }

  async upload() {
    const pid = this.ws.profileId();
    if (!pid) return;
    try {
      const files = await this.conn.pickFiles({ multi: true });
      if (!files.length) return;
      const jobId = uid();
      this.job.start(); this.job.step(`Subiendo ${files.length} archivo(s)…`, 0);
      const off = this.conn.onProgress((e) => { if (e.jobId === jobId && e.total) this.job.progress(Math.round((e.loaded / e.total) * 100)); });
      const stop = this.job.onCancel(() => this.conn.cancelJob(jobId));
      try { await this.conn.uploadMany(pid, jobId, files.map((f) => ({ local: f.ref, remote: joinPath(this.path(), f.name), size: f.size }))); }
      finally { off(); stop(); }
      this.job.step('Subida completada', 100); this.job.finish();
      this.toast.ok(`${files.length} archivo(s) subido(s)`);
    } catch (e) { this.job.finish(errText(e)); if (errText(e) !== 'Cancelado') this.toast.err(e); }
    await this.load();
  }

  /** Carpeta del dispositivo donde se guardan las descargas (se pregunta la primera vez). */
  private async downloadDir(change = false): Promise<{ ref: string; label: string } | null> {
    let d = this.ws.store.getSetting<{ ref: string; label: string } | null>('downloadDir', null);
    if (!d || change) {
      const p = await this.conn.pickSaveDir();
      if (!p) return d && !change ? d : null;
      d = p; await this.ws.store.setSetting('downloadDir', d);
    }
    return d;
  }

  async download(names?: string[]) {
    const list = this.picked(names);
    const pid = this.ws.profileId();
    if (!list.length || !pid) return;
    const dir = await this.downloadDir();
    if (!dir) return;
    const jobId = uid();
    const single = list.length === 1 && !list[0].isDir;
    let tmp = '';
    this.job.start();
    const off = this.conn.onProgress((e) => { if (e.jobId === jobId && e.total) this.job.progress(Math.round((e.loaded / e.total) * 100)); });
    const stop = this.job.onCancel(() => this.conn.cancelJob(jobId));
    try {
      let remote: string, name: string;
      if (single) { remote = this.full(list[0]); name = list[0].name; }
      else {
        name = (list.length === 1 ? list[0].name : 'seleccion-' + stamp()) + '.tar.gz';
        tmp = `${arkDir(this.conn.home(pid))}/tmp/${stamp()}-${uid().slice(0, 6)}.tar.gz`;
        this.job.step('Comprimiendo en el servidor…');
        const r = await this.conn.run(pid, `set -e; mkdir -p ${sq(parentPath(tmp))}; cd ${sq(this.path())}; tar --warning=no-file-changed -czf ${sq(tmp)} -- ${list.map((e) => sq(e.name)).join(' ')} || [ $? -eq 1 ]`, { timeoutMs: 600000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'No se pudo comprimir');
        remote = tmp;
      }
      this.job.step(`Descargando ${name}…`, 0);
      const d = await this.conn.download(pid, jobId, remote, dir.ref, name);
      this.job.step('Descarga completada', 100); this.job.finish();
      this.toast.ok('Guardado en ' + d.path);
      this.clearSel();
    } catch (e) { this.job.finish(errText(e)); if (errText(e) !== 'Cancelado') this.toast.err(e); }
    finally { off(); stop(); if (tmp) this.conn.run(pid, `rm -f -- ${sq(tmp)}`).catch(() => { /* limpieza */ }); }
  }

  async selMenu() {
    const list = this.picked();
    const rels = list.map((e) => this.rel(e)).filter((r): r is string => r !== null);
    const allEx = rels.length > 0 && rels.every((r) => this.rules().test(r));
    const r = await this.dialogs.menu(`${list.length} seleccionado(s)`, [
      { id: 'ren', label: 'Renombrar', icon: 'edit', disabled: list.length !== 1 },
      { id: 'copy', label: 'Copiar ruta', icon: 'copy' },
      { id: 'bk', label: allEx ? 'Incluir de nuevo en el backup' : 'Excluir del backup', icon: 'archive', disabled: !rels.length },
      { id: 'all', label: 'Seleccionar todo', icon: 'check-square' },
    ]);
    if (r === 'ren') this.rename(list[0]);
    else if (r === 'copy') this.copy(list.map((e) => this.full(e)).join('\n'));
    else if (r === 'all') this.selected.set(new Set(this.sorted().map((e) => e.name)));
    else if (r === 'bk') {
      if (allEx) {
        const res = removeExcludes(this.ws.app()!.config.backup.excludes, rels);
        await this.ws.updateConfig((c) => (c.backup.excludes = res.rules));
        if (res.still.length) this.toast.show(`Sigue excluido por la regla «${res.still[0].rule}»`, 'info');
      } else await this.ws.updateConfig((c) => (c.backup.excludes = addExcludes(c.backup.excludes, rels)));
      this.toast.ok(allEx ? 'Se incluirá en el backup' : 'Se excluirá del backup'); this.clearSel();
    }
  }

  async toolMenu() {
    const r = await this.dialogs.menu('Explorador', [
      { id: 'copy', label: 'Copiar la ruta de esta carpeta', icon: 'copy' },
      { id: 'dl', label: 'Cambiar la carpeta de descargas del dispositivo', icon: 'folder' },
    ]);
    if (r === 'copy') this.copy(this.path());
    else if (r === 'dl') { const d = await this.downloadDir(true); if (d) this.toast.ok('Las descargas irán a ' + d.label); }
  }

  private async copy(t: string) { try { await navigator.clipboard.writeText(t); this.toast.ok('Copiado'); } catch { this.toast.show('No se pudo copiar', 'err'); } }

  // ---------------------------------------------------------------- visor / editor de texto
  async openFile(e: RemoteEntry) {
    const v: Viewer = { path: this.full(e), name: e.name, entry: e, text: '', original: '', truncated: false, binary: false, tooBig: e.size > 4 * 1024 * 1024, loading: !(e.size > 4 * 1024 * 1024) };
    this.viewer.set(v);
    if (v.tooBig) return;
    try {
      const r = await this.conn.readFile(this.ws.profileId()!, v.path, 512 * 1024);
      const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
      const binary = bytes.subarray(0, 8000).includes(0);
      const text = binary ? '' : new TextDecoder().decode(bytes);
      if (this.viewer()?.path === v.path) this.viewer.set({ ...v, loading: false, binary, text, original: text, truncated: r.truncated });
    } catch (err) { this.viewer.set(null); this.toast.err(err); }
  }
  closeViewer() { this.viewer.set(null); }
  setText(t: string) { this.viewer.update((v) => (v ? { ...v, text: t } : v)); }
  async saveViewer() {
    const v = this.viewer();
    if (!v) return;
    if (!(await this.dialogs.confirm({ title: 'Guardar en el servidor', message: `Se sobrescribirá ${v.path}. Si es un archivo de configuración, puede que la app necesite reiniciarse para notarlo.`, okText: 'Guardar' }))) return;
    try {
      await this.conn.writeFile(this.ws.profileId()!, v.path, toBase64(new TextEncoder().encode(v.text)));
      this.viewer.set({ ...v, original: v.text });
      this.toast.ok('Archivo guardado');
      this.load();
    } catch (e) { this.toast.err(e); }
  }
}
