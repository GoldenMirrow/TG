/**
 * modules/thumbnails.js — Descarga y cachea thumbnails de Telegram
 *
 * Estructura en disco:
 *   data/thumbnails/{db}/{id}.jpg
 *
 * Marca has_thumb en la DB:
 *   1  → thumbnail descargado
 *   0  → pendiente
 *   -1 → sin thumb posible (definitivo, no reintentar)
 *
 * Estrategia defensiva:
 *   - thumbs null/undefined/array vacío → skip (no fail)
 *   - downloadMedia falla → skip (no fail)
 *   - buffer < 300 bytes → skip
 *   - path solo usa id.jpg (nunca file_name)
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');

const THUMB_DIR = process.env.THUMB_DIR || path.join(__dirname, '..', 'data', 'thumbnails');
const MIN_THUMB_BYTES = 300;

// ────────────────────────────────────────────────────────────
// PATHS
// ────────────────────────────────────────────────────────────
function thumbPath(dbName, id) {
  const dir = path.join(THUMB_DIR, dbName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jpg`);
}

function thumbRelPath(dbName, id) {
  return `${dbName}/${id}.jpg`;
}

function hasThumbFile(dbName, id) {
  return fs.existsSync(thumbPath(dbName, id));
}

// ────────────────────────────────────────────────────────────
// PICK THUMBNAIL
// ────────────────────────────────────────────────────────────
function pickLargestThumb(doc) {
  const raw = doc?.thumbs;

  // Normalizar: null, undefined, array, objeto único
  let thumbs = [];
  if (Array.isArray(raw)) {
    thumbs = raw;
  } else if (raw && typeof raw === 'object') {
    thumbs = [raw];
  }
  if (!thumbs.length) return null;

  // Filtrar entradas nulas o sin datos
  const valid = thumbs.filter(t => t && (t.w || t.h || t.size || t.bytes));
  if (!valid.length) return null;

  // Preferir los que tienen dimensiones (más grandes primero)
  const withDims = valid.filter(t => t.w && t.h);
  if (withDims.length) {
    return withDims.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
  }

  // Fallback: el último (suele ser el más grande en Telegram)
  return valid[valid.length - 1];
}

// ────────────────────────────────────────────────────────────
// DESCARGA Y GUARDADO
// ────────────────────────────────────────────────────────────
/**
 * Descarga el thumb de un archivo y lo guarda en disco.
 * @returns {Promise<string|null>} ruta relativa o null si no hay thumb
 */
async function extractAndSave(client, dbName, row) {
  const { resolveEntity } = require('../connection/telegram');

  let entity;
  try {
    entity = await resolveEntity(client, row);
  } catch (e) {
    throw new Error(`resolveEntity: ${e.message}`);
  }

  let msg;
  try {
    [msg] = await client.getMessages(entity, { ids: row.message_id });
  } catch (e) {
    throw new Error(`getMessages: ${e.message}`);
  }

  if (!msg?.document) return null;

  // ── FILTRO DURO: sin thumbs = skip inmediato (no intentar downloadMedia)
  const raw = msg.document.thumbs;
  if (!raw || (Array.isArray(raw) && raw.length === 0)) {
    return null;
  }

  const thumb = pickLargestThumb(msg.document);
  if (!thumb) return null;

  let buffer;
  try {
    buffer = await client.downloadMedia(msg, { thumb });
  } catch (e) {
    // thumb corrupto/inválido → skip, no fail
    return null;
  }

  if (!buffer || buffer.length < MIN_THUMB_BYTES) return null;

  // Detectar video-miniatura (MP4) — no es imagen
  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    return null;
  }

  // Path SIEMPRE usa solo id.jpg (nunca file_name)
  const out = thumbPath(dbName, row.id);

  try {
    fs.writeFileSync(out, buffer);
  } catch (e) {
    throw new Error(`writeFileSync(${out}): ${e.message}`);
  }

  return thumbRelPath(dbName, row.id);
}

// ────────────────────────────────────────────────────────────
// INDEXACIÓN MASIVA
// ────────────────────────────────────────────────────────────
/**
 * Indexa thumbnails para todos los archivos sin has_thumb.
 * @param {object} opts { db, limit, delayMs, force }
 */
async function indexThumbnails(opts = {}) {
  db.initAll();
  const dbs = opts.db && opts.db !== 'all' ? [opts.db] : ['videos', 'mangas', 'otros'];
  const delayMs = opts.delayMs || 200;
  const limit = opts.limit || 0;
  const force = !!opts.force;

  // ── Recopilar archivos a procesar
  const queue = [];
  for (const dbName of dbs) {
    const d = db.getDb(dbName);
    const where = force ? '1=1' : '(has_thumb IS NULL OR has_thumb = 0)';
    const rows = d.prepare(`
      SELECT id, file_name, category, extension, message_id, file_size, duration, chat_id, access_hash
      FROM files
      WHERE ${where}
        AND category IN ('videos', 'libros', 'imagenes')
      ORDER BY file_size DESC
    `).all();
    for (const r of rows) queue.push({ db: dbName, ...r });
  }

  if (!queue.length) {
    console.log('✅ Todos los archivos ya tienen thumbnail o fueron marcados como sin-thumb');
    return { ok: 0, skip: 0, fail: 0 };
  }

  const toProcess = limit > 0 ? queue.slice(0, limit) : queue;
  console.log(`\n🖼️  ${toProcess.length} thumbnails a descargar (${queue.length - toProcess.length} quedan para después)\n`);

  const stats = { ok: 0, skip: 0, fail: 0 };
  const failures = [];
  const t0 = Date.now();

  const { withClient } = require('../connection/telegram');

  await withClient(async (client) => {
    for (let i = 0; i < toProcess.length; i++) {
      const r = toProcess[i];
      const prefix = `[${i + 1}/${toProcess.length}]`;
      const fileShort = (r.file_name || '').slice(0, 45);

      try {
        const relPath = await extractAndSave(client, r.db, r);

        if (!relPath) {
          // Sin thumb → skip definitivo (has_thumb = -1)
          db.updateFile(r.db, r.id, { has_thumb: -1 });
          stats.skip++;
          process.stdout.write(`\r${prefix} ⏭️  sin thumb: ${fileShort.padEnd(45)}`);
          continue;
        }

        db.updateFile(r.db, r.id, { has_thumb: 1 });
        stats.ok++;
        process.stdout.write(`\r${prefix} ✅ ${fileShort.padEnd(45)}`);

      } catch (e) {
        db.updateFile(r.db, r.id, { has_thumb: -1 });
        stats.fail++;
        failures.push({ db: r.db, id: r.id, name: r.file_name, error: e.message });

        // Log del error
        const errMsg = (e.message || String(e)).slice(0, 80);
        process.stdout.write(`\r${prefix} ❌ ${fileShort.padEnd(45)} — ${errMsg}\n`);
      }

      // Delay entre requests
      if (i < toProcess.length - 1 && delayMs > 0) {
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\n📊 RESUMEN (${elapsed}s)`);
  console.log(`   ✅ Con thumbnail:   ${stats.ok}`);
  console.log(`   ⏭️  Sin thumbnail:   ${stats.skip}`);
  console.log(`   ❌ Fallos:          ${stats.fail}`);
  console.log(`   Total:             ${toProcess.length}`);

  if (failures.length) {
    console.log(`\n❌ FALLOS (primeros 10):`);
    for (const f of failures.slice(0, 10)) {
      console.log(`   ${f.db}#${f.id}: ${(f.name || '').slice(0, 40)} — ${f.error.slice(0, 60)}`);
    }
    if (failures.length > 10) {
      console.log(`   ... y ${failures.length - 10} más`);
    }
  }

  return stats;
}

// ────────────────────────────────────────────────────────────
// VERIFICACIÓN: contar thumbs en disco vs DB
// ────────────────────────────────────────────────────────────
function thumbStats() {
  db.initAll();
  const out = {};
  for (const dbName of ['videos', 'mangas', 'otros']) {
    const d = db.getDb(dbName);
    const total = d.prepare('SELECT COUNT(*) as n FROM files').get().n;
    const withThumb = d.prepare('SELECT COUNT(*) as n FROM files WHERE has_thumb = 1').get().n;
    const skipped = d.prepare('SELECT COUNT(*) as n FROM files WHERE has_thumb = -1').get().n;
    const pending = d.prepare('SELECT COUNT(*) as n FROM files WHERE has_thumb IS NULL OR has_thumb = 0').get().n;

    const dir = path.join(THUMB_DIR, dbName);
    const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length : 0;

    out[dbName] = { total, withThumb, skipped, pending, onDisk };
  }
  return out;
}

// ────────────────────────────────────────────────────────────
module.exports = {
  indexThumbnails,
  thumbPath,
  thumbRelPath,
  hasThumbFile,
  thumbStats,
  pickLargestThumb,
  MIN_THUMB_BYTES,
  THUMB_DIR,
};
