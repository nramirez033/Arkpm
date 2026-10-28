// Reglas de exclusión (misma sintaxis que src/app/exclude.ts): /ruta anclada, nombre en cualquier nivel, * ** ?
'use strict';

function normalizeRule(rule) {
  let r = String(rule).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (r.length > 1) r = r.replace(/\/+$/, '');
  return r === '/' ? '' : r;
}

function toRegex(rule) {
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

function compileRules(list) {
  const rules = [];
  for (const x of list || []) { const r = normalizeRule(x); if (r && !rules.includes(r)) rules.push(r); }
  const res = rules.map((r) => toRegex(r));
  return { empty: res.length === 0, test: (p) => res.some((re) => re.test(p)) };
}

module.exports = { compileRules, normalizeRule };
