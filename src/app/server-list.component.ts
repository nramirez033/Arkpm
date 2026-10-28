import { Component, inject, signal } from '@angular/core';
import { ConnectionService } from './connection.service';
import { DialogService, ToastService } from './dialog.service';
import { IconComponent } from './icon.component';
import { LayoutService } from './layout.service';
import { ServerProfile } from './models';
import { ServerEditorComponent } from './server-editor.component';
import { SettingsComponent } from './settings.component';
import { StoreService } from './store.service';
import { WorkspaceService } from './workspace.service';

/** Lista de servidores: pantalla completa en el teléfono y barra lateral en tableta/escritorio. */
@Component({
  selector: 'app-server-list',
  standalone: true,
  imports: [IconComponent, ServerEditorComponent, SettingsComponent],
  template: `
    <div class="head row">
      <h2 class="grow">Servidores</h2>
      <button class="btn ghost icon sm" (click)="settings.set(true)" aria-label="Notificaciones y segundo plano" title="Notificaciones y segundo plano"><app-icon name="gear" /></button>
      <button class="btn sm" (click)="edit.set({ p: null })"><app-icon name="plus" [size]="16" />Agregar</button>
    </div>
    <div class="scroll">
      @if (!store.profiles().length) {
        <div class="empty"><app-icon name="server" [size]="40" /><div style="margin:6px 0 14px">Todavía no hay servidores.<br>Agrega tu servidor Ubuntu para administrar sus apps de PM2.</div>
          <button class="btn" (click)="edit.set({ p: null })"><app-icon name="plus" />Agregar servidor</button></div>
      }
      <div class="list">
        @for (p of store.profiles(); track p.id) {
          <div class="item" [class.sel]="ws.profileId() === p.id" (click)="open(p)">
            <span class="dot" [class]="dot(p)"></span>
            <div class="grow"><div class="t ell">{{ p.name }}</div><div class="s ell">{{ p.username }}&#64;{{ p.host }}{{ p.port !== 22 ? ':' + p.port : '' }}</div></div>
            @if (conn.state(p.id) === 'connecting') { <app-icon name="refresh" [size]="16" class="spin mut" /> }
            @else if (layout.layout() === 'phone') { <span class="mut small">{{ label(p) }}</span> }
            <button class="btn ghost icon sm" (click)="menu(p, $event)" aria-label="Más acciones"><app-icon name="more" /></button>
          </div>
        }
      </div>
    </div>
    @if (settings()) { <app-settings (closed)="settings.set(false)" /> }
    @if (edit(); as e) { <app-server-editor [profile]="e.p" (closed)="edit.set(null)" (saved)="onSaved($event)" /> }`,
  styles: [`
    :host { display:flex; flex-direction:column; min-height:0; flex:1; }
    .head { padding:12px 12px 6px; } .scroll { overflow:auto; padding:4px 8px 12px; flex:1; }
    @media (max-width:719px) { .head { padding-top:calc(12px + var(--sat)); } .item { min-height:64px; background:var(--card); border:1px solid var(--line); margin-bottom:8px; } }
  `],
})
export class ServerListComponent {
  readonly store = inject(StoreService);
  readonly conn = inject(ConnectionService);
  readonly ws = inject(WorkspaceService);
  readonly layout = inject(LayoutService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);
  readonly edit = signal<{ p: ServerProfile | null } | null>(null);
  readonly settings = signal(false);

  dot(p: ServerProfile) { const s = this.conn.state(p.id); return s === 'connected' ? 'ok' : s === 'error' ? 'err' : s === 'connecting' ? 'warn' : ''; }
  label(p: ServerProfile) { return ({ connected: 'Conectado', connecting: 'Conectando…', error: 'Error', disconnected: '' } as const)[this.conn.state(p.id)]; }

  async open(p: ServerProfile) {
    this.ws.selectProfile(p.id);
    if (!this.conn.isConnected(p.id)) await this.ws.connect(p.id);
    else this.ws.refresh(true);
    const err = this.conn.error(p.id);
    if (err && !this.conn.isConnected(p.id) && err !== 'Conexión cancelada') this.toast.show(err, 'err');
  }

  async menu(p: ServerProfile, ev: Event) {
    ev.stopPropagation();
    const on = this.conn.isConnected(p.id);
    const r = await this.dialogs.menu(p.name, [
      on ? { id: 'disc', label: 'Desconectar', icon: 'unlink' } : { id: 'conn', label: 'Conectar', icon: 'link' },
      { id: 'edit', label: 'Editar', icon: 'edit' },
      { id: 'forget', label: 'Olvidar credenciales guardadas', icon: 'key' },
      { id: 'del', label: 'Eliminar servidor', icon: 'trash', danger: true },
    ]);
    if (r === 'conn') this.open(p);
    else if (r === 'disc') await this.conn.disconnect(p.id);
    else if (r === 'edit') this.edit.set({ p });
    else if (r === 'forget') { await this.conn.forgetSecret(p.id); await this.store.saveProfile({ ...p, remember: false }); this.toast.ok('Credenciales olvidadas'); }
    else if (r === 'del') {
      const n = this.store.apps().filter((a) => a.profileId === p.id).length;
      if (await this.dialogs.confirm({ title: 'Eliminar servidor', message: `Se quitará «${p.name}» de esta app${n ? ` junto con sus ${n} app(s) agregadas y su historial` : ''}. No se toca nada en el servidor.`, okText: 'Eliminar', danger: true })) {
        await this.conn.disconnect(p.id);
        await this.conn.forgetSecret(p.id);
        await this.store.deleteProfile(p.id);
        if (this.ws.profileId() === p.id) { this.ws.profileId.set(null); this.ws.appId.set(null); this.ws.phoneView.set('servers'); }
      }
    }
  }

  onSaved(p: ServerProfile) { if (!this.ws.profileId()) this.open(p); }
}
