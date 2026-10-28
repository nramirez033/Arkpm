import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionService } from './connection.service';
import { DeployService, DeploySource, isArchiveName, sourceBytes, sourceLabel } from './deploy.service';
import { DialogService, ToastService } from './dialog.service';
import { cleanRules } from './exclude';
import { errText, fmtBytes, fmtDate } from './format';
import { IconComponent } from './icon.component';
import { Job } from './job';
import { DeployConfig } from './models';
import { WorkspaceService } from './workspace.service';

type Kind = 'archive' | 'files' | 'folder';

@Component({
  selector: 'app-deploy-tab',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="wrap">
      <div class="card">
        <h3>1 · Qué subir</h3>
        <div class="seg" style="margin-bottom:12px">
          <button [class.on]="kind() === 'archive'" (click)="setKind('archive')">Paquete ZIP / TAR.GZ</button>
          <button [class.on]="kind() === 'files'" (click)="setKind('files')">Archivos</button>
          @if (conn.canPickFolder) { <button [class.on]="kind() === 'folder'" (click)="setKind('folder')">Carpeta</button> }
        </div>
        <div class="hint" style="margin:-4px 0 10px">
          @switch (kind()) {
            @case ('archive') { Un solo .zip, .tar.gz o .tgz con la nueva versión (por ejemplo el build). Se sube y se descomprime en el servidor. }
            @case ('files') { Uno o varios archivos sueltos; se copian a la raíz de la app. }
            @case ('folder') { Se suben todos los archivos de la carpeta (menos los que ignores abajo), respetando su estructura. }
          }
        </div>
        <div class="row wrapr">
          <button class="btn" (click)="pick()" [disabled]="busy()"><app-icon [name]="kind() === 'folder' ? 'folder' : 'file'" />{{ source() ? 'Cambiar selección' : 'Elegir…' }}</button>
          @if (source(); as s) { <span class="grow ell"><b>{{ label(s) }}</b> <span class="mut">· {{ size(bytes(s)) }}{{ s.kind === 'folder' ? ' · ' + s.files.length + ' archivos' : '' }}</span></span>
            <button class="btn ghost icon sm" (click)="source.set(null)" aria-label="Quitar"><app-icon name="close" /></button> }
        </div>
        @if (kind() === 'folder') {
          <div class="field" style="margin-top:12px"><label>No subir (una regla por línea)</label>
            <textarea rows="3" class="mono" [ngModel]="text(cfg().ignoreLocal)" (change)="setList('ignoreLocal', $any($event.target).value); rewalk()" placeholder=".git&#10;node_modules"></textarea>
            <div class="hint">Ejemplos: <code>node_modules</code> (en cualquier nivel), <code>/dist/mapas</code> (ruta exacta), <code>*.log</code>.</div></div>
        }
      </div>

      <div class="card">
        <h3>2 · Cómo aplicarlo</h3>
        <div class="field"><label>Modo</label>
          <select [ngModel]="cfg().mode" (ngModelChange)="set('mode', $event)">
            <option value="sync">Reemplazar: la carpeta queda igual a lo subido (borra lo que ya no existe)</option>
            <option value="merge">Sobrescribir: solo agrega y actualiza, sin borrar nada</option></select></div>
        <div class="field"><label>Conservar en el servidor (no se pisa ni se borra)</label>
          <textarea rows="3" class="mono" [ngModel]="text(cfg().preserve)" (change)="setList('preserve', $any($event.target).value)" placeholder=".env&#10;uploads&#10;node_modules"></textarea>
          <div class="hint">Archivos propios del servidor: configuración, subidas de usuarios, bases de datos…</div></div>
        <label class="chk"><input type="checkbox" [ngModel]="cfg().backupFirst" (ngModelChange)="set('backupFirst', $event)" /><span>Hacer una copia previa en el servidor (para poder volver atrás)</span></label>
        @if (kind() === 'archive') { <label class="chk"><input type="checkbox" [ngModel]="cfg().flatten" (ngModelChange)="set('flatten', $event)" /><span>Si el paquete trae una sola carpeta, usar su contenido</span></label> }
        <div class="field" style="margin-top:10px"><label>Comandos después de copiar (opcional, uno por línea, en la carpeta de la app)</label>
          <textarea rows="3" class="mono" [ngModel]="cfg().postCommands" (change)="set('postCommands', $any($event.target).value)" placeholder="npm ci --omit=dev&#10;npx prisma migrate deploy"></textarea>
          <div class="hint">Si uno falla, el proceso se detiene y la app NO se reinicia.</div></div>
        <div class="row wrapr">
          <div class="field grow" style="margin:0;min-width:200px"><label>Luego en PM2</label>
            <select [ngModel]="cfg().after" (ngModelChange)="set('after', $event)"><option value="restart">Reiniciar la app</option><option value="reload">Recargar (cluster, sin cortar)</option><option value="none">No hacer nada</option></select></div>
          @if (cfg().after !== 'none') { <label class="chk" style="margin-top:18px"><input type="checkbox" [ngModel]="cfg().updateEnv" (ngModelChange)="set('updateEnv', $event)" /><span>Actualizar variables de entorno</span></label> }
        </div>
      </div>

      <div class="card">
        <h3>3 · Deploy</h3>
        <div class="row wrapr">
          <button class="btn" (click)="start()" [disabled]="!source() || busy() || !ws.appDir()"><app-icon name="deploy" />Deployar ahora</button>
          @if (job.running()) { <button class="btn sec" (click)="job.cancel()">Cancelar</button> }
          @if (job.error() && failedBackup()) { <button class="btn warnb" (click)="rollback()" [disabled]="busy()"><app-icon name="rollback" />Volver a la copia previa</button> }
          <span class="mut small grow">Destino: <span class="mono">{{ ws.appDir() || '—' }}</span></span>
        </div>
        @if (job.running() || job.done() || job.log().length) {
          <div style="margin-top:12px">
            <div class="row"><b class="grow">{{ job.phase() }}</b>@if (job.pct() !== null) { <span class="mut">{{ job.pct() }}%</span> }</div>
            <div class="bar" [class.ind]="job.running() && job.pct() === null" style="margin:8px 0"><div [style.width.%]="job.pct() ?? 100" [style.background]="job.error() ? 'var(--err)' : ''"></div></div>
            <div class="logbox" style="max-height:300px">@for (l of job.log(); track $index) { <div class="ln" [class.h]="l.startsWith('▶')" [class.e]="l.startsWith('✖')">{{ l }}</div> }</div>
            @if (job.done()) { <div class="banner" [class.err]="!!job.error()" [class.info]="!job.error()" style="margin-top:10px"><app-icon [name]="job.error() ? 'alert' : 'check'" /><div>{{ job.error() ? job.error() : 'Todo salió bien.' }}</div></div> }
          </div>
        }
      </div>

      @if (history().length) {
        <div class="card"><h3>Historial</h3>
          @for (d of history(); track d.id) {
            <div class="row hrow"><span class="badge" [class.ok]="d.ok" [class.err]="!d.ok">{{ d.ok ? 'OK' : 'Falló' }}</span>
              <div class="grow" style="min-width:0"><div class="ell">{{ d.source }}</div><div class="small mut ell">{{ d.summary }}</div></div><span class="small mut">{{ date(d.at) }}</span></div>
          }
        </div>
      }
    </div>`,
  styles: [`.wrap { display:flex; flex-direction:column; gap:12px; max-width:860px; } .hrow { padding:8px 0; border-bottom:1px solid var(--line); } .hrow:last-child { border:0; }`],
})
export class DeployTabComponent {
  readonly ws = inject(WorkspaceService);
  readonly conn = inject(ConnectionService);
  private readonly deploy = inject(DeployService);
  private readonly dialogs = inject(DialogService);
  private readonly toast = inject(ToastService);

  readonly kind = signal<Kind>('archive');
  readonly source = signal<DeploySource | null>(null);
  readonly job = new Job();
  readonly failedBackup = signal('');
  readonly busy = computed(() => this.job.running());
  readonly cfg = computed<DeployConfig>(() => this.ws.app()!.config.deploy);
  readonly history = computed(() => this.ws.store.deploys().filter((d) => d.appId === this.ws.appId()).slice(0, 8));
  readonly size = fmtBytes; readonly date = fmtDate; readonly label = sourceLabel; readonly bytes = sourceBytes;

  text(l: string[]) { return l.join('\n'); }
  async set<K extends keyof DeployConfig>(k: K, v: DeployConfig[K]) { await this.ws.updateConfig((c) => (c.deploy[k] = v)); }
  async setList(k: 'preserve' | 'ignoreLocal', raw: string) { await this.set(k, cleanRules(raw.split('\n'))); }

  setKind(k: Kind) { this.kind.set(k); this.source.set(null); }

  async pick() {
    try {
      if (this.kind() === 'folder') {
        const f = await this.conn.pickFolder();
        if (!f) return;
        const files = await this.conn.walkLocal(f.root, this.cfg().ignoreLocal);
        if (!files.length) { this.toast.show('La carpeta no tiene archivos (o todo está ignorado)', 'err'); return; }
        this.source.set({ kind: 'folder', root: f.root, name: f.name, files });
      } else {
        const files = await this.conn.pickFiles({ multi: this.kind() === 'files' });
        if (!files.length) return;
        if (this.kind() === 'archive') {
          if (!isArchiveName(files[0].name)) { this.toast.show('Elige un archivo .zip, .tar.gz, .tgz o .tar', 'err'); return; }
          this.source.set({ kind: 'archive', file: files[0] });
        } else this.source.set({ kind: 'files', files });
      }
    } catch (e) { this.toast.err(e); }
  }

  async rewalk() {
    const s = this.source();
    if (s?.kind !== 'folder') return;
    try { this.source.set({ ...s, files: await this.conn.walkLocal(s.root, this.cfg().ignoreLocal) }); } catch (e) { this.toast.show(errText(e), 'err'); }
  }

  async start() {
    const a = this.ws.app(), s = this.source(), dir = this.ws.appDir();
    if (!a || !s || !dir) return;
    const c = this.cfg();
    const ok = await this.dialogs.confirm({
      title: 'Confirmar deploy', okText: 'Deployar', danger: c.mode === 'sync',
      message: `Se subirá ${sourceLabel(s)} (${fmtBytes(sourceBytes(s))}) a ${dir}.\n${c.mode === 'sync' ? 'Los archivos del servidor que no estén en lo subido se borrarán (salvo los conservados).' : 'Se sobrescribirán los archivos con el mismo nombre.'}\n${c.after === 'none' ? 'La app no se reiniciará.' : 'Después se ' + (c.after === 'reload' ? 'recargará' : 'reiniciará') + ' en PM2.'}`,
      details: [c.backupFirst ? 'Copia previa en el servidor: sí' : 'Copia previa: NO', 'Conservados: ' + (c.preserve.join(', ') || 'ninguno')],
    });
    if (!ok) return;
    this.job.start(); this.failedBackup.set('');
    const r = await this.deploy.deploy(a, dir, s, c, this.job);
    if (!r.record.ok && r.backupName) this.failedBackup.set(r.backupName);
    if (r.record.ok) { this.toast.ok('Deploy completado'); this.source.set(null); }
    this.ws.refresh(true);
  }

  async rollback() {
    const a = this.ws.app(), dir = this.ws.appDir(), b = this.failedBackup();
    if (!a || !dir || !b) return;
    if (!(await this.dialogs.confirm({ title: 'Volver a la copia previa', message: `Se restaurará ${b} en ${dir}: los archivos quedarán como antes del deploy (salvo los conservados) y la app se reiniciará.`, okText: 'Restaurar', danger: true }))) return;
    await this.deploy.rollback(a, dir, b, this.job);
    if (!this.job.error()) { this.failedBackup.set(''); this.toast.ok('Restauración completada'); }
    this.ws.refresh(true);
  }
}
