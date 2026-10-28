import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { fmtBytes, fmtUptime } from './format';
import { IconComponent } from './icon.component';
import { WorkspaceService } from './workspace.service';

/** Ficha del servidor: SO, tiempo activo, CPU, memoria, discos y hardware. */
@Component({
  selector: 'app-server-info',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (ws.profile(); as p) {
      <div class="head row">
        <div class="grow" style="min-width:0"><h2 class="ell">{{ i()?.host || p.name }}</h2>
          <div class="small mut ell">{{ i() ? i()!.os + ' · kernel ' + i()!.kernel : p.username + '@' + p.host }}</div></div>
        <button class="btn sm ghost icon" (click)="ws.refreshInfo()" aria-label="Actualizar" [disabled]="ws.infoLoading()"><app-icon name="refresh" [class.spin]="ws.infoLoading()" /></button>
      </div>
      @if (ws.infoError()) { <div class="banner err"><app-icon name="alert" /><div>{{ ws.infoError() }}</div></div> }
      @if (ws.state() !== 'connected') { <div class="banner"><app-icon name="alert" /><div class="grow">Conecta con el servidor para ver su información.</div><button class="btn sm" (click)="ws.connect()">Conectar</button></div> }
      @if (i(); as s) {
        <div class="meters" [class.compact]="compact()">
          <div class="card m"><div class="row"><app-icon name="hard-drive" class="mut" /><b class="grow">Disco</b><span class="mut small">{{ disk()?.mount }}</span></div>
            <div class="big">{{ fmt(disk()?.used ?? 0) }} <small>de {{ fmt(disk()?.total ?? 0) }}</small></div>
            <div class="bar" [class.hi]="diskPct() > 85"><div [style.width.%]="diskPct()"></div></div>
            <div class="small mut">Libre {{ fmt(disk()?.avail ?? 0) }} · {{ diskPct() }}% usado</div></div>
          <div class="card m"><div class="row"><app-icon name="cpu" class="mut" /><b class="grow">Memoria</b><span class="mut small">RAM</span></div>
            <div class="big">{{ fmt(memUsed()) }} <small>de {{ fmt(s.memTotal) }}</small></div>
            <div class="bar" [class.hi]="memPct() > 90"><div [style.width.%]="memPct()"></div></div>
            <div class="small mut">Disponible {{ fmt(s.memAvail) }} · {{ memPct() }}% usado@if (s.swapTotal) { · swap {{ fmt(s.swapTotal - s.swapFree) }}/{{ fmt(s.swapTotal) }} }</div></div>
          <div class="card m"><div class="row"><app-icon name="activity" class="mut" /><b class="grow">CPU</b><span class="mut small">{{ s.cpus }} {{ s.cpus === 1 ? 'núcleo' : 'núcleos' }}</span></div>
            <div class="big">{{ s.cpuUse }}<small>%</small></div>
            <div class="bar" [class.hi]="s.cpuUse > 90"><div [style.width.%]="s.cpuUse"></div></div>
            <div class="small mut">Carga {{ s.load }}</div></div>
          <div class="card m"><div class="row"><app-icon name="clock" class="mut" /><b class="grow">Tiempo activo</b></div>
            <div class="big">{{ up() }}</div>
            <div class="small mut">{{ s.bootedAt ? 'Encendido desde ' + s.bootedAt : '' }}</div></div>
        </div>

        @if (!compact() || expanded()) {
          <div class="card"><h3>Sistema y hardware</h3>
            <dl class="kv">
              <dt>Sistema</dt><dd>{{ s.os }}</dd>
              <dt>Kernel</dt><dd>{{ s.kernel }} ({{ s.arch }})</dd>
              <dt>Procesador</dt><dd>{{ s.cpuModel || '—' }}</dd>
              @if (s.product || s.vendor) { <dt>Equipo</dt><dd>{{ (s.vendor + ' ' + s.product).trim() }}</dd> }
              @if (s.virt) { <dt>Virtualización</dt><dd>{{ s.virt }}</dd> }
              <dt>Memoria total</dt><dd>{{ fmt(s.memTotal) }}</dd>
              @if (s.ips.length) { <dt>Direcciones IP</dt><dd class="mono">{{ s.ips.join(' · ') }}</dd> }
            </dl>
          </div>
          @if (s.disks.length > 1) {
            <div class="card"><h3>Discos y particiones</h3>
              @for (d of s.disks; track d.mount) {
                <div class="drow"><div class="row"><span class="mono grow ell">{{ d.mount }}</span><span class="small mut">{{ fmt(d.used) }} / {{ fmt(d.total) }}</span></div>
                  <div class="bar thin" [class.hi]="pct(d.used, d.total) > 85"><div [style.width.%]="pct(d.used, d.total)"></div></div></div>
              }
            </div>
          }
        }
        @if (compact()) { <button class="btn sec sm" style="margin:2px 0 8px" (click)="expanded.set(!expanded())">{{ expanded() ? 'Menos detalles' : 'Más detalles' }}</button> }
      } @else if (!ws.infoError() && ws.state() === 'connected') { <div class="mut pad">Leyendo información del servidor…</div> }
    }`,
  styles: [`
    :host { display:block; } .head { padding:2px 2px 10px; }
    .meters { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; margin-bottom:12px; } .meters.compact { grid-template-columns:1fr; gap:8px; }
    .m { display:flex; flex-direction:column; gap:6px; } .big { font-size:22px; font-weight:600; line-height:1.2; } .big small { font-size:13px; color:var(--mut); font-weight:400; }
    .bar > div { background:var(--acc); } .bar.hi > div { background:var(--err); } .bar.thin { height:6px; } .drow { padding:6px 0; } .card + .card { margin-top:12px; }
  `],
})
export class ServerInfoComponent {
  readonly ws = inject(WorkspaceService);
  readonly compact = input(false);
  readonly expanded = signal(false);
  readonly fmt = fmtBytes;
  readonly i = this.ws.info;
  readonly disk = computed(() => this.ws.info()?.disks[0] ?? null);
  readonly diskPct = computed(() => { const d = this.disk(); return d ? this.pct(d.used, d.total) : 0; });
  readonly memUsed = computed(() => { const s = this.ws.info(); return s ? Math.max(0, s.memTotal - s.memAvail) : 0; });
  readonly memPct = computed(() => { const s = this.ws.info(); return s ? this.pct(this.memUsed(), s.memTotal) : 0; });
  readonly up = computed(() => { const s = this.ws.info(); return s ? fmtUptime(s.uptimeSec * 1000) : '—'; });

  constructor() {
    // al elegir un servidor (o cuando termina de conectar) se carga su ficha
    effect(() => { const id = this.ws.profileId(), st = this.ws.state(); untracked(() => { if (id && st === 'connected' && !this.ws.info()) this.ws.refreshInfo(); }); });
  }
  pct(used: number, total: number) { return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0; }
}
