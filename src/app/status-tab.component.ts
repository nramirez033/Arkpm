import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogService, ToastService } from './dialog.service';
import { fmtBytes, fmtUptime } from './format';
import { IconComponent } from './icon.component';
import { Pm2Service } from './pm2.service';
import { WorkspaceService } from './workspace.service';

@Component({
  selector: 'app-status-tab',
  standalone: true,
  imports: [IconComponent, FormsModule],
  template: `
    <div class="wrap">
      @if (!g(); as _) {
        <div class="banner"><app-icon name="alert" /><div>Esta app no aparece ahora en la lista de PM2 del servidor. Puede que se haya eliminado o renombrado.
          Puedes quitarla de la lista o volver a registrarla en el servidor con <code>pm2 start … --name {{ ws.app()?.pm2Name }}</code>.</div></div>
      }
      @if (g(); as g) {
        <div class="card">
          <div class="row wrapr" style="gap:12px">
            <span class="badge" [class]="'badge ' + cls(g.status)"><span class="dot" [class]="cls(g.status)"></span>{{ txt(g.status) }}</span>
            <span class="mut small">PM2: <b class="mono">{{ g.name }}</b></span>
            <span class="grow"></span>
            <button class="btn" (click)="ws.act('start', g.name)" [disabled]="!!ws.busy() || g.status === 'online'"><app-icon name="play" [size]="16" />Iniciar</button>
            <button class="btn sec" (click)="stop()" [disabled]="!!ws.busy() || g.status === 'stopped'"><app-icon name="stop" [size]="16" />Detener</button>
            <button class="btn sec" (click)="ws.act('restart', g.name)" [disabled]="!!ws.busy()"><app-icon name="restart" [size]="16" />Reiniciar</button>
            @if (g.procs[0].mode === 'cluster') { <button class="btn sec" (click)="ws.act('reload', g.name)" [disabled]="!!ws.busy()" title="Reinicio sin cortar el servicio (cluster)"><app-icon name="refresh" [size]="16" />Recargar</button> }
            <button class="btn ghost icon" (click)="more()" aria-label="Más acciones"><app-icon name="more" /></button>
          </div>
          @if (ws.busy()) { <div class="bar ind" style="margin-top:12px"><div></div></div> }
        </div>

        <div class="metrics">
          <div class="card m"><div class="lbl">CPU</div><div class="v">{{ g.cpu }}<small>%</small></div></div>
          <div class="card m"><div class="lbl">Memoria</div><div class="v">{{ mem(g.memory) }}</div></div>
          <div class="card m"><div class="lbl">Tiempo activa</div><div class="v">{{ up() }}</div></div>
          <div class="card m"><div class="lbl">Reinicios</div><div class="v" [class.warn]="g.procs[0].unstable > 0">{{ g.restarts }}</div>@if (g.procs[0].unstable) { <div class="small warn">{{ g.procs[0].unstable }} inestables</div> }</div>
        </div>

        @if (g.status === 'errored' || g.restarts > 10) {
          <div class="banner err"><app-icon name="alert" /><div class="grow">{{ g.status === 'errored' ? 'La app terminó con error.' : 'La app se reinició muchas veces.' }} Revisa la pestaña Logs para ver la causa.</div>
            <button class="btn sm sec" (click)="ws.tab.set('logs')">Ver logs</button></div>
        }

        @if (g.procs.length > 1) {
          <div class="card"><h3>Instancias ({{ g.procs.length }})</h3>
            <div class="col" style="gap:0">
              @for (p of g.procs; track p.pmId) {
                <div class="row inst"><span class="dot" [class]="cls(p.status)"></span><span class="mono">#{{ p.pmId }}</span><span class="grow mut small">PID {{ p.pid || '—' }}</span>
                  <span class="small">{{ p.cpu }}%</span><span class="small mut" style="width:64px;text-align:right">{{ mem(p.memory) }}</span></div>
              }
            </div></div>
        }

        <div class="card"><h3>Detalles</h3>
          <dl class="kv">
            <dt>Modo</dt><dd>{{ g.procs[0].mode === 'cluster' ? 'Cluster (' + g.procs.length + ' instancias)' : 'Fork' }}</dd>
            <dt>Script</dt><dd class="mono">{{ g.procs[0].script || '—' }}{{ g.procs[0].args ? ' ' + g.procs[0].args : '' }}</dd>
            <dt>Carpeta (PM2)</dt><dd class="mono">{{ g.cwd || '—' }}</dd>
            <dt>Intérprete</dt><dd>{{ g.procs[0].interpreter || '—' }}{{ g.procs[0].nodeVersion ? ' · Node ' + g.procs[0].nodeVersion : '' }}</dd>
            <dt>Log de salida</dt><dd class="mono">{{ g.outLog || '—' }}</dd>
            <dt>Log de errores</dt><dd class="mono">{{ g.errLog || '—' }}</dd>
            @if (g.procs[0].namespace && g.procs[0].namespace !== 'default') { <dt>Namespace</dt><dd>{{ g.procs[0].namespace }}</dd> }
          </dl>
        </div>
      }

      <div class="card"><h3>Ajustes de esta app</h3>
        <div class="field"><label>Nombre que se muestra</label><input [ngModel]="ws.app()?.label" (change)="rename($any($event.target).value)" /></div>
        <div class="field"><label>Carpeta en el servidor</label>
          <div class="row"><input class="mono" [ngModel]="ws.app()?.dir" (change)="setDir($any($event.target).value)" [placeholder]="g()?.cwd || '/home/usuario/mi-app'" />
            @if (ws.app()?.dir) { <button class="btn sec" (click)="setDir('')">Usar la de PM2</button> }</div>
          <div class="hint">La usan el explorador, el deploy y el backup. Por defecto es la carpeta de trabajo que informa PM2.</div></div>
      </div>
    </div>`,
  styles: [`
    .wrap { display:flex; flex-direction:column; gap:12px; max-width:960px; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; }
    .m .v { font-size:24px; font-weight:600; line-height:1.2; white-space:nowrap; } .m small { font-size:14px; color:var(--mut); } .m .lbl { color:var(--mut); font-size:12px; }
    .inst { padding:8px 4px; border-bottom:1px solid var(--line); } .inst:last-child { border:0; }
  `],
})
export class StatusTabComponent {
  readonly ws = inject(WorkspaceService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);
  private readonly pm2 = inject(Pm2Service);
  readonly g = this.ws.group;
  readonly mem = fmtBytes;
  readonly up = computed(() => { this.ws.lastUpdate(); const g = this.ws.group(); return g?.startedAt ? fmtUptime(Date.now() - g.startedAt) : '—'; });

  cls(s: string) { return s === 'online' ? 'ok' : s === 'partial' || s === 'launching' ? 'warn' : s === 'errored' ? 'err' : ''; }
  txt(s: string) { return ({ online: 'En línea', partial: 'Parcialmente en línea', stopped: 'Detenida', errored: 'Con error', launching: 'Iniciando', stopping: 'Deteniendo' } as Record<string, string>)[s] ?? s; }

  async stop() {
    const g = this.g();
    if (g && await this.dialogs.confirm({ title: 'Detener la app', message: `«${g.name}» dejará de responder hasta que la inicies de nuevo.`, okText: 'Detener', danger: true })) this.ws.act('stop', g.name);
  }

  async more() {
    const a = this.ws.app(), g = this.g();
    if (!a) return;
    const r = await this.dialogs.menu(a.label, [
      { id: 'save', label: 'Guardar la lista de PM2 (pm2 save)', icon: 'save' },
      { id: 'refresh', label: 'Actualizar ahora', icon: 'refresh' },
      { id: 'untrack', label: 'Quitar de esta lista', icon: 'close' },
      { id: 'delete', label: 'Eliminar de PM2 en el servidor', icon: 'trash', danger: true, disabled: !g },
    ]);
    if (r === 'save') { try { await this.pm2.save(a.profileId); this.toast.ok('Lista de PM2 guardada: se restaurará al reiniciar el servidor'); } catch (e) { this.toast.err(e); } }
    else if (r === 'refresh') this.ws.refresh(true);
    else if (r === 'untrack') {
      if (await this.dialogs.confirm({ title: 'Quitar de la lista', message: `«${a.label}» dejará de mostrarse aquí junto con su configuración e historial. No se toca nada en el servidor.`, okText: 'Quitar' })) await this.ws.removeApp(a.id);
    } else if (r === 'delete' && g) {
      if (await this.dialogs.confirm({ title: 'Eliminar de PM2', message: `Se ejecutará «pm2 delete ${g.name}»: el proceso se detiene y deja de estar registrado en PM2. Los archivos de la app NO se borran.`, okText: 'Eliminar de PM2', danger: true })) { await this.ws.act('delete', g.name); await this.ws.removeApp(a.id); }
    }
  }

  async rename(v: string) { const t = v.trim(); if (t) await this.ws.updateApp({ label: t }); }
  async setDir(v: string) { await this.ws.updateApp({ dir: v.trim().replace(/\/+$/, '') }); this.toast.ok(v.trim() ? 'Carpeta actualizada' : 'Se usará la carpeta de PM2'); }
}
