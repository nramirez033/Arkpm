import { Injectable, signal } from '@angular/core';
import { ServerProfile } from './models';

export interface MenuItem { id: string; label: string; icon?: string; danger?: boolean; disabled?: boolean; }

export type DialogReq =
  | { kind: 'confirm'; title: string; message: string; details?: string[]; okText: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: 'input'; title: string; label: string; value: string; placeholder: string; okText: string; multiline: boolean; resolve: (v: string | null) => void }
  | { kind: 'secret'; profile: ServerProfile; what: 'password' | 'passphrase' | 'sudo'; retry: boolean; resolve: (v: { value: string; remember: boolean } | null) => void }
  | { kind: 'menu'; title: string; items: MenuItem[]; resolve: (v: string | null) => void }
  | { kind: 'hostkey'; profile: ServerProfile; fingerprint: string; changed: boolean; resolve: (v: boolean) => void };

/** Cuadros de diálogo basados en promesas; los dibuja DialogHostComponent. */
@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly queue = signal<DialogReq[]>([]);
  private push<T extends DialogReq>(r: T) { this.queue.update((q) => [...q, r]); }
  close(r: DialogReq) { this.queue.update((q) => q.filter((x) => x !== r)); }

  /** Cierra el diálogo de arriba como «cancelar» (botón Atrás de Android, tecla Escape). Devuelve false si no había ninguno. */
  cancelTop(): boolean {
    const d = this.queue()[this.queue().length - 1];
    if (!d) return false;
    this.close(d);
    (d.resolve as (x: any) => void)(d.kind === 'confirm' || d.kind === 'hostkey' ? false : null);
    return true;
  }

  confirm(o: { title: string; message: string; details?: string[]; okText?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => this.push({ kind: 'confirm', title: o.title, message: o.message, details: o.details, okText: o.okText ?? 'Aceptar', danger: !!o.danger, resolve }));
  }
  input(o: { title: string; label: string; value?: string; placeholder?: string; okText?: string; multiline?: boolean }): Promise<string | null> {
    return new Promise((resolve) => this.push({ kind: 'input', title: o.title, label: o.label, value: o.value ?? '', placeholder: o.placeholder ?? '', okText: o.okText ?? 'Aceptar', multiline: !!o.multiline, resolve }));
  }
  menu(title: string, items: MenuItem[]): Promise<string | null> {
    return new Promise((resolve) => this.push({ kind: 'menu', title, items, resolve }));
  }
  secret(profile: ServerProfile, what: 'password' | 'passphrase' | 'sudo', retry = false) {
    return new Promise<{ value: string; remember: boolean } | null>((resolve) => this.push({ kind: 'secret', profile, what, retry, resolve }));
  }
  hostKey(profile: ServerProfile, fingerprint: string, changed: boolean) {
    return new Promise<boolean>((resolve) => this.push({ kind: 'hostkey', profile, fingerprint, changed, resolve }));
  }
}

export interface Toast { id: number; text: string; kind: 'ok' | 'err' | 'info'; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly items = signal<Toast[]>([]);
  private n = 0;
  show(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
    const t = { id: ++this.n, text, kind };
    this.items.update((l) => [...l.slice(-3), t]);
    setTimeout(() => this.items.update((l) => l.filter((x) => x.id !== t.id)), kind === 'err' ? Math.max(ms, 7000) : ms);
  }
  ok(t: string) { this.show(t, 'ok'); }
  err(e: unknown) { this.show(String((e as any)?.message ?? e), 'err'); }
}
