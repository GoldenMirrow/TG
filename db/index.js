/**
 * db/index.js — Capa de persistencia multi-DB (SQLite nativo Node 22.5+)
 *
 * Tres bases de datos:
 *   - mangas.db  → archivos category=libros
 *   - videos.db  → archivos category=videos (con duration, kind, series…)
 *   - otros.db   → el resto
 *
 * Las tres comparten schema; los campos de video quedan NULL en mangas/otros.
 * Incluye has_thumb para cachear thumbnails descargados de Telegram.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_VERSION = 2;
const DBS_LIST = ['mangas', 'videos', 'otros'];

const DBS = {};    // { mangas: DatabaseSync, ... }
const STMTS = {};  // { mangas: { insert, getFile, ... }, ... }

// ────────────────────────────────────────────────────────────
// ROUTING
// ────────────────────────────────────────────────────────────
function route(row) {
  if (row.category === 'videos') return 'videos';
  if (row.category === 'libros') return 'mangas';
  return 'otros';
}

// ────────────────────────────────────────────────────────────
// INIT
// ────────────────────────────────────────────────────────────
function openDb(name) {
  if (DBS[name]) return DBS[name];
  if (!DBS_LIST.includes(name)) throw new Error(`DB desconocida: ${name}`);

  fs.mkdirSync(DB_DIR, { recursive: true });
  const p = path.join(DB_DIR, `${name}.db`);

  const db = new DatabaseSync(p, {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);
  DBS[name] = db;
  STMTS[name] = prepareStatements(db);
  return db;
}

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  db.exec('BEGIN');
  try {
    // ── v1: schema base
    if (current < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id         TEXT NOT NULL,
          access_hash     TEXT,
          chat_title      TEXT,
          chat_username   TEXT,
          message_id      INTEGER NOT NULL,
          file_name       TEXT NOT NULL,
          file_size       INTEGER DEFAULT 0,
          mime_type       TEXT,
          category        TEXT DEFAULT 'otros',
          extension       TEXT,
          series_name     TEXT,
          series_display  TEXT,
          volume          INTEGER,
          duration        INTEGER,
          kind            TEXT,
          season          INTEGER,
          episode         INTEGER,
          indexed_at      INTEGER DEFAULT (strftime('%s','now')),
          downloaded_path TEXT,
          downloaded_at   INTEGER,
          UNIQUE(chat_id, message_id)
        );

        CREATE INDEX IF NOT EXISTS idx_files_name      ON files(file_name);
        CREATE INDEX IF NOT EXISTS idx_files_category  ON files(category);
        CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
        CREATE INDEX IF NOT EXISTS idx_files_size      ON files(file_size);
        CREATE INDEX IF NOT EXISTS idx_files_chat      ON files(chat_id);
        CREATE INDEX IF NOT EXISTS idx_files_series    ON files(series_name);
        CREATE INDEX IF NOT EXISTS idx_files_kind      ON files(kind);
      `);
    }

    // ── v2: has_thumb (idempotente: ALTER solo si no existe)
    if (current < 2) {
      try {
        db.exec('ALTER TABLE files ADD COLUMN has_thumb INTEGER DEFAULT 0');
      } catch (e) {
        // Columna ya existe (BD nueva con schema v1 que la incluía o ALTER previo)
        if (!/duplicate column/i.test(e.message)) throw e;
      }
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_files_thumb ON files(has_thumb)');
      } catch {}
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function prepareStatements(db) {
  return {
    insert: db.prepare(`
      INSERT OR IGNORE INTO files
        (chat_id, access_hash, chat_title, chat_username, message_id,
         file_name, file_size, mime_type, category, extension,
         series_name, series_display, volume, duration, kind, season, episode)
      VALUES
        (:chat_id, :access_hash, :chat_title, :chat_username, :message_id,
         :file_name, :file_size, :mime_type, :category, :extension,
         :series_name, :series_display, :volume, :duration, :kind, :season, :episode)
    `),
    getFile: db.prepare('SELECT * FROM files WHERE id = ?'),
    markDownloaded: db.prepare(`
      UPDATE files SET downloaded_path = ?, downloaded_at = strftime('%s','now')
       WHERE id = ?
    `),
    stats: db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS total_size,
             COUNT(DISTINCT chat_id) AS channels FROM files
    `),
    statsByCategory: db.prepare(`
      SELECT category, COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS total_size
      FROM files GROUP BY category ORDER BY count DESC
    `),
    statsByKind: db.prepare(`
      SELECT kind, COUNT(*) AS count FROM files
      WHERE kind IS NOT NULL GROUP BY kind ORDER BY count DESC
    `),
    topChannels: db.prepare(`
      SELECT chat_title, chat_username, chat_id, COUNT(*) AS count,
             COALESCE(SUM(file_size), 0) AS total_size
      FROM files GROUP BY chat_id ORDER BY count DESC LIMIT ?
    `),
    listChannels: db.prepare(`
      SELECT f.chat_id, f.chat_title, f.chat_username, COUNT(*) AS count,
             COALESCE(SUM(f.file_size), 0) AS total_size
      FROM files f GROUP BY f.chat_id ORDER BY count DESC
    `),
    listSeries: db.prepare(`
      SELECT series_name, series_display, kind, COUNT(*) AS count,
             COALESCE(SUM(file_size), 0) AS total_size
      FROM files WHERE series_name IS NOT NULL
      GROUP BY series_name, kind ORDER BY count DESC
    `),
  };
}

function getDb(name) { return openDb(name); }
function getStmts(name) { openDb(name); return STMTS[name]; }

// ────────────────────────────────────────────────────────────
// LIFECYCLE
// ────────────────────────────────────────────────────────────
function initAll() { for (const n of DBS_LIST) openDb(n); }

function closeAll() {
  for (const n of DBS_LIST) {
    if (DBS[n]) {
      try { DBS[n].close(); } catch {}
      DBS[n] = null;
      STMTS[n] = null;
    }
  }
}

function vacuumAll() {
  for (const name of DBS_LIST) {
    try { getDb(name).exec('VACUUM'); } catch {}
  }
}

// ────────────────────────────────────────────────────────────
// INSERT / GET / UPDATE
// ────────────────────────────────────────────────────────────
function insertFile(row) {
  const target = route(row);
  const stmts = getStmts(target);
  const res = stmts.insert.run({
    chat_id:        String(row.chat_id),
    access_hash:    row.access_hash != null ? String(row.access_hash) : null,
    chat_title:     row.chat_title != null ? String(row.chat_title) : null,
    chat_username:  row.chat_username != null ? String(row.chat_username) : null,
    message_id:     Number(row.message_id),
    file_name:      String(row.file_name),
    file_size:      Number(row.file_size) || 0,
    mime_type:      row.mime_type != null ? String(row.mime_type) : null,
    category:       String(row.category || 'otros'),
    extension:      row.extension != null ? String(row.extension) : null,
    series_name:    row.series_name != null ? String(row.series_name) : null,
    series_display: row.series_display != null ? String(row.series_display) : null,
    volume:         row.volume != null ? Number(row.volume) : null,
    duration:       row.duration != null ? Number(row.duration) : null,
    kind:           row.kind != null ? String(row.kind) : null,
    season:         row.season != null ? Number(row.season) : null,
    episode:        row.episode != null ? Number(row.episode) : null,
  });
  if (res.changes <= 0) return { db: target, inserted: false, id: null };
  const lastId = getDb(target).prepare('SELECT last_insert_rowid() AS id').get();
  return { db: target, inserted: true, id: lastId.id };
}

function getFile(dbName, id) {
  return getStmts(dbName).getFile.get(id);
}

function findFile(id) {
  for (const name of DBS_LIST) {
    const row = getStmts(name).getFile.get(id);
    if (row) return { db: name, row };
  }
  return null;
}

function markDownloaded(dbName, id, filePath) {
  return getStmts(dbName).markDownloaded.run(filePath, id);
}

/**
 * Actualiza columnas específicas de un archivo.
 * node:sqlite NO acepta `undefined` en bind params — se normaliza a null.
 */
function updateFile(dbName, id, patch) {
  const ALLOWED = [
    'file_name', 'series_name', 'series_display',
    'kind', 'season', 'episode', 'volume', 'duration',
    'has_thumb',
  ];

  const sets = [];
  const params = [];

  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED.includes(k)) continue;
    let val = v === undefined ? null : v;
    if (typeof val === 'number' && !Number.isFinite(val)) val = null;
    sets.push(`${k} = ?`);
    params.push(val);
  }

  if (!sets.length) return { changes: 0 };

  params.push(id);
  const sql = `UPDATE files SET ${sets.join(', ')} WHERE id = ?`;

  if (process.env.DEBUG_DB) {
    console.log(`   [DBG] ${dbName}: ${sql}`);
    console.log(`   [DBG] params:`, params);
  }

  try {
    return getDb(dbName).prepare(sql).run(...params);
  } catch (e) {
    console.error(`   ❌ updateFile (${dbName}#${id}): ${e.message}`);
    console.error(`   SQL: ${sql}`);
    console.error(`   Params:`, params);
    throw e;
  }
}

// ────────────────────────────────────────────────────────────
// SEARCH
// ────────────────────────────────────────────────────────────
function searchFiles(dbName, opts = {}) {
  const db = getDb(dbName);
  const where = [];
  const params = [];

  if (opts.query && opts.query.trim()) {
    for (const t of opts.query.trim().split(/\s+/)) {
      where.push('file_name LIKE ?');
      params.push(`%${t}%`);
    }
  }
  if (opts.category)  { where.push('category = ?');  params.push(opts.category); }
  if (opts.extension) { where.push('extension = ?'); params.push(opts.extension.replace(/^\./, '').toLowerCase()); }
  if (opts.chat) {
    const chat = String(opts.chat).replace(/^@/, '');
    where.push('(chat_username = ? OR chat_title = ? OR chat_id = ?)');
    params.push(chat, opts.chat, chat);
  }
  if (opts.series) { where.push('series_name LIKE ?'); params.push(`%${opts.series}%`); }
  if (opts.kind)   { where.push('kind = ?');           params.push(opts.kind); }
  if (opts.minSize > 0) { where.push('file_size >= ?'); params.push(Math.floor(opts.minSize * 1024 * 1024)); }
  if (opts.maxSize > 0) { where.push('file_size <= ?'); params.push(Math.floor(opts.maxSize * 1024 * 1024)); }

  // Ordenamiento configurable
  let orderBy;
  switch (opts.sort) {
    case 'size_desc': orderBy = 'file_size DESC, id ASC'; break;
    case 'size_asc':  orderBy = 'file_size ASC, id ASC'; break;
    case 'date_desc': orderBy = 'indexed_at DESC, id DESC'; break;
    case 'date_asc':  orderBy = 'indexed_at ASC, id ASC'; break;
    case 'name_asc':  orderBy = 'file_name ASC'; break;
    case 'name_desc': orderBy = 'file_name DESC'; break;
    default:
      orderBy = 'CASE WHEN downloaded_path IS NULL THEN 0 ELSE 1 END, file_size DESC, id ASC';
  }

  const sql = `
    SELECT * FROM files
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  params.push(parseInt(opts.limit) || 20, parseInt(opts.offset) || 0);
  return db.prepare(sql).all(...params);
}

function searchAll(opts = {}) {
  const out = [];
  for (const name of DBS_LIST) {
    const rows = searchFiles(name, { ...opts, offset: 0 });
    for (const r of rows) out.push({ _db: name, ...r });
  }
  return out.slice(0, opts.limit || 20);
}

// ────────────────────────────────────────────────────────────
// STATS
// ────────────────────────────────────────────────────────────
function getStats(dbName)          { return getStmts(dbName).stats.get(); }
function getStatsByCategory(dbName){ return getStmts(dbName).statsByCategory.all(); }
function getStatsByKind(dbName)    { return getStmts(dbName).statsByKind.all(); }
function getTopChannels(dbName, n = 10) { return getStmts(dbName).topChannels.all(n); }
function listChannels(dbName)      { return getStmts(dbName).listChannels.all(); }
function listSeries(dbName)        { return getStmts(dbName).listSeries.all(); }

function listSeriesNames() {
  return getDb('videos').prepare(`
    SELECT series_name, series_display
      FROM files WHERE series_name IS NOT NULL
     GROUP BY series_name
  `).all();
}

// ────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────
module.exports = {
  // lifecycle
  initAll, closeAll, vacuumAll,
  // writes
  insertFile, markDownloaded, updateFile,
  // reads
  getFile, findFile,
  searchFiles, searchAll,
  getStats, getStatsByCategory, getStatsByKind,
  getTopChannels, listChannels, listSeries, listSeriesNames,
  // internals (por si el scanner/identifier los necesitan)
  getDb, getStmts, route,
  DB_DIR, DBS_LIST,
};
