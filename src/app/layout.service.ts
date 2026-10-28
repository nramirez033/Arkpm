import { Injectable, computed, signal } from '@angular/core';
import { platformKind } from './transport';

export type Layout = 'phone' | 'tablet' | 'desktop';

/** Tamaño de la ventana → móvil (<720 px), tableta (720–1099) o escritorio (≥1100). */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly width = signal(window.innerWidth);
  readonly height = signal(window.innerHeight);
  readonly layout = computed<Layout>(() => (this.width() < 720 ? 'phone' : this.width() < 1100 ? 'tablet' : 'desktop'));
  readonly platform = platformKind();
  readonly isElectron = this.platform === 'electron';
  readonly touch = this.platform === 'android' || (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  constructor() {
    addEventListener('resize', () => { this.width.set(innerWidth); this.height.set(innerHeight); });
  }
}
