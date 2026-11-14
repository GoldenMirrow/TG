/**
 * db.js — Capa de persistencia (SQLite nativo de Node 22.5+)
 *
 * Usa `node:sqlite` (DatabaseSync). Misma API pública que la versión
 * con better-sqlite3 para que main.js no cambie.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'files.db');
const SCHEMA_VERSION = 1;

let db = null;
let stmts = null;

// ────────────────────────────────────────────────────────────
// INICIALIZACIÓN
// ────────────────────────────────────────────────────────────
function initDb() {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(DB_PATH, {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA foreign_keys = ON');

  migrate();
  prepareStatements();

  return db;
}

// ────────────────────────────────────────────────────────────
// MIGRACIONES
// ────────────────────────────────────────────────────────────
function migrate() {
  const row = db.prepare('PRAGMA user_version').get();
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  db.exec('BEGIN');
  try {
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
        CREATE INDEX IF NOT EXISTS idx_files_msg       ON files(chat_id, message_id);

        CREATE TABLE IF NOT EXISTS progress (
          chat_id     TEXT PRIMARY KEY,
          last_msg_id INTEGER DEFAULT 0,
          updated_at  INTEGER DEFAULT (strftime('%s','now'))
        );
      `);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ────────────────────────────────────────────────────────────
// PREPARED STATEMENTS
// ────────────────────────────────────────────────────────────
function prepareStatements() {
  stmts = {
    insertFile: db.prepare(`
      INSERT OR IGNORE INTO files
        (chat_id, access_hash, chat_title, chat_username, message_id,
         file_name, file_size, mime_type, category, extension)
      VALUES
        (:chat_id, :access_hash, :chat_title, :chat_username, :message_id,
         :file_name, :file_size, :mime_type, :category, :extension)
    `),

    getFile: db.prepare(`SELECT * FROM files WHERE id = ?`),

    markDownloaded: db.prepare(`
      UPDATE files
         SET downloaded_path = ?,
             downloaded_at   = strftime('%s','now')
       WHERE id = ?
    `),

    getProgress: db.prepare(`SELECT last_msg_id FROM progress WHERE chat_id = ?`),

    setProgress: db.prepare(`
      INSERT INTO progress (chat_id, last_msg_id, updated_at)
      VALUES (?, ?, strftime('%s','now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        last_msg_id = excluded.last_msg_id,
        updated_at  = excluded.updated_at
    `),

    resetProgressChat: db.prepare(`DELETE FROM progress WHERE chat_id = ?`),
    resetAllProgress:  db.prepare(`DELETE FROM progress`),

    stats: db.prepare(`
      SELECT
        COUNT(*)                    AS count,
        COALESCE(SUM(file_size), 0) AS total_size,
        COUNT(DISTINCT chat_id)     AS channels
      FROM files
    `),

    statsByCategory: db.prepare(`
      SELECT
        category,
        COUNT(*) AS count,
        COALESCE(SUM(file_size), 0) AS total_size
      FROM files
      GROUP BY category
      ORDER BY count DESC
    `),

    topChannels: db.prepare(`
      SELECT
        chat_title,
        chat_username,
        chat_id,
        COUNT(*) AS count,
        COALESCE(SUM(file_size), 0) AS total_size
      FROM files
      GROUP BY chat_id
      ORDER BY count DESC
      LIMIT ?
    `),

    listChannels: db.prepare(`
      SELECT
        f.chat_id,
        f.chat_title,
        f.chat_username,
        COUNT(*) AS count,
        COALESCE(SUM(f.file_size), 0) AS total_size,
        MAX(p.last_msg_id) AS last_msg_id
      FROM files f
      LEFT JOIN progress p ON p.chat_id = f.chat_id
      GROUP BY f.chat_id
      ORDER BY count DESC
    `),
  };
}

// ────────────────────────────────────────────────────────────
// FILES
// ────────────────────────────────────────────────────────────
function insertFile(obj) {
  const res = stmts.insertFile.run({
    chat_id:       String(obj.chat_id),
    access_hash:   obj.access_hash != null ? String(obj.access_hash) : null,
    chat_title:    obj.chat_title != null ? String(obj.chat_title) : null,
    chat_username: obj.chat_username != null ? String(obj.chat_username) : null,
    message_id:    Number(obj.message_id),
    file_name:     String(obj.file_name),
    file_size:     Number(obj.file_size) || 0,
    mime_type:     obj.mime_type != null ? String(obj.mime_type) : null,
    category:      String(obj.category || 'otros'),
    extension:     obj.extension != null ? String(obj.extension) : null,
  });
  return res.changes > 0;
}

function getFile(id) {
  return stmts.getFile.get(id);
}

function markDownloaded(id, filePath) {
  return stmts.markDownloaded.run(filePath, id);
}

// ────────────────────────────────────────────────────────────
// BÚSQUEDA
// ────────────────────────────────────────────────────────────
function searchFiles(opts = {}) {
  const where = [];
  const params = [];

  if (opts.query && opts.query.trim()) {
    const terms = opts.query.trim().split(/\s+/);
    for (const t of terms) {
      where.push(`file_name LIKE ?`);
      params.push(`%${t}%`);
    }
  }

  if (opts.category) {
    where.push(`category = ?`);
    params.push(opts.category);
  }

  if (opts.extension) {
    where.push(`extension = ?`);
    params.push(opts.extension.replace(/^\./, '').toLowerCase());
  }

 // Filtro por canal (username, título o chat_id)
  if (opts.chat) {
  const chat = String(opts.chat).replace(/^@/, '');
    where.push(`(chat_username = ? OR chat_title = ? OR chat_id = ?)`);
    params.push(chat, opts.chat, chat);
  }

  if (opts.minSize && opts.minSize > 0) {
    where.push(`file_size >= ?`);
    params.push(Math.floor(opts.minSize * 1024 * 1024));
  }

  if (opts.maxSize && opts.maxSize > 0) {
    where.push(`file_size <= ?`);
    params.push(Math.floor(opts.maxSize * 1024 * 1024));
  }

  const sql = `
    SELECT *
      FROM files
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY
       CASE WHEN downloaded_path IS NULL THEN 0 ELSE 1 END,
       file_size DESC,
       id ASC
     LIMIT ? OFFSET ?
  `;

  params.push(parseInt(opts.limit) || 20, parseInt(opts.offset) || 0);

  return db.prepare(sql).all(...params);
}

// ────────────────────────────────────────────────────────────
// PROGRESO
// ────────────────────────────────────────────────────────────
function getProgress(chatId) {
  const row = stmts.getProgress.get(String(chatId));
  return row ? row.last_msg_id : 0;
}

function setProgress(chatId, lastMsgId) {
  return stmts.setProgress.run(String(chatId), lastMsgId);
}

function resetProgressForChat(chatId) {
  return stmts.resetProgressChat.run(String(chatId));
}

function resetAllProgress() {
  return stmts.resetAllProgress.run();
}

// ────────────────────────────────────────────────────────────
// ESTADÍSTICAS
// ────────────────────────────────────────────────────────────
function getStats() {
  return stmts.stats.get();
}

function getStatsByCategory() {
  return stmts.statsByCategory.all();
}

function getTopChannels(n = 10) {
  return stmts.topChannels.all(n);
}

function listChannels() {
  return stmts.listChannels.all();
}

// ────────────────────────────────────────────────────────────
// MANTENIMIENTO
// ────────────────────────────────────────────────────────────
function vacuum() {
  db.exec('VACUUM');
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    stmts = null;
  }
}

// ────────────────────────────────────────────────────────────
module.exports = {
  initDb,
  closeDb,
  vacuum,
  insertFile,
  getFile,
  markDownloaded,
  searchFiles,
  getProgress,
  setProgress,
  resetProgressForChat,
  resetAllProgress,
  getStats,
  getStatsByCategory,
  getTopChannels,
  listChannels,
  DB_PATH,
};
