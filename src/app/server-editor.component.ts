import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectionService } from './connection.service';
import { ToastService } from './dialog.service';
import { errText } from './format';
import { IconComponent } from './icon.component';
import { AuthType, Secret, ServerProfile, uid } from './models';
import { StoreService } from './store.service';

/** Alta y edición de un servidor SSH. Las credenciales van al almacén seguro, nunca a la base de datos. */
@Component({
  selector: 'app-server-editor',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="backdrop"><div class="modal wide" role="dialog">
      <header><h3>{{ profile() ? 'Editar servidor' : 'Agregar servidor' }}</h3><button class="btn ghost icon sm" (click)="closed.emit()" aria-label="Cerrar"><app-icon name="close" /></button></header>
      <div class="body">
        <div class="field"><label>Nombre</label><input [(ngModel)]="name" placeholder="Producción, VPS cliente…" /></div>
        <div class="row wrapr" style="align-items:flex-start">
          <div class="field grow" style="min-width:200px"><label>Servidor (IP o dominio)</label><input [(ngModel)]="host" placeholder="203.0.113.10" autocapitalize="off" autocomplete="off" /></div>
          <div class="field" style="width:110px"><label>Puerto SSH</label><input type="number" [(ngModel)]="port" /></div>
        </div>
        <div class="field"><label>Usuario</label><input [(ngModel)]="username" placeholder="ubuntu" autocapitalize="off" autocomplete="off" /></div>
        <div class="field"><label>Autenticación</label>
          <div class="seg"><button type="button" [class.on]="auth === 'password'" (click)="auth = 'password'">Contraseña</button><button type="button" [class.on]="auth === 'key'" (click)="auth = 'key'">Clave privada</button></div></div>
        @if (auth === 'password') {
          <div class="field"><label>Contraseña</label><input type="password" [(ngModel)]="password" [placeholder]="hasSaved ? '•••••• guardada (déjalo vacío para conservarla)' : ''" autocomplete="off" /></div>
          <label class="chk"><input type="checkbox" [(ngModel)]="remember" /><span>Recordar la contraseña en este dispositivo (cifrada con el almacén del sistema)</span></label>
        } @else {
          <div class="field"><label>Clave privada (OpenSSH / PEM)</label>
            <textarea rows="5" class="mono" [(ngModel)]="privateKey" [placeholder]="hasSaved ? 'Clave guardada. Pega otra solo si quieres reemplazarla.' : '-----BEGIN OPENSSH PRIVATE KEY-----'" spellcheck="false"></textarea>
            <div class="row"><label class="btn sec sm" style="cursor:pointer"><app-icon name="file" [size]="15" />Cargar archivo…<input type="file" class="hide" (change)="loadKey($event)" /></label><span class="hint">Se guarda cifrada en este dispositivo.</span></div></div>
          <div class="field"><label>Frase de contraseña de la clave (si tiene)</label><input type="password" [(ngModel)]="passphrase" autocomplete="off" /></div>
          <label class="chk"><input type="checkbox" [(ngModel)]="remember" /><span>Recordar también la frase de contraseña</span></label>
        }
        <details style="margin-top:10px" [open]="adv">
          <summary class="mut" style="cursor:pointer;min-height:30px">Ajustes avanzados de PM2</summary>
          <div class="field" style="margin-top:8px"><label>Comando de PM2</label><input [(ngModel)]="pm2Cmd" placeholder="pm2" class="mono" />
            <div class="hint">Ej.: <code>pm2</code>, <code>sudo -u deploy pm2</code> o <code>/usr/local/bin/pm2</code>.</div></div>
          <div class="field"><label>Preparar entorno (opcional, una línea por comando)</label><textarea rows="2" class="mono" [(ngModel)]="shellInit" placeholder="source ~/.nvm/nvm.sh"></textarea>
            <div class="hint">Se ejecuta antes de cada comando. nvm ya se carga solo si está en <code>~/.nvm</code>.</div></div>
        </details>
        @if (testMsg()) { <div class="banner" [class.err]="!testOk()" [class.info]="testOk()" style="margin-top:12px"><app-icon [name]="testOk() ? 'check' : 'alert'" /><div>{{ testMsg() }}</div></div> }
      </div>
      <footer>
        <button class="btn sec" (click)="test()" [disabled]="testing() || !valid()">{{ testing() ? 'Probando…' : 'Probar conexión' }}</button>
        <span class="grow"></span>
        <button class="btn sec" (click)="closed.emit()">Cancelar</button>
        <button class="btn" (click)="save()" [disabled]="!valid()">Guardar</button>
      </footer>
    </div></div>`,
})
export class ServerEditorComponent implements OnInit {
  readonly profile = input<ServerProfile | null>(null);
  readonly closed = output<void>();
  readonly saved = output<ServerProfile>();
  private readonly store = inject(StoreService);
  private readonly conn = inject(ConnectionService);
  private readonly toast = inject(ToastService);

  name = ''; host = ''; port = 22; username = ''; auth: AuthType = 'password';
  password = ''; privateKey = ''; passphrase = ''; remember = true; pm2Cmd = 'pm2'; shellInit = '';
  adv = false; hasSaved = false;
  readonly testing = signal(false);
  readonly testMsg = signal('');
  readonly testOk = signal(false);

  async ngOnInit() {
    const p = this.profile();
    if (!p) return;
    Object.assign(this, { name: p.name, host: p.host, port: p.port, username: p.username, auth: p.auth, remember: p.remember, pm2Cmd: p.pm2Cmd, shellInit: p.shellInit });
    this.adv = p.pm2Cmd !== 'pm2' || !!p.shellInit;
    const s = await this.conn.loadSecret(p);
    this.hasSaved = !!(s.password || s.privateKey);
  }

  valid() { return !!(this.host.trim() && this.username.trim() && this.port > 0 && (this.auth === 'password' || this.privateKey.trim() || this.hasSaved)); }

  loadKey(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (f.size > 64 * 1024) { this.toast.show('Ese archivo es demasiado grande para ser una clave privada', 'err'); return; }
    f.text().then((t) => (this.privateKey = t.replace(/\r\n/g, '\n').trim() + '\n'));
  }

  private build(): ServerProfile {
    const p = this.profile();
    return {
      id: p?.id ?? uid(), name: this.name.trim() || this.host.trim(), host: this.host.trim(), port: Number(this.port) || 22,
      username: this.username.trim(), auth: this.auth, remember: this.remember, pm2Cmd: this.pm2Cmd.trim() || 'pm2', shellInit: this.shellInit.trim(), createdAt: p?.createdAt ?? Date.now(),
    };
  }

  /** Credenciales tecleadas, completadas con las guardadas para lo que se dejó en blanco. */
  private async secret(p: ServerProfile): Promise<Secret> {
    const old = await this.conn.loadSecret(p);
    return p.auth === 'password'
      ? { password: this.password || old.password }
      : { privateKey: this.privateKey.trim() ? this.privateKey : old.privateKey, passphrase: this.passphrase || old.passphrase };
  }

  async test() {
    this.testing.set(true); this.testMsg.set('');
    try {
      const p = this.build();
      const s = await this.secret(p);
      if (p.auth === 'password' && !s.password) { this.testOk.set(false); this.testMsg.set('Escribe la contraseña para probar.'); return; }
      const r = await this.conn.test(p, s);
      this.testOk.set(r.ok || !!r.needsTrust);
      this.testMsg.set(r.needsTrust ? `El servidor responde. Huella: ${r.needsTrust}\nSe te pedirá confirmarla al conectar.` : r.message);
    } catch (e) { this.testOk.set(false); this.testMsg.set(errText(e)); }
    finally { this.testing.set(false); }
  }

  async save() {
    try {
      const p = this.build();
      const s = await this.secret(p);
      const prev = this.profile();
      if (prev && (prev.host !== p.host || prev.port !== p.port)) await this.conn.disconnect(prev.id);
      await this.store.saveProfile(p);
      try {
        if (p.auth === 'password' && s.password && p.remember) await this.conn.saveSecret(p, s);
        else if (p.auth === 'key') await this.conn.saveSecret(p, s);
        else if (!p.remember) await this.conn.forgetSecret(p.id);
      } catch (e) { this.toast.show('No se pudieron guardar las credenciales de forma segura en este equipo: se te pedirán al conectar. ' + errText(e), 'info'); }
      this.saved.emit(p);
      this.closed.emit();
    } catch (e) { this.toast.err(e); }
  }
}
