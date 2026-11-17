/**
 * modules/identifier.js — Identifica archivos usando Gemini Vision
 *
 * Dependencias: SOLO @google/generative-ai
 *   (zlib, fs, path → built-in de Node)
 *
 * Estrategia (solo thumbnail, sin ffmpeg ni pdfjs):
 *   - video → thumbnail de Telegram (~15-25 KB)
 *   - pdf   → thumbnail de Telegram (Telegram renderiza 1ª página)
 *   - cbz   → thumbnail si existe; si no, zlib nativo en primeros KB
 *   - cbr   → thumbnail si existe; si no, error
 *
 * Post-proceso: corrige extensión si Gemini sugiere una incorrecta.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const db = require('../db');

// ────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────
const GEMINI_MODEL     = process.env.GEMINI_MODEL     || 'gemini-3.1-flash-lite';
const IDENT_CBZ_KB     = parseInt(process.env.IDENT_CBZ_KB, 10)   || 1536;
const IDENT_CBZ_MAX_KB = parseInt(process.env.IDENT_CBZ_MAX_KB,10)|| 4096;

// ────────────────────────────────────────────────────────────
// GEMINI
// ────────────────────────────────────────────────────────────
let _genai = null;
function getGemini() {
  if (_genai) return _genai;
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('Falta GEMINI_API_KEY en .env');
  _genai = new GoogleGenerativeAI(key);
  return _genai;
}

function buildPrompt(ctx) {
  const { fileName, extension, duration, category } = ctx;
  const ext = extension || 'mp4';
  const durMin = duration ? Math.round(duration / 60) : null;
  const isEpisode = duration && duration < 3600;
  const kindHint = isEpisode
    ? 'EPISODIO de serie (menos de 60 min)'
    : (durMin ? 'PELÍCULA o episodio largo (>=60 min)' : 'desconocido');

  return `Eres un experto identificando películas, series, animes, mangas, libros y cómics.

CONTEXTO DEL ARCHIVO (la imagen adjunta es solo el THUMBNAIL):
- Nombre original: "${fileName}"
- Extensión real: .${ext}
- Duración: ${durMin ? durMin + ' minutos' : 'desconocida'}
- Tipo esperado: ${kindHint}
- Categoría DB: ${category || 'desconocida'}

Analiza personajes, escena, estilo artístico y texto visible del thumbnail para identificar la obra.

Devuelve SOLO un JSON:
{
  "media_type": "anime" | "movie" | "serie" | "manga" | "comic" | "book" | "unknown",
  "title": "Título canónico (sin fansub/calidad/año)",
  "subtitle": "S01E01" o "Tomo 03" o null,
  "author": null o autor,
  "year": año o null,
  "confidence": 0.0-1.0,
  "suggested_filename": "Titulo limpio.${ext}",
  "notes": "razón breve (máx 80 chars)"
}

REGLAS ESTRICTAS para suggested_filename:
- DEBE terminar en ".${ext}" (la extensión real del archivo)
- Usa ESPACIOS, NO guiones_bajos_ni_snake_case
- Title Case (Fate Stay Night, no fate stay night)
- Si es serie/episodio (<60min): "Titulo S01E05.${ext}"
- Si es película (>=60min): "Titulo (Año).${ext}"
- Si es manga: "Titulo - Tomo 01.${ext}"
- NUNCA incluyas descripciones de escena ("castle", "fight", "episode scene")
- NUNCA incluyas tags de calidad ("1080p", "x264", "BluRay")
- Si no estás seguro: media_type "unknown", confidence < 0.5
- Desconocido → null`;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    media_type:         { type: 'string', enum: ['anime','movie','serie','manga','comic','book','unknown'] },
    title:              { type: 'string' },
    subtitle:           { type: 'string', nullable: true },
    author:             { type: 'string', nullable: true },
    year:               { type: 'integer', nullable: true },
    confidence:         { type: 'number' },
    suggested_filename: { type: 'string' },
    notes:              { type: 'string' },
  },
  required: ['media_type', 'title', 'confidence', 'suggested_filename'],
};

async function askGemini(imageBuffer, mimeType = 'image/jpeg', ctx = {}, maxRetries = 3) {
  const genai = getGemini();
  const model = genai.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  });

  let lastError;
  let parsed;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent([
        { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
        buildPrompt(ctx),
      ]);
      const text = result.response.text();
      try { parsed = JSON.parse(text); }
      catch { throw new Error(`Gemini devolvió JSON inválido: ${text.slice(0, 120)}`); }
      break;
    } catch (e) {
      lastError = e;
      const status = e.status || (e.message.match(/\b(429|500|502|503|504)\b/)?.[1]);
      const isRetryable = status === 429 || (status >= 500 && status <= 599);
      if (!isRetryable || attempt === maxRetries) throw e;
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
      console.log(`   ⏳ ${status} en Gemini, reintento ${attempt}/${maxRetries} en ${delay / 1000}s...`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
  if (!parsed) throw lastError || new Error('Gemini no devolvió respuesta');

  // ── Fix post-proceso: forzar extensión correcta
  const originalExt = (ctx.extension || '').toLowerCase();
  if (originalExt && parsed.suggested_filename) {
    const hasRightExt = parsed.suggested_filename.toLowerCase().endsWith('.' + originalExt);
    if (!hasRightExt) {
      const wrongExt = parsed.suggested_filename.match(/\.([a-z0-9]{1,8})$/i);
      if (wrongExt) {
        console.log(`   ⚠️  Gemini sugirió .${wrongExt[1]}, corrigiendo a .${originalExt}`);
      }
      parsed.suggested_filename =
        parsed.suggested_filename.replace(/\.[a-z0-9]{1,8}$/i, '') + '.' + originalExt;
    }
  }

  return parsed;
}

// ────────────────────────────────────────────────────────────
// THUMBNAIL DE TELEGRAM
// ────────────────────────────────────────────────────────────
function pickLargestThumb(doc) {
  const thumbs = doc?.thumbs || [];
  if (!thumbs.length) return null;
  const withDims = thumbs.filter(t => t.w && t.h);
  if (withDims.length) {
    return withDims.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
  }
  return thumbs[thumbs.length - 1];
}

async function extractThumbnail(client, row) {
  const { resolveEntity } = require('../connection/telegram');
  const entity = await resolveEntity(client, row);
  const [msg] = await client.getMessages(entity, { ids: row.message_id });
  if (!msg?.document) throw new Error('mensaje sin documento');

  const thumb = pickLargestThumb(msg.document);
  if (!thumb) throw new Error('documento sin thumbnail en Telegram');

  const dims = thumb.w && thumb.h ? `${thumb.w}x${thumb.h}` : '?';
  console.log(`   🖼️  thumbnail Telegram (${dims}, ~${thumb.size || '?'} B)`);

  const buffer = await client.downloadMedia(msg, { thumb });
  if (!buffer || !buffer.length) throw new Error('thumbnail vacío');

  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    throw new Error('thumbnail es un video-miniatura (MP4), no una imagen');
  }

  let mime = 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) mime = 'image/png';
  else if (buffer.length >= 12 &&
           buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
           buffer.slice(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';

  console.log(`   ✅ thumbnail descargado (${(buffer.length / 1024).toFixed(0)} KB, ${mime})`);
  return { buffer, mime };
}

// ────────────────────────────────────────────────────────────
// DESCARGA PARCIAL (solo para fallback de CBZ)
// ────────────────────────────────────────────────────────────
async function downloadDocRange(client, doc, startOffset, length) {
  const { Api } = require('telegram');
  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: '',
  });

  const CHUNK = 256 * 1024;
  const iter = client.iterDownload({
    file: location,
    offset: BigInt(startOffset),
    requestSize: CHUNK,
    chunkSize: CHUNK,
  });

  const chunks = [];
  let total = 0;
  for await (const chunk of iter) {
    const remaining = length - total;
    if (chunk.length >= remaining) {
      chunks.push(chunk.slice(0, remaining));
      total += remaining;
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
    if (total >= length) break;
  }
  return Buffer.concat(chunks);
}

// ────────────────────────────────────────────────────────────
// CBZ → PRIMERA IMAGEN (fallback con zlib)
// ────────────────────────────────────────────────────────────
function extractFirstImageFromCbz(zipBuffer) {
  const SIG = 0x04034b50;
  const isImage = (name) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(name);

  let pos = 0;
  while (pos + 30 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(pos);
    if (sig !== SIG) break;

    const compression    = zipBuffer.readUInt16LE(pos + 8);
    const compressedSize = zipBuffer.readUInt32LE(pos + 18);
    const fnLen          = zipBuffer.readUInt16LE(pos + 26);
    const exLen          = zipBuffer.readUInt16LE(pos + 28);

    const nameStart = pos + 30;
    const nameEnd   = nameStart + fnLen;
    if (nameEnd > zipBuffer.length) break;

    const filename = zipBuffer.slice(nameStart, nameEnd).toString('utf8');
    const dataStart = nameEnd + exLen;
    const dataEnd   = dataStart + compressedSize;

    if (isImage(filename) && dataEnd <= zipBuffer.length) {
      const data = zipBuffer.slice(dataStart, dataEnd);
      if (compression === 0) return { buffer: data, filename };
      if (compression === 8) {
        try { return { buffer: zlib.inflateRawSync(data), filename }; } catch {}
      }
    }

    if (dataEnd > zipBuffer.length) break;
    pos = dataEnd;
  }
  throw new Error('no se encontró imagen en el fragmento del CBZ');
}

async function getCbzFirstImageByRange(client, row) {
  const { resolveEntity } = require('../connection/telegram');
  const entity = await resolveEntity(client, row);
  const [msg] = await client.getMessages(entity, { ids: row.message_id });
  if (!msg?.document) throw new Error('mensaje sin documento');

  let kb = IDENT_CBZ_KB;
  while (kb <= IDENT_CBZ_MAX_KB) {
    console.log(`   🔽 descarga parcial: ${kb}KB`);
    const buf = await downloadDocRange(client, msg.document, 0, kb * 1024);
    try {
      return extractFirstImageFromCbz(buf);
    } catch (e) {
      if (kb >= IDENT_CBZ_MAX_KB) throw new Error(`CBZ: ${e.message} (límite ${IDENT_CBZ_MAX_KB}KB)`);
      kb = Math.min(kb * 2, IDENT_CBZ_MAX_KB);
    }
  }
}

// ────────────────────────────────────────────────────────────
// RENOMBRADO / DB
// ────────────────────────────────────────────────────────────
function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function mapKindForDb(mediaType, subtitle) {
  if (mediaType === 'anime') {
    return /movie|pel[ií]cula/i.test(subtitle || '') ? 'anime_movie' : 'anime_series';
  }
  if (mediaType === 'movie') return 'movie';
  if (mediaType === 'serie') return 'serie';
  return null;
}

function parseEpisodeFromSubtitle(subtitle) {
  if (!subtitle) return { season: null, episode: null };
  const s = String(subtitle);
  const se = s.match(/[sS](\d{1,2})\s*[eE](\d{1,3})/);
  if (se) return { season: parseInt(se[1], 10), episode: parseInt(se[2], 10) };
  const ep = s.match(/(\d{1,4})/);
  if (ep) return { season: null, episode: parseInt(ep[1], 10) };
  return { season: null, episode: null };
}

function parseVolumeFromSubtitle(subtitle) {
  if (!subtitle) return null;
  const m = String(subtitle).match(/(\d{1,4})/);
  return m ? parseInt(m[1], 10) : null;
}

// ────────────────────────────────────────────────────────────
// FLUJO PRINCIPAL
// ────────────────────────────────────────────────────────────
async function identify(dbName, id, opts = {}) {
  const apply = opts.apply !== false;
  const renameOnDisk = !!opts.renameOnDisk;

  db.initAll();
  const row = db.getFile(dbName, id);
  if (!row) throw new Error(`Archivo ${dbName}#${id} no encontrado`);

  const ext = (row.extension || '').toLowerCase();
  let payload, payloadMime = 'image/jpeg';

  const { withClient } = require('../connection/telegram');

  await withClient(async (client) => {
    if (dbName === 'videos') {
      const r = await extractThumbnail(client, row);
      payload = r.buffer;
      payloadMime = r.mime;

    } else if (dbName === 'mangas' && ext === 'pdf') {
      const r = await extractThumbnail(client, row);
      payload = r.buffer;
      payloadMime = r.mime;

    } else if (dbName === 'mangas' && (ext === 'cbz' || ext === 'zip')) {
      try {
        const r = await extractThumbnail(client, row);
        payload = r.buffer;
        payloadMime = r.mime;
      } catch (e) {
        console.log(`   ⚠️  sin thumbnail (${e.message}) → zlib fallback`);
        const { buffer, filename } = await getCbzFirstImageByRange(client, row);
        payload = buffer;
        payloadMime = /\.png$/i.test(filename) ? 'image/png' : 'image/jpeg';
      }

    } else if (dbName === 'mangas' && ext === 'cbr') {
      try {
        const r = await extractThumbnail(client, row);
        payload = r.buffer;
        payloadMime = r.mime;
      } catch {
        throw new Error('CBR sin thumbnail — RAR no soportado sin índice');
      }

    } else {
      throw new Error(`Tipo no soportado: ${dbName}/${ext}`);
    }
  });

  console.log(`   🤖 consultando Gemini (${GEMINI_MODEL})...`);
  const result = await askGemini(payload, payloadMime, {
    fileName: row.file_name,
    extension: ext,
    duration: row.duration,
    category: row.category,
  });

  console.log(`\n   🎯 ${result.media_type} | ${result.title}` +
    (result.subtitle ? ` — ${result.subtitle}` : '') +
    ` | ${(result.confidence * 100).toFixed(0)}%`);
  if (result.suggested_filename) console.log(`   📝 propuesta: ${result.suggested_filename}`);

  const out = { ...result, dbName, id, applied: false, renamedOnDisk: null };
  if (!apply) return out;

  const patch = { file_name: sanitizeFilename(result.suggested_filename) || row.file_name };

  if (dbName === 'videos') {
    const kind = mapKindForDb(result.media_type, result.subtitle);
    if (kind) patch.kind = kind;
    if (result.title) {
      patch.series_name = result.title.toLowerCase().trim();
      patch.series_display = result.title;
    }
    const { season, episode } = parseEpisodeFromSubtitle(result.subtitle);
    if (season) patch.season = season;
    if (episode) patch.episode = episode;

  } else if (dbName === 'mangas') {
    if (result.title) {
      patch.series_name = result.title.toLowerCase().trim();
      patch.series_display = result.title;
    }
    const volume = parseVolumeFromSubtitle(result.subtitle);
    if (volume) patch.volume = volume;
  }

  db.updateFile(dbName, id, patch);
  out.applied = true;
  out.newName = patch.file_name;

  if (renameOnDisk && row.downloaded_path && fs.existsSync(row.downloaded_path)) {
    const dir = path.dirname(row.downloaded_path);
    const newPath = path.join(dir, patch.file_name);
    if (newPath !== row.downloaded_path && !fs.existsSync(newPath)) {
      fs.renameSync(row.downloaded_path, newPath);
      db.getStmts(dbName).markDownloaded.run(newPath, id);
      out.renamedOnDisk = newPath;
      console.log(`   📁 renombrado en disco: ${newPath}`);
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────
// LOTE
// ────────────────────────────────────────────────────────────
async function identifyBatch(dbName, filter = {}, opts = {}) {
  db.initAll();
  const rows = db.searchFiles(dbName, { ...filter, limit: opts.limit || 20, offset: 0 });
  console.log(`🔎 ${rows.length} archivos a identificar\n`);
  const results = [];
  for (const r of rows) {
    try {
      results.push(await identify(dbName, r.id, opts));
    } catch (e) {
      console.error(`❌ ${r.file_name}: ${e.message}`);
      results.push({ id: r.id, error: e.message });
    }
    await new Promise(res => setTimeout(res, opts.delayMs || 4500));
  }
  return results;
}

// ────────────────────────────────────────────────────────────
// NOMBRES SINTÉTICOS
// ────────────────────────────────────────────────────────────
function isSyntheticName(fileName) {
  if (!fileName) return true;
  const name = String(fileName).trim();
  if (!name) return true;
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  if (!base) return true;
  const lower = base.toLowerCase();

  const PATTERNS = [
    /^(file|video|audio|image|photo|document|media|vid|img|doc)[_\-\s]?\d+$/i,
    /^(file|video|audio|image|photo|document|media|vid|img|doc)$/i,
    /^(untitled|unnamed|default|download|recording)[_\-\s]?\d*$/i,
    /^(video|audio|photo|image|document|file|media)[_\-\s]?\d{4}[-_]\d{2}[-_]\d{2}/i,
    /^(img|vid|aud|doc|ptt|stk)[_\-]\d{8}[_\-]wa\d+$/i,
    /^\d{6,}$/,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /^[0-9a-f]{16,}$/i,
    /^received[_\-\s]?\d+$/i,
  ];

  for (const re of PATTERNS) if (re.test(lower)) return true;
  return false;
}

function listSynthetic(opts = {}) {
  db.initAll();
  const dbs = opts.db && opts.db !== 'all' ? [opts.db] : ['videos', 'mangas'];
  const limit = parseInt(opts.limit, 10) || 50;

  const out = [];
  for (const dbName of dbs) {
    const rows = db.searchFiles(dbName, {
      category: opts.category,
      extension: opts.ext,
      limit: 999999,
      offset: 0,
    });
    for (const r of rows) {
      if (r.extension === 'cbr') continue;
      if (isSyntheticName(r.file_name)) out.push({ db: dbName, ...r });
    }
  }

  console.log(`\n🔍 ${out.length} archivos con nombre sintético (${dbs.join('+')})\n`);
  if (!out.length) return;
  out.sort((a, b) => b.file_size - a.file_size);
  for (const r of out.slice(0, limit)) {
    const size = (r.file_size / 1024 / 1024).toFixed(1);
    const dur = r.duration ? ` ${Math.round(r.duration / 60)}min` : '';
    console.log(`   ${r.db}#${String(r.id).padEnd(6)} ${String(size).padStart(7)} MB${dur.padEnd(6)}  ${r.file_name}`);
  }
  if (out.length > limit) console.log(`\n   ... y ${out.length - limit} más (usa -l N)`);
}

async function identifyAll(opts = {}) {
  db.initAll();
  const dbs       = opts.db && opts.db !== 'all' ? [opts.db] : ['videos', 'mangas'];
  const delayMs   = opts.delayMs || 4500;
  const limit     = opts.limit || 0;
  const dryRun    = opts.apply === false;
  const force     = !!opts.force;
  const renameOnDisk = !!opts.renameOnDisk;

  const allRows = [];
  for (const dbName of dbs) {
    const rows = db.searchFiles(dbName, {
      category: opts.category,
      extension: opts.ext,
      limit: 999999,
      offset: 0,
    });
    for (const r of rows) {
      if (r.extension === 'cbr') continue;
      if (!force && !isSyntheticName(r.file_name)) continue;
      allRows.push({ db: dbName, ...r });
    }
  }

  allRows.sort((a, b) => b.file_size - a.file_size);
  const toProcess = limit > 0 ? allRows.slice(0, limit) : allRows;

  if (!toProcess.length) {
    console.log('✅ No hay archivos que identificar');
    return { stats: { ok: 0, fail: 0 }, failures: [] };
  }

  console.log(`\n🎯 ${toProcess.length} archivos (${force ? 'TODOS' : 'solo sintéticos'})`);
  console.log(`   Delay: ${delayMs}ms (~${Math.floor(60000 / delayMs)} req/min)\n`);

  const stats = { ok: 0, noChange: 0, fail: 0 };
  const failures = [];
  const t0 = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const r = toProcess[i];
    console.log(`\n[${i + 1}/${toProcess.length}] ${r.db}#${r.id} — ${r.file_name} (${(r.file_size / 1024 / 1024).toFixed(1)} MB)`);

    try {
      const result = await identify(r.db, r.id, { apply: !dryRun, renameOnDisk });
      if (result.newName && result.newName !== r.file_name) stats.ok++;
      else if (!result.newName) stats.noChange++;
      else stats.ok++;
    } catch (e) {
      stats.fail++;
      failures.push({ db: r.db, id: r.id, file: r.file_name, error: e.message });
      console.error(`   ❌ ${e.message}`);
    }

    if (i < toProcess.length - 1) await new Promise(res => setTimeout(res, delayMs));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 RESUMEN (${elapsed}s)`);
  console.log(`   ✅ Identificados:  ${stats.ok}`);
  console.log(`   ⚠️  Sin cambios:    ${stats.noChange}`);
  console.log(`   ❌ Fallos:         ${stats.fail}`);

  if (failures.length) {
    console.log(`\n❌ FALLOS:`);
    for (const f of failures) {
      console.log(`   ${f.db}#${f.id}: ${f.error.slice(0, 100)}`);
    }
  }

  return { stats, failures };
}

// ────────────────────────────────────────────────────────────
module.exports = {
  identify,
  identifyBatch,
  identifyAll,
  listSynthetic,
  isSyntheticName,
  askGemini,
  extractThumbnail,
};
