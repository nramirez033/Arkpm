import { Component, HostListener, OnInit, inject } from '@angular/core';
import { App } from '@capacitor/app';
import { AppDetailComponent } from './app-detail.component';
import { AppListComponent } from './app-list.component';
import { DialogHostComponent } from './dialog-host.component';
import { DialogService } from './dialog.service';
import { IconComponent } from './icon.component';
import { LayoutService } from './layout.service';
import { NotifyService } from './notify.service';
import { NginxComponent } from './nginx.component';
import { ServerInfoComponent } from './server-info.component';
import { ServerListComponent } from './server-list.component';
import { StoreService } from './store.service';
import { TitlebarComponent } from './titlebar.component';
import { VERSIONS } from './version';
import { WorkspaceService } from './workspace.service';

/** Cascarón de la app: 1 columna en teléfono (servidores → apps → detalle), 2 en tableta y escritorio (lateral + detalle). */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [TitlebarComponent, ServerListComponent, ServerInfoComponent, AppListComponent, AppDetailComponent, DialogHostComponent, IconComponent, NginxComponent],
  template: `
    @if (layout.isElectron) { <app-titlebar /> }
    @if (layout.platform === 'web') { <div class="banner" style="border-radius:0">Vista de navegador: la conexión SSH solo funciona en la app de escritorio (Electron) o en la de Android.</div> }
    <div class="shell" [class]="'shell ' + layout.layout()">
      @if (layout.layout() === 'phone') {
        @switch (ws.phoneView()) {
          @case ('servers') { <app-server-list class="screen" /> }
          @case ('apps') { <app-app-list class="screen" /> }
          @case ('detail') { @for (id of [ws.appId()]; track id) { <app-detail class="screen" /> } }
        }
      } @else {
        <aside class="side">
          <app-server-list class="srv" />
          <app-app-list class="apps" />
          <div class="ver small mut">Arkpm {{ version }}</div>
        </aside>
        <main class="main">
          @if (ws.appId()) { @for (id of [ws.appId()]; track id) { <app-detail /> } }
          @else if (ws.profile()) { <div class="infopane">
            <div class="seg" style="margin-bottom:14px"><button [class.on]="ws.serverTab() !== 'nginx'" (click)="ws.serverTab.set('apps')"><app-icon name="activity" [size]="15" /> Información</button><button [class.on]="ws.serverTab() === 'nginx'" (click)="ws.serverTab.set('nginx')"><app-icon name="globe" [size]="15" /> Nginx</button></div>
            @if (ws.serverTab() === 'nginx') { <app-nginx /> } @else { <app-server-info /> }
          </div> }
          @else { <div class="empty big"><app-icon name="activity" [size]="48" /><h2>Administrador de PM2</h2>
            <p>Elige un servidor a la izquierda para ver su información, o agrega uno nuevo.</p></div> }
        </main>
      }
    </div>
    <app-dialog-host />`,
  styles: [`
    .shell { flex:1; min-height:0; display:flex; } .screen { flex:1; min-width:0; display:flex; flex-direction:column; min-height:0; }
    .side { width:320px; flex:none; display:flex; flex-direction:column; border-right:1px solid var(--line); background:var(--card); min-height:0; }
    .shell.tablet .side { width:290px; }
    .srv { flex:0 1 auto; max-height:38%; } .apps { flex:1; border-top:1px solid var(--line); }
    .main { flex:1; min-width:0; display:flex; flex-direction:column; min-height:0; background:var(--bg); }
    .ver { padding:6px 14px; border-top:1px solid var(--line); }
    .infopane { flex:1; overflow:auto; padding:18px 20px; max-width:1000px; width:100%; }
    .empty.big { margin:auto; max-width:420px; } .empty.big h2 { margin:8px 0; color:var(--txt); }
  `],
})
export class AppComponent implements OnInit {
  readonly layout = inject(LayoutService);
  readonly ws = inject(WorkspaceService);
  private readonly store = inject(StoreService);
  private readonly dialogs = inject(DialogService);
  private readonly notify = inject(NotifyService);
  readonly version = layoutVersion(inject(LayoutService).platform);

  async ngOnInit() {
    document.body.classList.toggle('touch', this.layout.touch);
    await this.store.ready;
    // en tableta/escritorio se abre el último servidor usado (conecta solo si ya tiene credenciales guardadas)
    const last = this.store.getSetting<string | null>('lastProfile', null);
    const p = this.store.profiles().find((x) => x.id === last) ?? (this.store.profiles().length === 1 ? this.store.profiles()[0] : null);
    if (p && this.layout.layout() !== 'phone') {
      this.ws.profileId.set(p.id);
      if (p.remember || p.auth === 'key') this.ws.conn.connect(p.id, false).then(() => this.ws.refresh(true)).catch(() => { /* se verá al pulsar Conectar */ });
    }
    // clic en una notificación: abre ese servidor / servicio
    this.notify.onClick(({ serverId, app }) => {
      if (!serverId || !this.store.profiles().some((p) => p.id === serverId)) return;
      this.ws.selectProfile(serverId);
      this.ws.connect(serverId).then(() => {
        const a = app ? this.store.apps().find((x) => x.profileId === serverId && x.pm2Name === app) : null;
        if (a) this.ws.selectApp(a.id, 'estado');
      });
    });
    if (this.layout.platform === 'android') {
      try { await App.addListener('backButton', () => this.onBack()); } catch { /* sin plugin */ }
    }
  }

  // recuerda el último servidor elegido
  private _lp: string | null = null;
  ngDoCheck() { const id = this.ws.profileId(); if (id && id !== this._lp) { this._lp = id; this.store.setSetting('lastProfile', id); } }

  @HostListener('document:keydown.escape') onEsc() { this.dialogs.cancelTop(); }

  private onBack() {
    if (this.dialogs.cancelTop()) return;
    if (this.layout.layout() === 'phone') { if (this.ws.back()) return; }
    else if (this.ws.appId()) { this.ws.appId.set(null); return; }
    this.confirmExit();
  }

  private async confirmExit() {
    const bg = this.notify.settings().enabled && this.notify.settings().background;
    if (this.store.getSetting<boolean>('confirmExit', true)) {
      const ok = await this.dialogs.confirm({
        title: 'Salir de Arkpm', okText: 'Salir',
        message: bg ? 'La app se cerrará, pero seguirá vigilando tus servidores en segundo plano (verás su notificación permanente).' : '¿Quieres cerrar Arkpm?',
      });
      if (!ok) return;
    }
    App.exitApp();
  }
}

function layoutVersion(p: string) { return p === 'android' ? `${VERSIONS.android.version} ${VERSIONS.android.date}` : `${VERSIONS.electron.version} ${VERSIONS.electron.date}`; }
