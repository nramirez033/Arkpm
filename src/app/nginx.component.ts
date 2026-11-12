import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionService } from './connection.service';
import { DialogService, ToastService } from './dialog.service';
import { errText } from './format';
import { IconComponent } from './icon.component';
import { NginxProbe, NginxSite, NginxServer, NewSite, EMAIL_RE, buildSiteConfig, fileNameFor, validateNewSite, NGINX_DIR } from './nginx';
import { NginxService } from './nginx.service';
import { WorkspaceService } from './workspace.service';

interface Editor { site: NginxSite | null; path: string; name: string; text: string; original: string; isNew: boolean; error: string; busy: boolean; }

/** Administración de nginx del servidor: estado, dominios/sitios, edición de la configuración, alta y baja de sitios, HTTPS y logs. */
@Component({
  selector: 'app-nginx',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="wrap">
      <div class="card head">
        <div class="row wrapr">
          <app-icon name="globe" [size]="22" />
          <div class="grow" style="min-width:0"><h2>Nginx</h2>
            <div class="small mut ell">{{ p() ? (p()!.installed ? p()!.version : 'No instalado') : (loading() ? 'Consultando…' : '—') }}</div></div>
          @if (p()?.installed) { <span class="badge" [class]="'badge ' + (p()!.active === 'active' ? 'ok' : 'err')"><span class="dot" [class]="p()!.active === 'active' ? 'ok' : 'err'"></span>{{ p()!.active === 'active' ? 'Activo' : 'Detenido' }}</span> }
        </div>
        @if (p()?.installed) {
          <div class="row wrapr" style="margin-top:12px">
            @if (p()!.active !== 'active') { <button class="btn icon" (click)="ctl('start')" [disabled]="busy()" aria-label="Iniciar nginx" title="Iniciar nginx"><app-icon name="play" [size]="18" /></button> }
            @else { <button class="btn sec icon" (click)="ctl('stop')" [disabled]="busy()" aria-label="Detener nginx" title="Detener nginx"><app-icon name="stop" [size]="18" /></button> }
            <button class="btn sec icon" (click)="ctl('restart')" [disabled]="busy()" aria-label="Reiniciar nginx" title="Reiniciar (corta las conexiones un instante)"><app-icon name="restart" [size]="18" /></button>
            <button class="btn sec icon" (click)="ctl('reload')" [disabled]="busy()" aria-label="Recargar configuración" title="Recargar la configuración (sin cortar)"><app-icon name="refresh" [size]="18" /></button>
            <button class="btn sec icon" (click)="runTest()" [disabled]="busy()" aria-label="Probar configuración" title="Probar la configuración (nginx -t)"><app-icon name="check-square" [size]="18" /></button>
            <button class="btn sec icon" (click)="openLogs()" aria-label="Ver logs" title="Ver logs de nginx"><app-icon name="file-text" [size]="18" /></button>
            <span class="grow"></span>
            <button class="btn ghost icon" (click)="load()" [disabled]="loading()" aria-label="Actualizar" title="Actualizar"><app-icon name="refresh" [class.spin]="loading()" /></button>
          </div>
          <div class="small mut" style="margin-top:8px">{{ sudoText() }}</div>
          @if (busy()) { <div class="bar ind" style="margin-top:10px"><div></div></div> }
        }
      </div>

      @if (error()) { <div class="banner err"><app-icon name="alert" /><div>{{ error() }}</div></div> }
      @if (p() && !p()!.installed) {
        <div class="banner info"><app-icon name="info" /><div>nginx no está instalado en este servidor. Para instalarlo: <code>sudo apt update && sudo apt install nginx</code></div></div>
      }

      @if (p()?.installed) {
        <div class="row wrapr">
          <div class="grow search"><app-icon name="search" [size]="15" /><input [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Buscar dominio o sitio…" /></div>
          <button class="btn" (click)="newSite()" [disabled]="!canWrite()"><app-icon name="plus" [size]="17" />Nuevo sitio</button>
        </div>

        @for (s of shown(); track s.file.path) {
          <div class="card site" [class.off]="!s.file.enabled">
            <div class="row wrapr">
              <app-icon [name]="s.file.kind === 'main' ? 'gear' : 'file-text'" [size]="18" class="mut" />
              <div class="grow" style="min-width:0"><b class="ell blk">{{ s.file.kind === 'main' ? 'nginx.conf (configuración principal)' : s.name }}</b><div class="small mut ell mono">{{ s.file.path }}</div></div>
              @if (s.file.kind !== 'main') { <span class="badge" [class]="'badge ' + (s.file.enabled ? 'ok' : '')">{{ s.file.enabled ? 'Habilitado' : 'Deshabilitado' }}</span> }
              <button class="btn ghost icon sm" (click)="edit(s)" aria-label="Editar archivo" title="Editar archivo"><app-icon name="edit" /></button>
              @if (s.file.kind !== 'main') {
                <button class="btn ghost icon sm" (click)="toggle(s)" [disabled]="busy() || !canWrite()" [attr.aria-label]="s.file.enabled ? 'Deshabilitar' : 'Habilitar'" [title]="s.file.enabled ? 'Deshabilitar sitio' : 'Habilitar sitio'"><app-icon name="power" /></button>
                <button class="btn ghost icon sm" (click)="remove(s)" [disabled]="busy() || !canWrite()" aria-label="Eliminar sitio" title="Eliminar sitio"><app-icon name="trash" /></button>
              }
            </div>
            @for (sv of s.servers; track $index) {
              <div class="srv">
                <div class="chips">@for (d of sv.names; track d) { <span class="chip dom" (click)="copy(d)" title="Copiar">{{ d }}</span> }@if (!sv.names.length) { <span class="mut small">(sin server_name)</span> }</div>
                <div class="meta">
                  <span class="badge info">{{ kindText(sv) }}</span>
                  @if (sv.target) { <span class="mono small ell tg" [title]="sv.target">{{ sv.target }}</span> }
                </div>
                <div class="meta">
                  @for (pt of ports(sv); track pt) { <span class="badge">{{ pt }}</span> }
                  @if (sv.ssl) { <span class="badge" [class]="'badge ' + certClass(sv)"><app-icon name="lock" [size]="12" />HTTPS{{ certText(sv) }}</span> }
                  @if (sv.httpsRedirect) { <span class="badge">redirige a HTTPS</span> }
                  @if (!sv.ssl && sv.kind !== 'redirect' && p()!.certbot && sv.names.length && s.file.enabled && canWrite()) { <button class="btn sm sec" (click)="https(s, sv)" title="Obtener un certificado gratuito (Let's Encrypt) con certbot"><app-icon name="lock" [size]="14" />Agregar HTTPS</button> }
                </div>
              </div>
            }
            @if (!s.servers.length && s.file.kind !== 'main') { <div class="small mut" style="margin-top:6px">Este archivo no define ningún bloque <code>server</code>.</div> }
          </div>
        }
        @if (!shown().length && !loading()) { <div class="empty">{{ q() ? 'Ningún sitio coincide.' : 'No hay sitios configurados.' }}</div> }
        @if (needCertLoad()) { <button class="btn sec sm" style="align-self:flex-start" (click)="loadCerts()"><app-icon name="lock" [size]="15" />Ver vencimiento de los certificados</button> }
      }
    </div>

    @if (ed(); as e) {
      <div class="backdrop"><div class="modal wide" role="dialog">
        <header><app-icon name="edit" /><h3 class="ell">{{ e.isNew ? 'Nuevo archivo' : e.name }}</h3><button class="btn ghost icon sm" (click)="closeEditor()" aria-label="Cerrar"><app-icon name="close" /></button></header>
        <div class="body">
          <div class="small mut mono" style="margin-bottom:8px">{{ e.path }}</div>
          @if (!canWrite()) { <div class="banner" style="margin-bottom:8px"><app-icon name="alert" /><div>Este usuario no tiene sudo: puedes ver el archivo pero no guardarlo.</div></div> }
          @if (e.site?.file?.kind === 'main') { <div class="banner" style="margin-bottom:8px"><app-icon name="alert" /><div>Es la configuración principal de nginx: un error aquí afecta a todos los sitios. Si nginx la rechaza se restaura sola la versión anterior.</div></div> }
          <textarea class="mono code" rows="22" spellcheck="false" wrap="off" [ngModel]="e.text" (ngModelChange)="setText($event)" [readOnly]="!canWrite()"></textarea>
          @if (e.error) { <div class="banner err" style="margin-top:10px"><app-icon name="alert" /><div><b>nginx rechazó la configuración y se restauró la versión anterior.</b><pre>{{ e.error }}</pre></div></div> }
        </div>
        <footer>
          <button class="btn sec" (click)="closeEditor()" [disabled]="e.busy">Cancelar</button><span class="grow"></span>
          <button class="btn sec" (click)="saveEditor(false)" [disabled]="e.busy || !canWrite() || e.text === e.original">Guardar</button>
          <button class="btn" (click)="saveEditor(true)" [disabled]="e.busy || !canWrite() || e.text === e.original"><app-icon name="refresh" [size]="16" />{{ e.busy ? 'Aplicando…' : 'Guardar y recargar' }}</button>
        </footer>
      </div></div>
    }

    @if (ns(); as n) {
      <div class="backdrop"><div class="modal" role="dialog">
        <header><app-icon name="globe" /><h3>Nuevo sitio</h3><button class="btn ghost icon sm" (click)="ns.set(null)" aria-label="Cerrar"><app-icon name="close" /></button></header>
        <div class="body">
          <div class="field"><label>Dominio(s) (separados por espacio o coma)</label><input class="mono" [(ngModel)]="n.domains" placeholder="midominio.com www.midominio.com" autocapitalize="off" autocomplete="off" /></div>
          <div class="field"><label>Qué sirve</label>
            <div class="seg"><button type="button" [class.on]="n.type === 'proxy'" (click)="n.type = 'proxy'">Proxy a una app</button><button type="button" [class.on]="n.type === 'static'" (click)="n.type = 'static'">Sitio estático</button><button type="button" [class.on]="n.type === 'redirect'" (click)="n.type = 'redirect'">Redirección</button></div></div>
          <div class="field"><label>{{ n.type === 'proxy' ? 'Dirección de la app' : n.type === 'static' ? 'Carpeta del sitio en el servidor' : 'Redirigir a' }}</label>
            <input class="mono" [(ngModel)]="n.target" [placeholder]="n.type === 'proxy' ? '127.0.0.1:3000' : n.type === 'static' ? '/var/www/mi-sitio' : 'https://otro-sitio.com'" autocapitalize="off" autocomplete="off" />
            @if (n.type === 'proxy') { <div class="hint">El puerto donde escucha tu app de PM2 (por ejemplo <code>127.0.0.1:3000</code>). Incluye soporte de WebSocket.</div> }</div>
          @if (n.type === 'static') { <label class="chk"><input type="checkbox" [(ngModel)]="n.spa" /><span>Es una app de una sola página (Angular/React): enviar todo a <code>index.html</code></span></label> }
          <label class="chk"><input type="checkbox" [(ngModel)]="n.enable" /><span>Habilitar el sitio al crearlo</span></label>
          @if (p()?.certbot && n.type !== 'redirect') {
            <label class="chk"><input type="checkbox" [(ngModel)]="n.https" /><span>Obtener certificado HTTPS gratuito (Let's Encrypt)</span></label>
            @if (n.https) { <div class="field" style="margin-left:28px"><label>Correo para avisos del certificado</label><input [(ngModel)]="n.email" placeholder="tu@correo.com" autocapitalize="off" />
              <div class="hint">Los dominios ya deben apuntar (DNS) a este servidor y el puerto 80 debe estar abierto.</div></div> }
          } @else if (!p()?.certbot) { <div class="hint">Para HTTPS automático instala certbot: <code>sudo apt install certbot python3-certbot-nginx</code>.</div> }
          @if (n.error) { <div class="banner err" style="margin-top:10px"><app-icon name="alert" /><div><pre>{{ n.error }}</pre></div></div> }
        </div>
        <footer><button class="btn sec" (click)="ns.set(null)" [disabled]="n.busy">Cancelar</button><button class="btn" (click)="createSite()" [disabled]="n.busy"><app-icon name="plus" [size]="16" />{{ n.busy ? 'Creando…' : 'Crear sitio' }}</button></footer>
      </div></div>
    }

    @if (lg(); as l) {
      <div class="backdrop"><div class="modal wide" role="dialog">
        <header><app-icon name="file-text" /><h3>Logs de nginx</h3><button class="btn ghost icon sm" (click)="lg.set(null)" aria-label="Cerrar"><app-icon name="close" /></button></header>
        <div class="body">
          <div class="row wrapr" style="margin-bottom:8px"><div class="seg"><button [class.on]="l.kind === 'error'" (click)="setLog('error')">Errores</button><button [class.on]="l.kind === 'access'" (click)="setLog('access')">Accesos</button></div>
            <span class="grow"></span><button class="btn sm sec" (click)="setLog(l.kind)" [disabled]="l.busy"><app-icon name="refresh" [size]="15" />Actualizar</button></div>
          <div #logbox class="logbox" style="max-height:60vh">@for (ln of logLines(); track $index) { <div class="ln" [class.e]="lineClass(ln) === 'e'" [class.w]="lineClass(ln) === 'w'">{{ ln }}</div> }@if (!logLines().length) { <div class="mut">{{ l.busy ? 'Leyendo…' : (l.error || 'Sin líneas.') }}</div> }</div>
        </div>
      </div></div>
    }`,
  styles: [`
    :host { display:block; } .wrap { display:flex; flex-direction:column; gap:12px; max-width:960px; } h2 { font-size:17px; } .blk { display:block; }
    .search { display:flex; align-items:center; gap:6px; background:var(--field); border-radius:8px; padding-left:10px; min-width:160px; } .search input { border:0; background:transparent; }
    .site.off { opacity:.75; } .srv { margin-top:10px; padding-top:10px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:6px; }
    .chips { display:flex; flex-wrap:wrap; gap:6px; } .chip.dom { background:var(--field); border:1px solid var(--line); border-radius:999px; padding:2px 10px; font:13px "Cascadia Mono",Consolas,monospace; cursor:copy; }
    .meta { display:flex; flex-wrap:wrap; gap:6px; align-items:center; } .tg { max-width:100%; color:var(--mut); }
    .code { white-space:pre; overflow:auto; min-height:300px; tab-size:4; }
  `],
})
export class NginxComponent {
  readonly ws = inject(WorkspaceService);
  private readonly conn = inject(ConnectionService);
  private readonly svc = inject(NginxService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);

  readonly p = signal<NginxProbe | null>(null);
  readonly sites = signal<NginxSite[]>([]);
  readonly certs = signal<Map<string, Date | null>>(new Map());
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly q = signal('');
  readonly ed = signal<Editor | null>(null);
  readonly ns = signal<{ domains: string; type: 'proxy' | 'static' | 'redirect'; target: string; spa: boolean; enable: boolean; https: boolean; email: string; busy: boolean; error: string } | null>(null);
  readonly lg = signal<{ kind: 'error' | 'access'; busy: boolean; error: string } | null>(null);
  readonly logLines = signal<string[]>([]);
  private loadedFor = '';

  readonly canWrite = computed(() => { const s = this.p()?.sudo; return s === 'root' || s === 'nopasswd' || s === 'password'; });
  readonly shown = computed(() => { const f = this.q().trim().toLowerCase(); const l = this.sites(); return f ? l.filter((s) => s.name.toLowerCase().includes(f) || s.servers.some((sv) => sv.names.some((d) => d.toLowerCase().includes(f)))) : l; });
  readonly sudoText = computed(() => ({ root: 'Conectado como root: los cambios se aplican directamente.', nopasswd: 'sudo sin contraseña: los cambios se aplican directamente.', password: 'sudo pide contraseña: se te pedirá al cambiar algo (solo se recuerda mientras la app está abierta).', none: 'Este usuario no tiene sudo: puedes ver la configuración pero no cambiarla.' } as const)[this.p()?.sudo ?? 'none']);
  readonly needCertLoad = computed(() => this.sites().some((s) => s.servers.some((sv) => sv.certs.length)) && this.certs().size === 0 && this.canWrite());

  constructor() {
    effect(() => {
      const id = this.ws.profileId(), st = this.ws.state();
      untracked(() => { if (id && st === 'connected' && this.loadedFor !== id) { this.loadedFor = id; this.load(); } });
    });
  }

  async load() {
    const pid = this.ws.profileId();
    if (!pid) return;
    this.loading.set(true); this.error.set('');
    try {
      const probe = await this.svc.probe(pid);
      this.p.set(probe);
      this.sites.set(probe.installed ? await this.svc.sites(pid) : []);
      if (probe.installed && (probe.sudo === 'root' || probe.sudo === 'nopasswd' || this.svc.hasSudo(pid))) this.loadCerts();
    } catch (e) { this.error.set(errText(e)); }
    finally { this.loading.set(false); }
  }

  async loadCerts() {
    const pid = this.ws.profileId(), probe = this.p();
    if (!pid || !probe) return;
    const paths = [...new Set(this.sites().flatMap((s) => s.file.enabled ? s.servers.flatMap((sv) => sv.certs) : []))];
    try { this.certs.set(await this.svc.certs(pid, probe, paths)); } catch (e) { if (!/Cancelado/.test(errText(e))) this.toast.err(e); }
  }

  // ---- presentación
  kindText(sv: NginxServer) { return ({ proxy: 'Proxy', static: 'Sitio estático', redirect: 'Redirección', other: 'Otro' })[sv.kind]; }
  ports(sv: NginxServer) { return [...new Set(sv.listens.map((l) => String(l.port)))].map((x) => ':' + x); }
  private days(sv: NginxServer): number | null | undefined {
    const c = this.certs(); if (!sv.certs.length || !c.size) return undefined;
    const d = c.get(sv.certs[0]); return d ? Math.floor((d.getTime() - Date.now()) / 86400000) : null;
  }
  certText(sv: NginxServer) { const d = this.days(sv); return d === undefined ? '' : d === null ? ' · sin leer' : d < 0 ? ' · vencido' : ` · vence en ${d} d`; }
  certClass(sv: NginxServer) { const d = this.days(sv); return d === undefined || d === null ? '' : d < 7 ? 'err' : d < 30 ? 'warn' : 'ok'; }
  async copy(t: string) { try { await navigator.clipboard.writeText(t); this.toast.ok('Copiado: ' + t); } catch { /* sin portapapeles */ } }

  private pid() { return this.ws.profileId()!; }

  // ---- control del servicio
  async ctl(a: 'start' | 'stop' | 'restart' | 'reload') {
    const pid = this.pid(), probe = this.p()!;
    if (a !== 'start' && a !== 'reload' && !(await this.dialogs.confirm({ title: a === 'stop' ? 'Detener nginx' : 'Reiniciar nginx', danger: true, okText: a === 'stop' ? 'Detener' : 'Reiniciar', message: a === 'stop' ? 'Todos los sitios servidos por este nginx dejarán de responder hasta que lo inicies de nuevo.' : 'nginx se reiniciará y cortará las conexiones activas durante un instante. Si la configuración tiene un error puede no volver a levantar.' }))) return;
    this.busy.set(true);
    try {
      if (a === 'reload' || a === 'restart') { const t = await this.svc.test(pid, probe); if (!t.ok) { this.toast.show('La configuración tiene errores y no se aplicó:\n' + t.output.slice(0, 300), 'err'); return; } }
      const r = await this.svc.ctl(pid, probe, a);
      this.toast.show(({ start: 'nginx iniciado', stop: 'nginx detenido', restart: 'nginx reiniciado', reload: 'Configuración recargada' })[a], r.active === (a !== 'stop') ? 'ok' : 'err');
    } catch (e) { this.toast.err(e); } finally { this.busy.set(false); await this.load(); }
  }

  async runTest() {
    this.busy.set(true);
    try { const r = await this.svc.test(this.pid(), this.p()!); this.toast.show(r.ok ? 'La configuración es válida.' : 'Hay errores en la configuración:\n' + r.output.slice(0, 400), r.ok ? 'ok' : 'err'); }
    catch (e) { this.toast.err(e); } finally { this.busy.set(false); }
  }

  // ---- editar un archivo existente
  async edit(s: NginxSite) { this.ed.set({ site: s, path: s.file.path, name: s.name, text: s.file.content, original: s.file.content, isNew: false, error: '', busy: false }); }
  setText(t: string) { this.ed.update((e) => (e ? { ...e, text: t, error: '' } : e)); }
  closeEditor() { const e = this.ed(); if (e && !e.busy) this.ed.set(null); }

  async saveEditor(reload: boolean) {
    const e = this.ed(); if (!e) return;
    this.ed.set({ ...e, busy: true, error: '' });
    try {
      const r = await this.svc.save(this.pid(), this.p()!, e.path, e.text, { reload });
      if (!r.ok) { this.ed.set({ ...e, busy: false, error: r.output || 'nginx -t falló' }); return; }
      this.toast.ok(reload ? 'Guardado y recargado' : 'Guardado (aún sin recargar nginx)');
      this.ed.set(null); await this.load();
    } catch (err) { this.ed.set({ ...e, busy: false, error: errText(err) }); }
  }

  // ---- habilitar / deshabilitar / eliminar
  async toggle(s: NginxSite) {
    const enable = !s.file.enabled;
    if (!enable && !(await this.dialogs.confirm({ title: 'Deshabilitar sitio', okText: 'Deshabilitar', danger: true, message: `«${s.name}» dejará de servirse (su archivo se conserva). Dominios: ${s.servers.flatMap((v) => v.names).join(', ') || '—'}` }))) return;
    this.busy.set(true);
    try {
      const r = await this.svc.toggle(this.pid(), this.p()!, s.file.kind, s.file.path, enable);
      this.toast.show(r.ok ? (enable ? 'Sitio habilitado' : 'Sitio deshabilitado') : 'nginx rechazó el cambio y se deshizo:\n' + r.output.slice(0, 300), r.ok ? 'ok' : 'err');
    } catch (e) { this.toast.err(e); } finally { this.busy.set(false); await this.load(); }
  }

  async remove(s: NginxSite) {
    if (!(await this.dialogs.confirm({ title: 'Eliminar sitio', danger: true, okText: 'Eliminar', message: `Se eliminará la configuración «${s.name}» (${s.file.path}) y nginx se recargará. Antes se guarda una copia en ${NGINX_DIR}/arkpm-backups.`, details: s.servers.flatMap((v) => v.names) }))) return;
    this.busy.set(true);
    try {
      const r = await this.svc.remove(this.pid(), this.p()!, s.file.kind, s.file.path);
      this.toast.show(r.ok ? 'Sitio eliminado' : 'No se pudo eliminar (se restauró):\n' + r.output.slice(0, 300), r.ok ? 'ok' : 'err');
    } catch (e) { this.toast.err(e); } finally { this.busy.set(false); await this.load(); }
  }

  // ---- sitio nuevo
  newSite() { this.ns.set({ domains: '', type: 'proxy', target: '', spa: false, enable: true, https: false, email: '', busy: false, error: '' }); }

  async createSite() {
    const n = this.ns(), probe = this.p(); if (!n || !probe) return;
    const names = n.domains.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const spec: NewSite = { names, type: n.type, target: n.target, spa: n.spa, ipv6: probe.ipv6 };
    const bad = validateNewSite(spec) ?? (n.https && !EMAIL_RE.test(n.email) ? 'Indica un correo válido para el certificado.' : null);
    if (bad) { this.ns.set({ ...n, error: bad }); return; }
    const file = fileNameFor(names), debian = probe.layout === 'debian';
    if (this.sites().some((s) => s.name === file)) { this.ns.set({ ...n, error: `Ya existe un archivo «${file}». Edítalo o elige otro dominio principal.` }); return; }
    this.ns.set({ ...n, busy: true, error: '' });
    try {
      const dest = debian ? `${NGINX_DIR}/sites-available/${file}` : `${NGINX_DIR}/conf.d/${file}.conf`;
      const r = await this.svc.save(this.pid(), probe, dest, buildSiteConfig(spec), { link: debian && n.enable ? `${NGINX_DIR}/sites-enabled/${file}` : undefined, reload: n.enable });
      if (!r.ok) { this.ns.set({ ...n, busy: false, error: 'nginx rechazó la configuración (no se creó nada):\n' + r.output }); return; }
      if (n.https && p0(probe)) {
        const c = await this.svc.certbot(this.pid(), probe, names.filter((x) => x !== '_'), n.email);
        this.toast.show(c.ok ? 'Sitio creado y certificado HTTPS emitido' : 'Sitio creado, pero certbot falló:\n' + c.output.slice(-300), c.ok ? 'ok' : 'err');
      } else this.toast.ok('Sitio creado' + (n.enable ? ' y habilitado' : ' (deshabilitado)'));
      this.ns.set(null); await this.load();
    } catch (e) { this.ns.set({ ...n, busy: false, error: errText(e) }); }
  }

  async https(s: NginxSite, sv: NginxServer) {
    const mail = (await this.dialogs.input({ title: 'Certificado HTTPS (Let\'s Encrypt)', label: `Correo para avisos de ${sv.names.join(', ')}`, placeholder: 'tu@correo.com', okText: 'Obtener certificado' }))?.trim();
    if (!mail) return;
    const names = sv.names.filter((x) => x !== '_' && !x.startsWith('*'));
    this.busy.set(true);
    try {
      const c = await this.svc.certbot(this.pid(), this.p()!, names, mail);
      this.toast.show(c.ok ? `Certificado emitido para ${names.join(', ')}` : 'certbot falló:\n' + c.output.slice(-350), c.ok ? 'ok' : 'err');
    } catch (e) { this.toast.err(e); } finally { this.busy.set(false); await this.load(); }
  }

  // ---- logs
  lineClass(ln: string) { return /\[(error|crit|emerg|alert)\]/.test(ln) ? 'e' : /\[warn\]/.test(ln) ? 'w' : ''; }
  async openLogs() { this.lg.set({ kind: 'error', busy: false, error: '' }); await this.setLog('error'); }
  async setLog(kind: 'error' | 'access') {
    this.lg.set({ kind, busy: true, error: '' }); this.logLines.set([]);
    try { const t = await this.svc.logs(this.pid(), this.p()!, kind, 300); this.logLines.set(t.split('\n').filter(Boolean)); this.lg.set({ kind, busy: false, error: '' }); }
    catch (e) { this.lg.set({ kind, busy: false, error: errText(e) }); }
  }
}

const p0 = (probe: NginxProbe) => probe.certbot;
