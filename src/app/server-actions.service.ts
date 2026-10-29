import { Injectable, inject } from '@angular/core';
import { ConnectionService } from './connection.service';
import { DialogService, ToastService } from './dialog.service';
import { ServerProfile } from './models';
import { StoreService } from './store.service';
import { WorkspaceService } from './workspace.service';

/** Acciones sobre un servidor (desconectar, olvidar credenciales, eliminar), compartidas por la lista de servidores y la pestaña «Acciones» del móvil. */
@Injectable({ providedIn: 'root' })
export class ServerActionsService {
  private readonly store = inject(StoreService);
  private readonly conn = inject(ConnectionService);
  private readonly ws = inject(WorkspaceService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);

  disconnect(p: ServerProfile) { return this.conn.disconnect(p.id); }

  async forgetCredentials(p: ServerProfile) {
    await this.conn.forgetSecret(p.id);
    await this.store.saveProfile({ ...p, remember: false });
    this.toast.ok('Credenciales olvidadas');
  }

  async remove(p: ServerProfile) {
    const n = this.store.apps().filter((a) => a.profileId === p.id).length;
    const ok = await this.dialogs.confirm({
      title: 'Eliminar servidor',
      message: `Se quitará «${p.name}» de esta app${n ? ` junto con sus ${n} app(s) agregadas y su historial` : ''}. No se toca nada en el servidor.`,
      okText: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    await this.conn.disconnect(p.id);
    await this.conn.forgetSecret(p.id);
    await this.store.deleteProfile(p.id);
    if (this.ws.profileId() === p.id) { this.ws.profileId.set(null); this.ws.appId.set(null); this.ws.phoneView.set('servers'); }
  }
}
