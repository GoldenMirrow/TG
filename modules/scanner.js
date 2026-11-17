/**
 * scanner.js — Escaneo de canales (force / new) usando data.json como progreso.
 *
 * data.json:
 *   {
 *     "scanFrom": "2024-01-01T00:00:00.000Z",
 *     "channels": { "@user": { "lastScan": "..." }, "123456": { ... } }
 *   }
 */
const fs = require('fs');
const path = require('path');

const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '..', 'data.json');
const DEFAULT_SCAN_FROM = '2024-01-01T00:00:00.000Z';

// ────────────────────────────────────────────────────────────
// data.json helpers
// ────────────────────────────────────────────────────────────
function readData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const d = JSON.parse(raw);
    return { scanFrom: d.scanFrom || DEFAULT_SCAN_FROM, channels: d.channels || {} };
  } catch {
    return { scanFrom: DEFAULT_SCAN_FROM, channels: {} };
  }
}

function writeData(d) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2) + '\n');
}

function setScanFrom(iso) {
  const d = readData();
  d.scanFrom = new Date(iso).toISOString();
  writeData(d);
  return d.scanFrom;
}

function channelKey(entity) {
  if (!entity) return null;
  if (entity.username) return '@' + entity.username;
  if (entity.id != null) return String(entity.id);
  return null;
}

function getLastScan(entity) {
  const d = readData();
  const key = channelKey(entity);
  const iso = key && d.channels[key]?.lastScan;
  return new Date(iso || d.scanFrom);
}

function setLastScan(entity, date = new Date()) {
  const d = readData();
  const key = channelKey(entity);
  if (!key) return;
  d.channels[key] = d.channels[key] || {};
  d.channels[key].lastScan = date.toISOString();
  writeData(d);
}

function clearProgress(entity) {
  const d = readData();
  const key = channelKey(entity);
  if (key && d.channels[key]) { delete d.channels[key]; writeData(d); }
}

function clearAllProgress() {
  const d = readData();
  d.channels = {};
  writeData(d);
}

// ────────────────────────────────────────────────────────────
// SCAN LOOP
// ────────────────────────────────────────────────────────────
const { categorize, isIndexable } = require('./categorizer');
const { classifyVideo, getVideoMeta } = require('./video-classifier');
const { normalizeTitle } = require('./title-normalizer');
const { findOrCreateSeries } = require('./video-tagger');
const { extractSeriesName, extractVolume } = require('./series');
const db = require('../db');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scanChannel(client, entity, title, { mode = 'new', maxMsgs = 0 } = {}) {
  const { fetchMessages } = require('../connection/telegram');
  const minDate = mode === 'force' ? new Date(0) : getLastScan(entity);

  const chatId       = String(entity.id);
  const accessHash   = entity.accessHash != null ? entity.accessHash.toString() : null;
  const chatUsername = entity.username || null;

  let lastId = 0;
  let scanned = 0, inserted = 0, skipped = 0, filtered = 0, noDoc = 0;
  let reachedLimit = false;
  const t0 = Date.now();

  console.log(`\n📥 ${title} [${mode}]`);
  if (mode === 'new') console.log(`   desde: ${minDate.toISOString()}`);

  let videoSeriesCache = null;

  while (true) {
    if (maxMsgs && scanned >= maxMsgs) {
      console.log(`   ⏹️  límite ${maxMsgs} msgs`);
      break;
    }
    const limit = maxMsgs ? Math.min(100, maxMsgs - scanned) : 100;

    let batch;
    try {
      batch = await fetchMessages(client, entity, { limit, offsetId: lastId });
    } catch (e) {
      if (e.seconds) {
        console.log(`   ⏳ FloodWait ${e.seconds}s`);
        await sleep(e.seconds * 1000 + 1000);
        continue;
      }
      throw e;
    }

    if (!batch?.length) break;

    for (const msg of batch) {
      scanned++;

      if (mode === 'new' && msg.date) {
        const dt = new Date(msg.date * 1000);
        if (dt < minDate) { reachedLimit = true; break; }
      }

      if (!msg.document) { noDoc++; continue; }

      const check = isIndexable(msg);
      if (!check.ok) { filtered++; continue; }

      const doc       = msg.document;
      const fileName  = check.fileName || `file_${doc.id}`;
      const { category, extension } = categorize(fileName, doc.mimeType);
      const fileSize  = doc.size != null ? Number(doc.size) : 0;
      const messageId = typeof msg.id === 'number' ? msg.id : Number(msg.id);

      const row = {
        chat_id: chatId,
        access_hash: accessHash,
        chat_title: title,
        chat_username: chatUsername,
        message_id: messageId,
        file_name: fileName,
        file_size: fileSize,
        mime_type: doc.mimeType || null,
        category,
        extension,
      };

      if (category === 'videos') {
        const meta = getVideoMeta(msg);
        const cls  = classifyVideo(fileName, meta.duration);
        row.duration = cls.duration;
        row.kind     = cls.kind;
        row.season   = cls.season;
        row.episode  = cls.episode;

        if (!videoSeriesCache) videoSeriesCache = db.listSeriesNames();
        const norm = normalizeTitle(fileName);
        const s = findOrCreateSeries(videoSeriesCache, fileName, norm);
        row.series_name    = s.series_name;
        row.series_display = s.series_display;
        if (s.isNew) videoSeriesCache.push({ series_name: s.series_name, series_display: s.series_display });
      } else if (category === 'libros') {
        row.series_name    = extractSeriesName(fileName);
        row.series_display = row.series_name;
        row.volume         = extractVolume(fileName);
      }

      const res = db.insertFile(row);
      res.inserted ? inserted++ : skipped++;
    }

    if (reachedLimit) {
      console.log(`   ⏹️  fecha límite alcanzada (${minDate.toISOString()})`);
      break;
    }

    lastId = batch[batch.length - 1].id;
    process.stdout.write(
      `\r   → ${scanned} msgs | ${inserted} nuevos | ${skipped} dup | ${filtered} filtrados   `
    );

    if (batch.length < limit) break;
    await sleep(500);
  }

  setLastScan(entity, new Date());

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n   ✅ ${inserted} nuevos | ${skipped} dup | ${filtered} basura | ${noDoc} sin archivo (${elapsed}s)`);
  return { scanned, inserted, skipped, filtered, noDoc };
}

module.exports = {
  scanChannel,
  readData, writeData, setScanFrom,
  getLastScan, setLastScan, clearProgress, clearAllProgress, channelKey,
  DATA_PATH,
};
