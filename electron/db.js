// Capa mínima sobre SQLite para el proceso principal de Electron y para el servidor standalone.
// Motor: better-sqlite3 si carga (es lo que usa Electron tras `npm install`, ver "postinstall")
// y, si no, node:sqlite (incluido en Node >= 22.13). Ambos son síncronos y comparten esta API.
const fs = require('fs');
const path = require('path');

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let raw, engine, firstError;
  try {
    const Better = require('better-sqlite3');
    raw = new Better(file);
    engine = 'better-sqlite3';
  } catch (e) {
    firstError = e;
    try {
      const { DatabaseSync } = require('node:sqlite');
      raw = new DatabaseSync(file);
      engine = 'node:sqlite';
    } catch (e2) {
      throw new Error(
        'No hay motor SQLite disponible: instala better-sqlite3 (npm install) o usa Node >= 22.13. ' +
        `[better-sqlite3: ${firstError.message}] [node:sqlite: ${e2.message}]`
      );
    }
  }
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const plain = (row) => (row ? { ...row } : row); // node:sqlite devuelve objetos sin prototipo

  return {
    engine,
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => stmt(sql).run(...params),
    get: (sql, ...params) => plain(stmt(sql).get(...params)),
    all: (sql, ...params) => stmt(sql).all(...params).map(plain),
    /** Ejecuta fn dentro de una transacción (sin anidar). */
    tx(fn) {
      raw.exec('BEGIN');
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
    },
    close() { try { raw.close(); } catch {} },
  };
}

module.exports = { openDb };
