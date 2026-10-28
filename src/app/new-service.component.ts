import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionService } from './connection.service';
import { ToastService } from './dialog.service';
import { errText } from './format';
import { IconComponent } from './icon.component';
import { Pm2Service } from './pm2.service';
import { Pm2NewSpec, joinPath, parentPath, sq, validateNewSpec } from './remote';
import { WorkspaceService } from './workspace.service';

/** Formulario para registrar y arrancar un servicio NUEVO en PM2 (equivale a «pm2 start … --name …»). */
@Component({
  selector: 'app-new-service',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="field"><label>Nombre del servicio</label><input [(ngModel)]="name" placeholder="mi-api" autocapitalize="off" autocomplete="off" /></div>
    <div class="field"><label>Qué se ejecuta</label>
      <div class="seg"><button type="button" [class.on]="kind === 'node'" (click)="kind = 'node'">Script Node.js</button><button type="button" [class.on]="kind === 'npm'" (click)="kind = 'npm'">Script de npm</button><button type="button" [class.on]="kind === 'command'" (click)="kind = 'command'">Comando</button></div></div>
    <div class="field"><label>{{ kind === 'npm' ? 'Script de package.json' : kind === 'node' ? 'Archivo a ejecutar (relativo a la carpeta)' : 'Ejecutable (relativo a la carpeta o ruta absoluta)' }}</label>
      <input class="mono" [(ngModel)]="script" [placeholder]="kind === 'npm' ? 'start' : kind === 'node' ? 'server.js' : './run.sh'" autocapitalize="off" autocomplete="off" />
      @if (kind === 'npm') { <div class="hint">Equivale a <code>npm run {{ script || 'start' }}</code>.</div> }</div>
    <div class="field"><label>Carpeta de trabajo en el servidor</label>
      <div class="row"><input class="mono" [(ngModel)]="cwd" placeholder="/home/usuario/mi-api" autocapitalize="off" autocomplete="off" /><button class="btn sec" type="button" (click)="browse()"><app-icon name="folder" [size]="16" />Examinar</button></div></div>
    <div class="field"><label>Argumentos (opcional)</label><input class="mono" [(ngModel)]="args" placeholder="--port 3000" autocapitalize="off" /></div>
    <details [open]="adv"><summary class="mut" style="cursor:pointer;min-height:30px">Opciones avanzadas</summary>
      <div style="margin-top:8px">
        @if (kind === 'node') {
          <div class="row wrapr" style="align-items:flex-start">
            <div class="field grow" style="min-width:150px"><label>Instancias</label><input [(ngModel)]="instances" placeholder="1 (fork) · 4 · max (cluster)" /></div>
            <div class="field grow" style="min-width:150px"><label>Intérprete (opcional)</label><input [(ngModel)]="interpreter" placeholder="node · python3 · bash" autocapitalize="off" /></div></div>
        }
        <div class="field"><label>Reiniciar si supera esta memoria (opcional)</label><input [(ngModel)]="maxMemory" placeholder="300M · 1G" /></div>
        <div class="field"><label>Variables de entorno (una por línea: CLAVE=valor)</label><textarea rows="3" class="mono" [(ngModel)]="envText" placeholder="NODE_ENV=production&#10;PORT=3000" spellcheck="false"></textarea></div>
        <label class="chk"><input type="checkbox" [(ngModel)]="autorestart" /><span>Reiniciar automáticamente si se cae</span></label>
      </div></details>
    <label class="chk" style="margin-top:8px"><input type="checkbox" [(ngModel)]="save" /><span>Guardar la lista de PM2 (<code>pm2 save</code>) para que el servicio vuelva al reiniciar el servidor</span></label>
    @if (error()) { <div class="banner err" style="margin-top:10px"><app-icon name="alert" /><div><pre>{{ error() }}</pre></div></div> }
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn sec" (click)="closed.emit()" [disabled]="busy()">Cancelar</button><button class="btn" (click)="create()" [disabled]="busy()"><app-icon name="play" [size]="16" />{{ busy() ? 'Creando…' : 'Crear e iniciar' }}</button></div>

    @if (picker(); as pk) {
      <div class="backdrop" (mousedown)="$event.target === $event.currentTarget && picker.set(null)" style="z-index:110"><div class="modal" role="dialog">
        <header><h3>Elegir carpeta</h3><button class="btn ghost icon sm" (click)="picker.set(null)" aria-label="Cerrar"><app-icon name="close" /></button></header>
        <div class="body">
          <div class="mono small ell" style="margin-bottom:8px">{{ pk.path }}</div>
          <div class="list">
            @if (pk.path !== '/') { <div class="item" (click)="go(parentPath(pk.path))"><app-icon name="arrow-up" /><span class="t">..</span></div> }
            @for (d of pk.dirs; track d) { <div class="item" (click)="go(join(pk.path, d))"><app-icon name="folder" style="color:var(--warn)" /><span class="t grow">{{ d }}</span></div> }
            @if (!pk.dirs.length) { <div class="mut small" style="padding:10px">No hay subcarpetas.</div> }
          </div>
        </div>
        <footer><button class="btn sec" (click)="picker.set(null)">Cancelar</button><button class="btn" (click)="cwd = pk.path; picker.set(null)">Usar esta carpeta</button></footer>
      </div></div>
    }`,
})
export class NewServiceComponent {
  private readonly ws = inject(WorkspaceService);
  private readonly conn = inject(ConnectionService);
  private readonly pm2 = inject(Pm2Service);
  private readonly toast = inject(ToastService);
  readonly closed = output<void>();
  readonly created = output<string>();

  name = ''; kind: 'node' | 'npm' | 'command' = 'node'; script = ''; cwd = ''; args = '';
  instances = ''; interpreter = ''; maxMemory = ''; envText = ''; autorestart = true; save = true; adv = false;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly picker = signal<{ path: string; dirs: string[] } | null>(null);
  readonly parentPath = parentPath; readonly join = joinPath;

  constructor() { this.cwd = (this.conn.home(this.ws.profileId() ?? '') || '/').replace(/\/+$/, '') + '/'; }

  async browse() {
    const start = this.cwd.trim().startsWith('/') ? this.cwd.trim().replace(/\/+$/, '') || '/' : this.conn.home(this.ws.profileId()!) || '/';
    await this.go(start);
  }
  async go(path: string) {
    try {
      const l = await this.conn.list(this.ws.profileId()!, path);
      this.picker.set({ path, dirs: l.filter((e) => e.isDir).map((e) => e.name).sort((a, b) => a.localeCompare(b)) });
    } catch (e) { this.toast.err(e); }
  }

  private spec(): Pm2NewSpec {
    const env = this.envText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return i < 0 ? { key: l, value: '' } : { key: l.slice(0, i).trim(), value: l.slice(i + 1) }; });
    return { name: this.name.trim(), kind: this.kind, script: this.script.trim(), cwd: this.cwd.trim().replace(/(.)\/+$/, '$1'), args: this.args, interpreter: this.interpreter, instances: this.kind === 'node' ? this.instances : '', maxMemory: this.maxMemory, env, autorestart: this.autorestart };
  }

  async create() {
    this.error.set('');
    const spec = this.spec(), pid = this.ws.profileId()!;
    const bad = validateNewSpec(spec);
    if (bad) { this.error.set(bad); return; }
    if (this.ws.groups().some((g) => g.name === spec.name)) { this.error.set(`Ya existe un servicio llamado «${spec.name}» en PM2. Elige otro nombre.`); return; }
    this.busy.set(true);
    try {
      const dir = await this.conn.stat(pid, spec.cwd);
      if (!dir.exists || !dir.isDir) throw new Error(`La carpeta ${spec.cwd} no existe en el servidor.`);
      if (spec.kind !== 'npm') {
        const f = spec.script.startsWith('/') ? spec.script : joinPath(spec.cwd, spec.script.replace(/^\.\//, ''));
        const st = await this.conn.stat(pid, f);
        if (!st.exists) throw new Error(`No existe ${f} en el servidor. Sube los archivos primero (pestaña Archivos) o corrige la ruta.`);
      } else {
        const st = await this.conn.stat(pid, joinPath(spec.cwd, 'package.json'));
        if (!st.exists) throw new Error(`No hay package.json en ${spec.cwd}.`);
      }
      await this.pm2.create(pid, spec, this.save);
      await new Promise((r) => setTimeout(r, 1800));
      await this.ws.refresh(true);
      const g = this.ws.groups().find((x) => x.name === spec.name);
      if (!g) throw new Error('PM2 aceptó el comando pero el servicio no aparece en la lista.');
      if (g.status !== 'online') {
        const log = g.errLog ? (await this.conn.run(pid, `tail -n 12 -- ${sq(g.errLog)} 2>/dev/null`).then((r) => r.stdout.trim()).catch(() => '')) : '';
        this.toast.show(`«${spec.name}» se registró pero no quedó en línea (${g.status}). Revisa sus logs.${log ? '\n' + log.slice(-300) : ''}`, 'err');
      } else this.toast.ok(`Servicio «${spec.name}» creado y en línea`);
      this.created.emit(spec.name);
    } catch (e) { this.error.set(errText(e)); }
    finally { this.busy.set(false); }
  }
}
