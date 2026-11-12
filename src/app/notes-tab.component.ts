import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogService, ToastService } from './dialog.service';
import { SharedStatusComponent } from './shared-status.component';
import { fmtDate } from './format';
import { IconComponent } from './icon.component';
import { LayoutService } from './layout.service';
import { AppNote, uid } from './models';
import { StoreService } from './store.service';
import { WorkspaceService } from './workspace.service';

/**
 * Notas de la app. Se guardan por servidor + servicio de PM2 (no por usuario SSH ni por perfil): cualquier usuario o perfil
 * que abra esta app en este servidor ve y edita las mismas notas; cada una recuerda quién la editó por última vez.
 */
@Component({
  selector: 'app-notes-tab',
  standalone: true,
  imports: [FormsModule, IconComponent, SharedStatusComponent],
  template: `
    <app-shared-status what="Las notas" style="margin-bottom:8px" />
    <div class="wrap" [class.phone]="layout.layout() === 'phone'">
      @if (layout.layout() !== 'phone' || !editing()) {
        <aside class="list-pane">
          <div class="row">
            <div class="grow search"><app-icon name="search" [size]="15" /><input [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Buscar en las notas…" /></div>
            <button class="btn sec icon" (click)="ws.syncShared()" aria-label="Actualizar desde el servidor" title="Actualizar desde el servidor"><app-icon name="refresh" [size]="17" /></button>
            <button class="btn icon" (click)="create()" aria-label="Nueva nota" title="Nueva nota"><app-icon name="plus" [size]="18" /></button>
          </div>
          <div class="list nl">
            @for (n of filtered(); track n.id) {
              <div class="item" [class.sel]="selId() === n.id" (click)="open(n.id)">
                <div class="grow" style="min-width:0"><div class="t ell">{{ title(n) }}</div><div class="s ell">{{ preview(n) }}</div><div class="s ell">{{ n.author }} · {{ date(n.updatedAt) }}</div></div>
              </div>
            }
            @if (!notes().length && selId() !== 'new') { <div class="empty"><app-icon name="edit" [size]="34" /><div style="margin:6px 0 12px">Todavía no hay notas de esta app.<br>Las ven todos los usuarios que la abran en este servidor.</div><button class="btn" (click)="create()"><app-icon name="plus" />Nueva nota</button></div> }
            @else if (!filtered().length && q()) { <div class="mut small" style="padding:10px">Ninguna nota coincide.</div> }
          </div>
        </aside>
      }
      @if (layout.layout() !== 'phone' || editing()) {
        <section class="editor">
          @if (selId()) {
            <div class="row">
              @if (layout.layout() === 'phone') { <button class="btn ghost icon" (click)="back()" aria-label="Volver"><app-icon name="arrow-left" /></button> }
              <div class="grow small mut ell">@if (cur(); as c) { Creada {{ date(c.createdAt) }} · editada por <b>{{ c.author }}</b> · {{ date(c.updatedAt) }} } @else { Nota nueva }</div>
              <span class="small" [class.ok]="state() === 'saved'" [class.mut]="state() !== 'saved'">{{ state() === 'saving' ? 'Guardando…' : state() === 'saved' ? 'Guardado' : '' }}</span>
              <button class="btn ghost icon sm" (click)="copy()" aria-label="Copiar" title="Copiar"><app-icon name="copy" /></button>
              @if (cur()) { <button class="btn ghost icon sm" (click)="remove()" aria-label="Eliminar nota" title="Eliminar nota"><app-icon name="trash" /></button> }
            </div>
            @if (remoteNewer()) { <div class="banner"><app-icon name="alert" /><div class="grow">{{ cur()?.author }} editó esta nota en el servidor mientras la escribías.</div><button class="btn sm sec" (click)="takeRemote()">Cargar su versión</button></div> }
            <textarea class="note" [ngModel]="text" (ngModelChange)="onType($event)" placeholder="Escribe aquí: pasos de deploy, variables, contactos, pendientes…" spellcheck="true"></textarea>
          } @else { <div class="empty"><app-icon name="edit" [size]="40" /><div>Elige una nota o crea una nueva.</div></div> }
        </section>
      }
    </div>`,
  styles: [`
    :host { display:flex; flex-direction:column; flex:1; min-height:0; }
    .wrap { display:flex; gap:14px; flex:1; min-height:0; } .list-pane { width:290px; flex:none; display:flex; flex-direction:column; gap:10px; min-height:0; }
    .wrap.phone .list-pane { width:100%; } .nl { overflow:auto; flex:1; } .editor { flex:1; min-width:0; display:flex; flex-direction:column; gap:8px; min-height:0; }
    .note { flex:1; resize:none; min-height:200px; line-height:1.55; font-size:14px; }
    .search { display:flex; align-items:center; gap:6px; background:var(--field); border-radius:8px; padding-left:10px; } .search input { border:0; background:transparent; }
    .item { min-height:64px; align-items:flex-start; } .nl .item { border-bottom:1px solid var(--line); border-radius:0; }
  `],
})
export class NotesTabComponent implements OnDestroy {
  readonly ws = inject(WorkspaceService);
  readonly layout = inject(LayoutService);
  private readonly store = inject(StoreService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);
  readonly date = fmtDate;
  /** updatedAt de la versión que se abrió: se compara con el servidor al guardar para no pisar ediciones ajenas. */
  private base = signal(0);
  private loadedText = '';
  readonly remoteNewer = signal(false);

  readonly q = signal('');
  readonly selId = signal<string | null>(null);   // id de la nota, 'new' (aún sin guardar) o null
  readonly editing = signal(false);               // solo móvil: lista ↔ editor
  readonly state = signal<'' | 'saving' | 'saved'>('');
  text = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly key = computed(() => { const a = this.ws.app(); return a ? this.store.appKey(a.profileId, a.pm2Name) : ''; });
  readonly notes = computed(() => this.store.notes().filter((n) => n.key === this.key()).sort((a, b) => b.updatedAt - a.updatedAt));
  readonly filtered = computed(() => { const f = this.q().trim().toLowerCase(); return f ? this.notes().filter((n) => n.text.toLowerCase().includes(f)) : this.notes(); });
  readonly cur = computed(() => this.notes().find((n) => n.id === this.selId()) ?? null);

  constructor() {
    // en tableta/escritorio se abre la nota más reciente al entrar
    // si otro usuario edita la nota abierta: sin cambios míos se actualiza sola; con cambios míos se avisa
    effect(() => {
      const c = this.cur(), b = this.base();
      untracked(() => { if (c && b && c.updatedAt !== b && c.text !== this.text) { if (this.text === this.loadedText) this.load(c); else this.remoteNewer.set(true); } });
    }, { allowSignalWrites: true });
    effect(() => {
      const first = this.notes()[0];
      untracked(() => { if (!this.selId() && first && this.layout.layout() !== 'phone') this.load(first); });
    });
  }

  ngOnDestroy() { this.flush(); }

  title(n: AppNote) { return (n.text.split('\n').find((l) => l.trim()) ?? 'Nota vacía').trim().slice(0, 70); }
  preview(n: AppNote) { const ls = n.text.split('\n').filter((l) => l.trim()); return (ls[1] ?? '').trim().slice(0, 90); }

  private load(n: AppNote) { this.selId.set(n.id); this.text = n.text; this.loadedText = n.text; this.base.set(n.updatedAt); this.remoteNewer.set(false); this.state.set(''); }
  takeRemote() { const c = this.cur(); if (c) this.load(c); }
  async open(id: string) { await this.saveNow(); const n = this.notes().find((x) => x.id === id); if (n) { this.load(n); this.editing.set(true); } }
  async create() { await this.saveNow(); this.selId.set('new'); this.text = ''; this.loadedText = ''; this.base.set(0); this.remoteNewer.set(false); this.state.set(''); this.editing.set(true); }
  async back() { await this.saveNow(); this.editing.set(false); this.selId.set(null); }

  onType(v: string) {
    this.text = v; this.state.set('saving');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 700);
  }
  private flush() { if (this.timer) this.saveNow(); }

  async saveNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const app = this.ws.app(), id = this.selId();
    if (!app || !id) return;
    const author = this.ws.profile()?.username ?? '';
    if (id === 'new') {
      if (!this.text.trim()) { this.state.set(''); return; }
      const n: AppNote = { id: uid(), key: this.key(), text: this.text, createdAt: Date.now(), updatedAt: Date.now(), author };
      await this.ws.persistNote(n, null);
      this.selId.set(n.id); this.base.set(n.updatedAt); this.loadedText = n.text;
    } else {
      const n = this.cur();
      if (!n || n.text === this.text) { this.state.set(this.state() ? 'saved' : ''); return; }
      const upd: AppNote = { ...n, text: this.text, updatedAt: Date.now(), author };
      const res = await this.ws.persistNote(upd, this.base());
      if (res === 'conflict') { await this.resolveConflict(upd); return; }
      this.base.set(upd.updatedAt); this.loadedText = upd.text;
    }
    this.state.set('saved');
  }

  /** Otro usuario guardó esta nota después de que la abriste: se elige qué versión queda. */
  private async resolveConflict(mine: AppNote) {
    await this.ws.syncShared();
    const theirs = this.notes().find((n) => n.id === mine.id);
    this.state.set('');
    if (!theirs) { await this.ws.persistNote({ ...mine, updatedAt: Date.now() }, null); this.base.set(mine.updatedAt); return; }
    const r = await this.dialogs.menu(`«${this.title(theirs)}» cambió en el servidor`, [
      { id: 'over', label: `Guardar mis cambios y reemplazar la versión de ${theirs.author}`, icon: 'save' },
      { id: 'theirs', label: 'Descartar los míos y cargar la versión del servidor', icon: 'refresh' },
      { id: 'copy', label: 'Guardar mi texto como una nota nueva', icon: 'copy' },
    ]);
    if (r === 'over') { const o = { ...mine, updatedAt: Date.now() }; const res = await this.ws.persistNote(o, theirs.updatedAt); if (res === 'ok') { this.base.set(o.updatedAt); this.loadedText = o.text; this.state.set('saved'); } else this.toast.show('Volvió a cambiar en el servidor: inténtalo otra vez.', 'err'); }
    else if (r === 'copy') {
      const n: AppNote = { id: uid(), key: this.key(), text: mine.text, createdAt: Date.now(), updatedAt: Date.now(), author: mine.author };
      await this.ws.persistNote(n, null); this.load(n);
    } else this.load(theirs);
  }

  async copy() { try { await navigator.clipboard.writeText(this.text); } catch { /* sin portapapeles */ } }

  async remove() {
    const n = this.cur();
    if (!n || !(await this.dialogs.confirm({ title: 'Eliminar nota', message: `Se eliminará «${this.title(n)}» para todos los usuarios de esta app. No se puede deshacer.`, okText: 'Eliminar', danger: true }))) return;
    if (!(await this.ws.removeNote(n))) return;
    this.selId.set(null); this.text = ''; this.state.set(''); this.editing.set(false);
  }
}
