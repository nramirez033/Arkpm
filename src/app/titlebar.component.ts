import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { IconComponent } from './icon.component';
import { LayoutService } from './layout.service';

/**
 * Barra superior de la ventana de escritorio. En Windows 11 los botones los pone el sistema (titleBarOverlay: con
 * «diseños de ajuste» al pasar sobre maximizar) y aquí solo queda la zona de arrastre; en otros sistemas se dibujan.
 */
@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tb" (dblclick)="!native() && toggleMax()">
      <div class="brand"><span class="logo">PM</span><b>Arkpm</b><span class="sub">Administrador de PM2</span></div>
      @if (!native()) {
        <div class="grow"></div>
        <div class="ctl" (dblclick)="$event.stopPropagation()">
          <button class="c" title="Minimizar" aria-label="Minimizar" (click)="api.winMinimize()"><app-icon name="minus" [size]="16" /></button>
          <button class="c" [title]="maximized() ? 'Restaurar' : 'Maximizar'" (click)="toggleMax()"><app-icon [name]="maximized() ? 'restore' : 'square'" [size]="14" /></button>
          <button class="c x" title="Cerrar" aria-label="Cerrar" (click)="api.winClose()"><app-icon name="close" [size]="16" /></button>
        </div>
      }
    </div>`,
  styles: [`
    :host { display: block; flex: none; z-index: 50; }
    .tb { display: flex; align-items: center; height: 38px; background: var(--card); border-bottom: 1px solid var(--line); -webkit-app-region: drag; user-select: none; padding-left: 12px; }
    .brand { display: flex; align-items: center; gap: 9px; font-size: 13px; letter-spacing: .2px; }
    .logo { display: grid; place-items: center; width: 22px; height: 20px; border-radius: 6px; background: var(--acc); color: #fff; font-weight: 800; font-size: 10px; }
    .sub { color: var(--mut); font-size: 12px; }
    .grow { flex: 1; }
    .ctl { display: flex; height: 100%; -webkit-app-region: no-drag; }
    .c { width: 46px; height: 100%; display: grid; place-items: center; background: transparent; color: var(--mut); border: 0; border-radius: 0; padding: 0; min-height: 0; cursor: pointer; }
    .c:hover { background: var(--field); color: var(--txt); }
    .c.x:hover { background: #e81123; color: #fff; }
  `],
})
export class TitlebarComponent implements OnInit, OnDestroy {
  readonly api = window.electronAPI;
  readonly maximized = signal(false);
  readonly native = signal(false);
  private off: (() => void) | null = null;
  readonly layout = inject(LayoutService);

  async ngOnInit() {
    try { this.native.set((await this.api.platform()) === 'win32'); this.maximized.set(await this.api.winIsMax()); } catch { /* sin ventana */ }
    this.off = this.api.onWinState((s: { maximized: boolean }) => this.maximized.set(s.maximized));
  }
  ngOnDestroy() { this.off?.(); }
  async toggleMax() { this.maximized.set(await this.api.winToggleMax()); }
}
