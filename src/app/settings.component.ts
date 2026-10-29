import { Component, OnDestroy, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ToastService } from './dialog.service';
import { IconComponent } from './icon.component';
import { LayoutService } from './layout.service';
import { DesktopOptions, TRANSPORT } from './transport';
import { NotifyService } from './notify.service';
import { StoreService } from './store.service';

/** Notificaciones, segundo plano y servidores vigilados. */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="backdrop" (mousedown)="$event.target === $event.currentTarget && closed.emit()"><div class="modal wide" role="dialog">
      <header><app-icon name="gear" /><h3>Notificaciones y segundo plano</h3><button class="btn ghost icon sm" (click)="closed.emit()" aria-label="Cerrar"><app-icon name="close" /></button></header>
      <div class="body">
        <section class="card">
          <label class="chk big"><input type="checkbox" [checked]="s().enabled" (change)="toggle($event, 'enabled')" /><span><b>Avisarme de lo que pasa en mis servidores</b><br><span class="mut small">Notificación del sistema cuando un servicio se inicia, se detiene o falla, o cuando se pierde la conexión.</span></span></label>
          @if (n.permission() === 'denied') { <div class="banner err" style="margin-top:10px"><app-icon name="alert" /><div>El sistema bloquea las notificaciones de Arkpm. Actívalas en los ajustes {{ layout.platform === 'android' ? 'del teléfono (Aplicaciones → Arkpm → Notificaciones)' : 'de Windows (Sistema → Notificaciones)' }} y vuelve a activar esta opción.</div></div> }
          @if (s().enabled) {
            <div class="sub">
              <div class="lbl">Avisar cuando…</div>
              <label class="chk"><input type="checkbox" [ngModel]="s().events.started" (ngModelChange)="n.update({ events: { started: $event } })" /><span>un servicio <b>se inicia</b></span></label>
              <label class="chk"><input type="checkbox" [ngModel]="s().events.stopped" (ngModelChange)="n.update({ events: { stopped: $event } })" /><span>un servicio <b>se detiene</b></span></label>
              <label class="chk"><input type="checkbox" [ngModel]="s().events.errored" (ngModelChange)="n.update({ events: { errored: $event } })" /><span>un servicio tiene un <b>error</b> o se reinicia solo</span></label>
              <label class="chk"><input type="checkbox" [ngModel]="s().events.connection" (ngModelChange)="n.update({ events: { connection: $event } })" /><span>se <b>pierde la conexión</b> con el servidor (y cuando vuelve)</span></label>
              <div class="field" style="margin-top:10px;max-width:280px"><label>Revisar los servidores cada</label>
                <select [ngModel]="s().interval" (ngModelChange)="n.update({ interval: +$event })"><option [value]="15">15 segundos</option><option [value]="30">30 segundos</option><option [value]="60">1 minuto</option><option [value]="120">2 minutos</option><option [value]="300">5 minutos</option></select>
                <div class="hint">Menos tiempo = avisos más rápidos pero más consumo de batería y de datos.</div></div>
              <button class="btn sec sm" (click)="test()"><app-icon name="check" [size]="15" />Enviar notificación de prueba</button>
            </div>
          }
        </section>

        @if (desktop(); as d) {
          <section class="card">
            <h3>Inicio y ventana (escritorio)</h3>
            <label class="chk big"><input type="checkbox" [checked]="d.autoStart" [disabled]="!d.supported" (change)="setDesktop($event, 'autoStart')" /><span><b>{{ d.platform === 'darwin' ? 'Iniciar con macOS' : 'Iniciar con Windows' }}</b><br>
              <span class="mut small">{{ d.supported ? 'Arkpm se abre solo al iniciar sesión en el equipo.' : 'Disponible solo en la versión instalada o portable (no en modo desarrollo) de Windows o macOS.' }}</span></span></label>
            <label class="chk big"><input type="checkbox" [checked]="d.startHidden" (change)="setDesktop($event, 'startHidden')" /><span><b>Iniciar en segundo plano</b><br>
              <span class="mut small">Al abrir Arkpm no se muestra la ventana: queda en la bandeja del sistema y una notificación lo avisa. Se abre con un clic en el icono de la bandeja.</span></span></label>
            <label class="chk big"><input type="checkbox" [checked]="d.minimizeToBackground" (change)="setDesktop($event, 'minimizeToBackground')" /><span><b>Al minimizar, pasar a segundo plano</b><br>
              <span class="mut small">Minimizar oculta la ventana (queda el icono de la bandeja) y una notificación te avisa de que pasó a segundo plano.</span></span></label>
            <label class="chk big"><input type="checkbox" [checked]="d.confirmClose" (change)="setDesktop($event, 'confirmClose')" /><span><b>Pedir confirmación al cerrar</b><br>
              <span class="mut small">Al cerrar la ventana pregunta si quieres cerrar Arkpm{{ s().background ? ', pasarlo a segundo plano' : '' }} o cancelar.</span></span></label>
          </section>
        } @else if (layout.platform === 'android') {
          <section class="card">
            <h3>Al salir</h3>
            <label class="chk big"><input type="checkbox" [checked]="confirmExit()" (change)="setConfirmExit($event)" /><span><b>Pedir confirmación al salir</b><br>
              <span class="mut small">Al pulsar Atrás en la pantalla principal pregunta antes de cerrar Arkpm.</span></span></label>
          </section>
        }

        <section class="card" [class.off]="!s().enabled">
          <label class="chk big"><input type="checkbox" [checked]="s().background" [disabled]="!s().enabled" (change)="toggle($event, 'background')" /><span><b>Seguir vigilando en segundo plano</b><br>
            <span class="mut small">@if (layout.platform === 'android') { Con la app cerrada, un servicio en primer plano sigue revisando tus servidores (verás una notificación permanente). Te avisamos cuando la app pasa a segundo plano. } @else { Al cerrar la ventana, Arkpm se queda en la bandeja del sistema y sigue vigilando. Te avisamos cuando pasa a segundo plano. Para salir del todo: clic derecho en el icono de la bandeja → Salir. }</span></span></label>
          @if (layout.platform === 'android' && s().enabled && s().background) {
            <div class="banner info" style="margin-top:10px"><app-icon name="info" /><div class="grow">Para que Android no detenga el servicio, excluye a Arkpm de la optimización de batería.</div><button class="btn sm sec" (click)="n.batterySettings()">Abrir ajustes</button></div>
          }
        </section>

        <section class="card">
          <h3>Servidores vigilados</h3>
          @for (p of store.profiles(); track p.id) {
            <div class="srv row">
              <label class="chk grow"><input type="checkbox" [ngModel]="n.serverOn(p.id)" (ngModelChange)="n.setServer(p.id, $event)" /><span><b>{{ p.name }}</b><span class="mut small" style="margin-left:8px">{{ p.username }}&#64;{{ p.host }}</span></span></label>
              @if (s().enabled && n.serverOn(p.id)) { <span class="badge" [class]="'badge ' + cls(p.id)">{{ label(p.id) }}</span> }
            </div>
            @if (s().enabled && n.serverOn(p.id) && why(p.id)) { <div class="hint" style="margin:-4px 0 8px 28px">{{ why(p.id) }}</div> }
          }
          @if (!store.profiles().length) { <div class="mut small">Aún no hay servidores.</div> }
          <div class="hint" style="margin-top:6px">Para vigilar un servidor hay que haberlo conectado al menos una vez (para verificar su huella) y tener su contraseña o clave guardada en este dispositivo.</div>
        </section>
      </div>
      <footer><button class="btn" (click)="closed.emit()">Listo</button></footer>
    </div></div>`,
  styles: [`
    .card { margin-bottom:12px; } .card.off { opacity:.55; } .chk.big { align-items:flex-start; gap:12px; } .chk.big input { margin-top:3px; }
    .sub { margin:12px 0 0 30px; display:flex; flex-direction:column; gap:2px; } .srv { padding:2px 0; }
  `],
})
export class SettingsComponent implements OnInit, OnDestroy {
  readonly n = inject(NotifyService);
  readonly store = inject(StoreService);
  readonly layout = inject(LayoutService);
  private readonly toast = inject(ToastService);
  private readonly t = inject(TRANSPORT);
  readonly desktop = signal<DesktopOptions | null>(null);
  readonly confirmExit = signal(this.store.getSetting<boolean>('confirmExit', true));
  readonly closed = output<void>();
  readonly s = this.n.settings;
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit() { this.t.desktopGet().then((d) => this.desktop.set(d)).catch(() => { /* sin opciones de escritorio */ }); this.n.refreshStatus(); this.timer = setInterval(() => this.n.refreshStatus(), 3000); }
  ngOnDestroy() { if (this.timer) clearInterval(this.timer); }

  private st(id: string) { return this.n.status().find((x) => x.id === id); }
  label(id: string) { return ({ up: 'Vigilando', down: 'Sin conexión', skipped: 'En pausa', error: 'PM2 no responde', pending: 'Iniciando…', off: '' } as Record<string, string>)[this.st(id)?.state ?? 'pending']; }
  cls(id: string) { const x = this.st(id)?.state; return x === 'up' ? 'ok' : x === 'down' || x === 'error' ? 'err' : x === 'skipped' ? 'warn' : ''; }
  why(id: string) { const x = this.st(id); return x && (x.state === 'skipped' || x.state === 'down' || x.state === 'error') ? x.reason : ''; }
  /** Aplica el cambio y deja la casilla como quedó de verdad (p. ej. si el sistema niega el permiso de notificaciones). */
  async toggle(ev: Event, key: 'enabled' | 'background') {
    const el = ev.target as HTMLInputElement;
    await this.n.update({ [key]: el.checked });
    el.checked = this.n.settings()[key];
  }

  /** Guarda una opción de escritorio y deja la casilla como quedó de verdad. */
  async setDesktop(ev: Event, key: 'autoStart' | 'startHidden' | 'minimizeToBackground' | 'confirmClose') {
    const el = ev.target as HTMLInputElement;
    try { this.desktop.set(await this.t.desktopSet({ [key]: el.checked })); }
    catch (e) { this.toast.err(e); }
    el.checked = !!this.desktop()?.[key];
  }

  async setConfirmExit(ev: Event) {
    const on = (ev.target as HTMLInputElement).checked;
    this.confirmExit.set(on);
    await this.store.setSetting('confirmExit', on);
  }

  async test() { try { await this.n.test(); } catch (e) { this.toast.err(e); } }
}
