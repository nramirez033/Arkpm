import { Component, inject, signal } from '@angular/core';
import { ConnectionService } from './connection.service';
import { ToastService } from './dialog.service';
import { IconComponent } from './icon.component';
import { ServerActionsService } from './server-actions.service';
import { ServerEditorComponent } from './server-editor.component';
import { WorkspaceService } from './workspace.service';

/** Pestaña «Acciones» del servidor (móvil): las mismas acciones del menú «⋮» de la lista de servidores. */
@Component({
  selector: 'app-server-actions',
  standalone: true,
  imports: [IconComponent, ServerEditorComponent],
  template: `
    @if (ws.profile(); as p) {
      <div class="list">
        @if (conn.isConnected(p.id)) {
          <div class="item" (click)="disconnect()"><app-icon name="unlink" class="mut" />
            <div class="grow"><div class="t">Desconectar</div><div class="s">Cierra la sesión SSH con este servidor</div></div></div>
        } @else {
          <div class="item" (click)="connect()"><app-icon name="link" class="mut" />
            <div class="grow"><div class="t">Conectar</div><div class="s">Abre la sesión SSH con este servidor</div></div></div>
        }
        <div class="item" (click)="editing.set(true)"><app-icon name="edit" class="mut" />
          <div class="grow"><div class="t">Editar</div><div class="s">Nombre, dirección, usuario y ajustes de PM2</div></div></div>
        <div class="item" (click)="forget()"><app-icon name="key" class="mut" />
          <div class="grow"><div class="t">Olvidar credenciales guardadas</div><div class="s">Se pedirán de nuevo al conectar</div></div></div>
        <div class="item danger" (click)="remove()"><app-icon name="trash" />
          <div class="grow"><div class="t">Eliminar servidor</div><div class="s">Lo quita de esta app; no toca nada en el servidor</div></div></div>
      </div>
      @if (editing()) { <app-server-editor [profile]="p" (closed)="editing.set(false)" (saved)="editing.set(false)" /> }
    }`,
  styles: [`
    :host { display:block; }
    .item.danger, .item.danger .t { color:var(--err); }
  `],
})
export class ServerActionsComponent {
  readonly ws = inject(WorkspaceService);
  readonly conn = inject(ConnectionService);
  private readonly actions = inject(ServerActionsService);
  private readonly toast = inject(ToastService);
  readonly editing = signal(false);

  async connect() {
    const p = this.ws.profile();
    if (!p) return;
    await this.ws.connect(p.id);
    const err = this.conn.error(p.id);
    if (err && !this.conn.isConnected(p.id) && err !== 'Conexión cancelada') this.toast.show(err, 'err');
  }
  async disconnect() { const p = this.ws.profile(); if (p) await this.actions.disconnect(p); }
  async forget() { const p = this.ws.profile(); if (p) await this.actions.forgetCredentials(p); }
  async remove() { const p = this.ws.profile(); if (p) await this.actions.remove(p); }
}
