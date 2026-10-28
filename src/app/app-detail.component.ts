import { Component, effect, inject, signal } from '@angular/core';
import { BackupTabComponent } from './backup-tab.component';
import { DeployTabComponent } from './deploy-tab.component';
import { FilesTabComponent } from './files-tab.component';
import { IconComponent } from './icon.component';
import { LayoutService } from './layout.service';
import { LogsTabComponent } from './logs-tab.component';
import { StatusTabComponent } from './status-tab.component';
import { Tab, WorkspaceService } from './workspace.service';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'estado', label: 'Estado', icon: 'activity' },
  { id: 'logs', label: 'Logs', icon: 'terminal' },
  { id: 'archivos', label: 'Archivos', icon: 'folder' },
  { id: 'deploy', label: 'Deploy', icon: 'deploy' },
  { id: 'backup', label: 'Backup', icon: 'archive' },
];

/** Detalle de una app: cabecera, pestañas (arriba en tableta/escritorio, abajo en el teléfono) y su contenido. */
@Component({
  selector: 'app-detail',
  standalone: true,
  imports: [IconComponent, StatusTabComponent, LogsTabComponent, FilesTabComponent, DeployTabComponent, BackupTabComponent],
  template: `
    @if (ws.app(); as a) {
      <header class="dh">
        @if (layout.layout() === 'phone') { <button class="btn ghost icon" (click)="ws.back()" aria-label="Volver"><app-icon name="arrow-left" /></button> }
        <div class="grow" style="min-width:0"><h2 class="ell">{{ a.label }}</h2><div class="small mut ell">{{ ws.profile()?.name }} · {{ ws.appDir() || a.pm2Name }}</div></div>
        @if (ws.group(); as g) { <span class="badge" [class]="'badge ' + cls(g.status)"><span class="dot" [class]="cls(g.status)"></span>{{ txt(g.status) }}</span> }
        @else if (ws.lastUpdate()) { <span class="badge warn">No está en PM2</span> }
      </header>
      @if (layout.layout() !== 'phone') {
        <nav class="tabs">@for (t of tabs; track t.id) { <button [class.on]="ws.tab() === t.id" (click)="ws.tab.set(t.id)"><app-icon [name]="t.icon" [size]="17" />{{ t.label }}</button> }</nav>
      }
      @if (ws.state() !== 'connected') {
        <div class="pad"><div class="banner err"><app-icon name="alert" /><div class="grow">Sin conexión con el servidor{{ ws.conn.error(ws.profileId()!) ? ': ' + ws.conn.error(ws.profileId()!) : '.' }}</div><button class="btn sm" (click)="ws.connect()">Reconectar</button></div></div>
      }
      <div class="panes">
        <section class="pane" [class.hide]="ws.tab() !== 'estado'"><app-status-tab /></section>
        @if (seen().has('logs')) { <section class="pane fixed" [class.hide]="ws.tab() !== 'logs'"><app-logs-tab [active]="ws.tab() === 'logs'" /></section> }
        @if (seen().has('archivos')) { <section class="pane fixed" [class.hide]="ws.tab() !== 'archivos'"><app-files-tab [active]="ws.tab() === 'archivos'" /></section> }
        @if (seen().has('deploy')) { <section class="pane" [class.hide]="ws.tab() !== 'deploy'"><app-deploy-tab /></section> }
        @if (seen().has('backup')) { <section class="pane" [class.hide]="ws.tab() !== 'backup'"><app-backup-tab /></section> }
      </div>
      @if (layout.layout() === 'phone') {
        <nav class="bottom">@for (t of tabs; track t.id) { <button [class.on]="ws.tab() === t.id" (click)="ws.tab.set(t.id)"><app-icon [name]="t.icon" [size]="22" /><span>{{ t.label }}</span></button> }</nav>
      }
    }`,
  styles: [`
    :host { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; }
    .dh { display:flex; align-items:center; gap:10px; padding:12px 16px 8px; } .dh h2 { font-size:18px; }
    .tabs { display:flex; gap:4px; padding:0 12px; border-bottom:1px solid var(--line); overflow-x:auto; flex:none; }
    .tabs button { display:flex; align-items:center; gap:7px; background:none; border:0; border-bottom:2px solid transparent; color:var(--mut); padding:0 14px; min-height:var(--hit); cursor:pointer; font:inherit; font-weight:500; white-space:nowrap; }
    .tabs button:hover { color:var(--txt); } .tabs button.on { color:var(--txt); border-bottom-color:var(--acc); }
    .panes { flex:1; min-height:0; display:flex; flex-direction:column; }
    .pane { flex:1; min-height:0; overflow:auto; padding:14px 16px; display:flex; flex-direction:column; } .pane.fixed { overflow:hidden; } .pane > * { flex:none; } .pane.fixed > * { flex:1; min-height:0; }
    .bottom { display:flex; flex:none; background:var(--card); border-top:1px solid var(--line); padding-bottom:var(--sab); }
    .bottom button { flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; gap:2px; background:none; border:0; color:var(--mut); padding:8px 2px 6px; min-height:58px; cursor:pointer; font:inherit; }
    .bottom button span { font-size:11px; } .bottom button.on { color:var(--acc2); box-shadow:inset 0 2px 0 var(--acc); }
    @media (max-width:719px) { .dh { padding:calc(8px + var(--sat)) 10px 6px; } .pane { padding:10px; } }
  `],
})
export class AppDetailComponent {
  readonly ws = inject(WorkspaceService);
  readonly layout = inject(LayoutService);
  readonly tabs = TABS;
  readonly seen = signal(new Set<Tab>(['estado']));

  constructor() {
    effect(() => { const t = this.ws.tab(); if (!this.seen().has(t)) this.seen.update((s) => new Set(s).add(t)); }, { allowSignalWrites: true });
  }
  cls(s: string) { return s === 'online' ? 'ok' : s === 'partial' || s === 'launching' ? 'warn' : s === 'errored' ? 'err' : ''; }
  txt(s: string) { return ({ online: 'En línea', partial: 'Parcial', stopped: 'Detenida', errored: 'Con error', launching: 'Iniciando' } as Record<string, string>)[s] ?? s; }
}
