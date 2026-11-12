import { Component, inject, input } from '@angular/core';
import { IconComponent } from './icon.component';
import { WorkspaceService } from './workspace.service';

/** Dónde se guarda lo que se edita en esta pestaña: en el servidor (compartido) o solo en este dispositivo. */
@Component({
  selector: 'app-shared-status',
  standalone: true,
  imports: [IconComponent],
  template: `
    @switch (ws.sharedState()) {
      @case ('ok') { <div class="s ok"><app-icon name="check" [size]="14" />{{ what() }} se guardan en el servidor (<span class="mono">{{ ws.sharedPath() }}</span>): las ven todos los usuarios y conexiones.</div> }
      @case ('readonly') { <div class="banner"><app-icon name="alert" /><div>Este usuario no tiene permiso de escritura en <span class="mono">{{ ws.appDir() }}</span>: {{ what().toLowerCase() }} se guardan solo en este dispositivo y no se comparten.</div></div> }
      @case ('unavailable') { <div class="banner"><app-icon name="alert" /><div>No se puede crear <span class="mono">{{ ws.sharedPath() }}</span> (sin permiso de escritura en la carpeta de la app): {{ what().toLowerCase() }} se guardan solo en este dispositivo.</div></div> }
      @case ('offline') { <div class="s"><app-icon name="unlink" [size]="14" />Sin conexión con el servidor: {{ what().toLowerCase() }} se ven desde la copia de este dispositivo y se sincronizan al volver.</div> }
    }`,
  styles: [`.s { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--mut); } .s.ok { color:var(--ok); } .s .mono { font-size:11.5px; color:var(--mut); word-break:break-all; }`],
})
export class SharedStatusComponent {
  readonly ws = inject(WorkspaceService);
  readonly what = input('La configuración');
}
