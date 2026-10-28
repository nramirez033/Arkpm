// Reglas de exclusión de la sincronización (funciones puras, sin Angular).
//
// Sintaxis (parecida a .gitignore):
//   /carpeta/archivo.txt   ruta anclada a la raíz del directorio virtual (la usa el explorador)
//   /carpeta               excluye la carpeta y todo lo que contiene
//   node_modules           sin "/" inicial: coincide con ese nombre en cualquier nivel
//   *.tmp   ~$*   **/x     comodines: * = cualquier cosa dentro de un nombre, ** = también cruza carpetas, ? = un carácter

export interface Rules {
  /** ¿La ruta (relativa, con "/") queda fuera de la sincronización? */
  test(path: string): boolean;
  /** La primera regla que la excluye (para explicarlo al usuario). */
  which(path: string): string | undefined;
  readonly empty: boolean;
}

export function normalizeRule(rule: string): string {
  let r = rule.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (r.length > 1) r = r.replace(/\/+$/, '');
  return r === '/' ? '' : r;
}

/** Quita vacíos y duplicados; conserva el orden. */
export function cleanRules(list: readonly string[] | undefined | null): string[] {
  const out: string[] = [];
  for (const x of list ?? []) {
    const r = normalizeRule(String(x));
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

function toRegex(rule: string): RegExp {
  const anchored = rule.startsWith('/');
  const body = anchored ? rule.slice(1) : rule;
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*') {
      if (body[i + 1] === '*') { re += '.*'; i++; if (body[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}(?:/.*)?$` : `^(?:.*/)?${re}(?:/.*)?$`);
}

export function compileRules(list: readonly string[] | undefined | null): Rules {
  const rules = cleanRules(list);
  const res = rules.map((r) => [r, toRegex(r)] as const);
  return {
    empty: res.length === 0,
    test: (p) => res.some(([, re]) => re.test(p)),
    which: (p) => res.find(([, re]) => re.test(p))?.[0],
  };
}

/** Regla anclada para una ruta elegida en el explorador. */
export function ruleForPath(path: string): string {
  return '/' + path.replace(/^\/+|\/+$/g, '');
}

/** Añade las rutas como reglas y descarta las que quedan cubiertas por una carpeta ya excluida. */
export function addExcludes(rules: readonly string[], paths: readonly string[]): string[] {
  const next = cleanRules([...rules, ...paths.map(ruleForPath)]);
  const anchored = next.filter((r) => r.startsWith('/') && !/[*?]/.test(r));
  return next.filter((r) => !(r.startsWith('/') && !/[*?]/.test(r) && anchored.some((a) => a !== r && r.startsWith(a + '/'))));
}

/**
 * Vuelve a incluir las rutas: quita su regla y las de todo lo que contienen.
 * Devuelve también las que siguen excluidas por otra regla (carpeta superior o patrón).
 */
export function removeExcludes(rules: readonly string[], paths: readonly string[]): { rules: string[]; still: { path: string; rule: string }[] } {
  const drop = paths.map(ruleForPath);
  const next = cleanRules(rules).filter((r) => !drop.some((d) => r === d || r.startsWith(d + '/')));
  const t = compileRules(next);
  const still: { path: string; rule: string }[] = [];
  for (const p of paths) { const w = t.which(p); if (w) still.push({ path: p, rule: w }); }
  return { rules: next, still };
}
