import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogService, ToastService } from './dialog.service';
import { fmtBytes } from './format';
import { IconComponent } from './icon.component';
import { LayoutService } from './layout.service';
import { Pm2Group, TrackedApp } from './models';
import { NewServiceComponent } from './new-service.component';
import { ServerActionsComponent } from './server-actions.component';
import { ServerInfoComponent } from './server-info.component';
import { ServerTab, WorkspaceService } from './workspace.service';

const SERVER_TABS: { id: ServerTab; label: string; icon: string }[] = [
  { id: 'estado', label: 'Estado', icon: 'activity' },
  { id: 'apps', label: 'Apps', icon: 'package' },
  { id: 'acciones', label: 'Acciones', icon: 'gear' },
];

@Component({
  selector: 'app-app-list',
  standalone: true,
  imports: [IconComponent, FormsModule, NewServiceComponent, ServerInfoComponent, ServerActionsComponent],
  template: `
    <div class="head">
      @if (layout.layout() === 'phone') { <button class="btn ghost icon" (click)="ws.back()" aria-label="Volver"><app-icon name="arrow-left" /></button> }
      <div class="grow" style="min-width:0"><h2 class="ell">{{ ws.profile()?.name || 'Apps' }}</h2>
        <div class="small mut ell">{{ stateText() }}</div></div>
      <button class="btn ghost icon sm" (click)="ws.profileId() && (ws.conn.isConnected(ws.profileId()!) ? ws.refresh(true) : ws.connect())" aria-label="Actualizar" [disabled]="ws.loading()"><app-icon name="refresh" [class.spin]="ws.loading()" /></button>
      @if (!phone()) { <button class="btn sm icon" (click)="openAdd()" [disabled]="!ws.profile()" aria-label="Agregar app" title="Agregar app"><app-icon name="plus" [size]="18" /></button> }
    </div>
    <div class="scroll">
      @if (!ws.profile()) { <div class="empty"><app-icon name="server" [size]="36" /><div>Elige un servidor.</div></div> }
      @else if (phone() && ws.serverTab() === 'estado') { <div style="margin:0 4px"><app-server-info /></div> }
      @else if (phone() && ws.serverTab() === 'acciones') { <div style="margin:0 4px"><app-server-actions /></div> }
      @else {
        @if (ws.state() !== 'connected') {
          <div class="banner" [class.err]="ws.state() === 'error'" style="margin:4px 4px 10px"><app-icon name="alert" />
            <div class="grow">{{ ws.state() === 'connecting' ? 'Conectando…' : ws.conn.error(ws.profile()!.id) || 'Sin conexión con el servidor.' }}</div>
            @if (ws.state() !== 'connecting') { <button class="btn sm" (click)="ws.connect()">Conectar</button> }</div>
        } @else if (ws.listError()) {
          <div class="banner err" style="margin:4px 4px 10px"><app-icon name="alert" /><div>{{ ws.listError() }}</div></div>
        }
        @if (phone() && ws.apps().length) { <button class="btn sec addapp" (click)="openAdd()"><app-icon name="plus" [size]="16" />Agregar app</button> }
        @if (!ws.apps().length) {
          <div class="empty"><app-icon name="package" [size]="40" /><div style="margin:6px 0 14px">Aún no agregaste apps de este servidor.<br>Elige entre las que ya están registradas en PM2.</div>
            <button class="btn" (click)="openAdd()" [disabled]="ws.state() !== 'connected'"><app-icon name="plus" />Agregar app de PM2</button></div>
        }
        <div class="list">
          @for (a of ws.apps(); track a.id) {
            @let g = groupOf(a);
            <div class="item" [class.sel]="ws.appId() === a.id" (click)="ws.selectApp(a.id)">
              <span class="dot" [class]="dotOf(g)"></span>
              <div class="grow"><div class="t ell">{{ a.label }}</div>
                <div class="s ell">@if (g) { {{ statusText(g) }} · {{ g.cpu }}% · {{ fmt(g.memory) }}@if (g.procs.length > 1) { · {{ g.procs.length }} inst. } } @else if (ws.state() === 'connected' && ws.lastUpdate()) { <span class="warn">No está en PM2</span> } @else { {{ a.pm2Name }} }</div></div>
              <app-icon name="chevron-right" class="mut" />
            </div>
          }
        </div>
      }
    </div>

    @if (phone() && ws.profile()) {
      <nav class="bottom">@for (t of serverTabs; track t.id) { <button [class.on]="ws.serverTab() === t.id" (click)="ws.serverTab.set(t.id)"><app-icon [name]="t.icon" [size]="22" /><span>{{ t.label }}</span></button> }</nav>
    }

    @if (adding()) {
      <div class="backdrop" (mousedown)="$event.target === $event.currentTarget && adding.set(false)"><div class="modal" role="dialog">
        <header><h3>Agregar app</h3><button class="btn ghost icon sm" (click)="adding.set(false)" aria-label="Cerrar"><app-icon name="close" /></button></header>
        <div class="body">
          <div class="seg" style="margin-bottom:14px"><button [class.on]="mode() === 'existing'" (click)="mode.set('existing')">Ya está en PM2</button><button [class.on]="mode() === 'new'" (click)="mode.set('new')">Crear servicio nuevo</button></div>
          @if (mode() === 'existing') {
            @if (!available().length) { <div class="empty">{{ ws.groups().length ? 'Ya agregaste todas las apps de PM2 de este servidor.' : 'PM2 no tiene procesos registrados en este servidor.' }}<div class="small" style="margin:8px 0 12px">Puedes crear uno nuevo desde aquí.</div><button class="btn" (click)="mode.set('new')"><app-icon name="plus" />Crear servicio nuevo</button></div> }
            <div class="list">
              @for (g of available(); track g.name) {
                <div class="item" (click)="add(g)"><span class="dot" [class]="dotOf(g)"></span>
                  <div class="grow"><div class="t">{{ g.name }}</div><div class="s ell mono">{{ g.cwd }}</div></div><app-icon name="plus" class="mut" /></div>
              }
            </div>
          } @else { <app-new-service (closed)="adding.set(false)" (created)="onCreated($event)" /> }
        </div>
      </div></div>
    }`,
  styles: [`
    :host { display:flex; flex-direction:column; min-height:0; flex:1; }
    .head { display:flex; align-items:center; gap:6px; padding:10px 12px 6px; } .scroll { overflow:auto; padding:4px 8px 12px; flex:1; }
    .addapp { width:calc(100% - 8px); margin:0 4px 10px; justify-content:center; }
    .bottom { display:flex; flex:none; background:var(--card); border-top:1px solid var(--line); padding-bottom:var(--sab); }
    .bottom button { flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; gap:2px; background:none; border:0; color:var(--mut); padding:8px 2px 6px; min-height:58px; cursor:pointer; font:inherit; }
    .bottom button span { font-size:11px; } .bottom button.on { color:var(--acc2); box-shadow:inset 0 2px 0 var(--acc); }
    @media (max-width:719px) { .head { padding-top:calc(8px + var(--sat)); } .item { background:var(--card); border:1px solid var(--line); margin-bottom:8px; min-height:64px; } }
  `],
})
export class AppListComponent {
  readonly ws = inject(WorkspaceService);
  readonly layout = inject(LayoutService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);
  readonly adding = signal(false);
  readonly mode = signal<'existing' | 'new'>('existing');
  readonly fmt = fmtBytes;
  readonly serverTabs = SERVER_TABS;
  readonly phone = computed(() => this.layout.layout() === 'phone');

  readonly available = computed(() => { const have = new Set(this.ws.apps().map((a) => a.pm2Name)); return this.ws.groups().filter((g) => !have.has(g.name)); });
  readonly stateText = computed(() => ({ connected: 'Conectado' + (this.ws.lastUpdate() ? '' : ''), connecting: 'Conectando…', error: 'Error de conexión', disconnected: 'Desconectado' })[this.ws.state()]);

  groupOf(a: TrackedApp): Pm2Group | undefined { return this.ws.groups().find((g) => g.name === a.pm2Name); }
  dotOf(g?: Pm2Group) { return !g ? '' : g.status === 'online' ? 'ok' : g.status === 'partial' || g.status === 'launching' ? 'warn' : g.status === 'errored' ? 'err' : ''; }
  statusText(g: Pm2Group) { return ({ online: 'En línea', partial: 'Parcial', stopped: 'Detenida', errored: 'Con error', launching: 'Iniciando' })[g.status]; }

  async openAdd() {
    if (this.ws.state() !== 'connected') await this.ws.connect(); else await this.ws.refresh(true);
    if (this.ws.state() === 'connected') { this.mode.set(this.available().length ? 'existing' : 'new'); this.adding.set(true); }
    else this.toast.show('Primero hay que conectar con el servidor', 'err');
  }
  async onCreated(name: string) {
    const g = this.ws.groups().find((x) => x.name === name);
    this.adding.set(false);
    if (g) { const a = await this.ws.addApp(g); this.ws.selectApp(a.id, 'estado'); }
  }
  async add(g: Pm2Group) {
    const a = await this.ws.addApp(g);
    this.adding.set(false);
    this.ws.selectApp(a.id, 'estado');
  }
}
