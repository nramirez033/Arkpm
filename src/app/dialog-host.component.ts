import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogReq, DialogService, ToastService } from './dialog.service';
import { IconComponent } from './icon.component';

/** Dibuja los diálogos pendientes (confirmar, texto, contraseña, huella del servidor, menú) y los avisos. */
@Component({
  selector: 'app-dialog-host',
  standalone: true,
  imports: [FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    @for (d of dlg.queue(); track d) {
      <div class="backdrop" (mousedown)="backdrop($event, d)">
        <div class="modal" role="dialog" aria-modal="true">
          @switch (d.kind) {
            @case ('confirm') {
              <header><h3>{{ d.title }}</h3></header>
              <div class="body">
                <div style="white-space:pre-wrap">{{ d.message }}</div>
                @if (d.details?.length) { <ul class="mono small" style="margin:10px 0 0;padding-left:18px;max-height:180px;overflow:auto">@for (x of d.details!; track $index) { <li>{{ x }}</li> }</ul> }
              </div>
              <footer><button class="btn sec" (click)="done(d, false)">Cancelar</button><button class="btn" [class.danger]="d.danger" (click)="done(d, true)">{{ d.okText }}</button></footer>
            }
            @case ('input') {
              <header><h3>{{ d.title }}</h3></header>
              <div class="body">
                <div class="field"><label>{{ d.label }}</label>
                  @if (d.multiline) { <textarea rows="5" [(ngModel)]="text" [placeholder]="d.placeholder"></textarea> }
                  @else { <input [(ngModel)]="text" [placeholder]="d.placeholder" (keydown.enter)="done(d, text)" autofocus /> }
                </div>
              </div>
              <footer><button class="btn sec" (click)="done(d, null)">Cancelar</button><button class="btn" (click)="done(d, text)">{{ d.okText }}</button></footer>
            }
            @case ('secret') {
              <header><h3>{{ d.what === 'password' ? 'Contraseña de ' + d.profile.username + '@' + d.profile.host : 'Frase de contraseña de la clave' }}</h3></header>
              <div class="body">
                @if (d.retry) { <div class="banner err" style="margin-bottom:12px"><app-icon name="alert" /><div>{{ d.what === 'password' ? 'La contraseña no fue aceptada.' : 'La frase no abrió la clave.' }} Inténtalo de nuevo.</div></div> }
                <div class="field"><label>{{ d.what === 'password' ? 'Contraseña' : 'Frase de contraseña' }}</label>
                  <div class="row"><input [type]="show() ? 'text' : 'password'" [(ngModel)]="text" (keydown.enter)="done(d, { value: text, remember })" autocomplete="off" autofocus />
                    <button class="btn sec icon" type="button" (click)="show.set(!show())" aria-label="Mostrar u ocultar"><app-icon name="eye" /></button></div>
                </div>
                <label class="chk"><input type="checkbox" [(ngModel)]="remember" /><span>Recordar en este dispositivo (se guarda cifrada)</span></label>
              </div>
              <footer><button class="btn sec" (click)="done(d, null)">Cancelar</button><button class="btn" [disabled]="!text" (click)="done(d, { value: text, remember })">Conectar</button></footer>
            }
            @case ('hostkey') {
              <header><h3>{{ d.changed ? '¡La huella del servidor cambió!' : 'Verificar servidor' }}</h3></header>
              <div class="body">
                @if (d.changed) {
                  <div class="banner err" style="margin-bottom:12px"><app-icon name="alert" /><div>La huella de <b>{{ d.profile.host }}</b> es distinta a la que guardaste. Puede ser una reinstalación del servidor… o alguien intentando interceptar la conexión. No envíes tu contraseña si no sabes por qué cambió.</div></div>
                } @else {
                  <p style="margin-top:0">Es la primera vez que te conectas a <b>{{ d.profile.host }}</b>. Comprueba que esta huella coincide con la del servidor antes de continuar.</p>
                }
                <div class="field"><label>Huella SHA256</label><code class="mono" style="display:block;padding:8px;word-break:break-all;user-select:all">{{ d.fingerprint }}</code></div>
                <div class="hint">En el servidor: <code>for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done</code></div>
              </div>
              <footer><button class="btn sec" (click)="done(d, false)">Cancelar</button><button class="btn" [class.danger]="d.changed" (click)="done(d, true)">{{ d.changed ? 'Confiar en la nueva huella' : 'Confiar y conectar' }}</button></footer>
            }
            @case ('menu') {
              <header><h3>{{ d.title }}</h3><button class="btn ghost icon sm" (click)="done(d, null)" aria-label="Cerrar"><app-icon name="close" /></button></header>
              <div class="body" style="padding:8px"><div class="list">
                @for (m of d.items; track m.id) {
                  <button class="item" style="border:0;background:none;color:inherit;text-align:left;width:100%" [class.err]="m.danger" [disabled]="m.disabled" (click)="done(d, m.id)">
                    @if (m.icon) { <app-icon [name]="m.icon" [size]="20" /> }<span class="t grow">{{ m.label }}</span>
                  </button>
                }
              </div></div>
            }
          }
        </div>
      </div>
    }
    <div class="toasts">@for (t of toast.items(); track t.id) { <div class="toast" [class]="'toast ' + t.kind">{{ t.text }}</div> }</div>`,
})
export class DialogHostComponent {
  readonly dlg = inject(DialogService);
  readonly toast = inject(ToastService);
  readonly show = signal(false);
  text = '';
  remember = false;
  private last: DialogReq | null = null;

  constructor() {
    // al aparecer un diálogo nuevo se inicializan sus campos
    setInterval(() => {
      const d = this.dlg.queue()[0] ?? null;
      if (d !== this.last) {
        this.last = d;
        this.text = d?.kind === 'input' ? d.value : '';
        this.remember = false;
        this.show.set(false);
      }
    }, 50);
  }
  backdrop(e: MouseEvent, d: DialogReq) { if (e.target === e.currentTarget && (d.kind === 'menu' || d.kind === 'confirm')) this.done(d, d.kind === 'menu' ? null : false); }
  done(d: DialogReq, v: any) { this.dlg.close(d); (d.resolve as (x: any) => void)(v); }
}
