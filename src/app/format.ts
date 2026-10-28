/** Tamaño legible: 1536 -> "1.5 KB". */
export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Fecha corta con hora, en el formato del sistema (como el Explorador de Windows). */
export function fmtDate(ms: number): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
}

/** «3 d 4 h», «12 min», «45 s» a partir de una duración en ms. */
export function fmtUptime(ms: number): string {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d} d ${h % 24} h`;
  if (h) return `${h} h ${m % 60} min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

/** Permisos estilo ls: 0o755 → «rwxr-xr-x». */
export function fmtPerm(mode: number): string {
  const f = (n: number) => ((n & 4) ? 'r' : '-') + ((n & 2) ? 'w' : '-') + ((n & 1) ? 'x' : '-');
  return f((mode >> 6) & 7) + f((mode >> 3) & 7) + f(mode & 7);
}

export const errText = (e: unknown): string => String((e as any)?.message ?? e);
