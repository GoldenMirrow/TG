/**
 * web/routes/api.js — Endpoints REST
 *
 * Fixes aplicados:
 *   - iterDownload usa BigInteger de big-integer (no BigInt ni Number)
 *   - offset alineado a 4 KB para evitar OFFSET_INVALID
 *   - search con sort configurable (size/date/name)
 *   - thumbs con job asíncrono
 *   - stats incluye has_thumb
 *   - streaming con Range requests
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const BigInteger = require('big-integer');
const db = require('../../db');
const { createJob, updateJob, getJob } = require('../jobs');
const { listCategories } = require('../../modules/categorizer');
const { hasThumbFile, thumbRelPath } = require('../../modules/thumbnails');
const { getStreamClient } = require('../stream');

const router = express.Router();

// ─── Stats ───
router.get('/stats', (req, res) => {
  try {
    db.initAll();
    const out = {};
    for (const name of ['mangas', 'videos', 'otros']) {
      const s = db.getStats(name);
      const thumbCount = db.getDb(name).prepare(
        'SELECT COUNT(*) as n FROM files WHERE has_thumb = 1'
      ).get().n;
      out[name] = {
        count: s?.count || 0,
        total_size: s?.total_size || 0,
        channels: s?.channels || 0,
        with_thumb: thumbCount,
        byCategory: db.getStatsByCategory(name),
        byKind: name === 'videos' ? db.getStatsByKind(name) : [],
      };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Channels ───
router.get('/channels', (req, res) => {
  const dbName = req.query.db;
  if (!dbName) return res.status(400).json({ error: 'db requerido' });
  try {
    db.initAll();
    res.json(db.listChannels(dbName));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Series ───
router.get('/series', (req, res) => {
  const dbName = req.query.db || 'videos';
  try {
    db.initAll();
    res.json(db.listSeries(dbName));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Categories ───
router.get('/categories', (req, res) => {
  res.json(listCategories());
});

// ─── Search ───
router.get('/search', (req, res) => {
  const {
    db: dbName, q, category, ext, series, kind, chat,
    minSize, maxSize, limit = 60, offset = 0, sort = 'size_desc',
  } = req.query;

  const target = dbName && dbName !== 'all' ? [dbName] : ['mangas', 'videos', 'otros'];

  try {
    db.initAll();
    const results = [];
    for (const name of target) {
      const rows = db.searchFiles(name, {
        query: q || '',
        category, extension: ext, series, kind, chat,
        minSize: parseFloat(minSize) || 0,
        maxSize: parseFloat(maxSize) || 0,
        limit: parseInt(limit) || 60,
        offset: parseInt(offset) || 0,
        sort,
      });
      for (const r of rows) {
        results.push({
          db: name,
          ...r,
          thumb_url: r.has_thumb === 1 ? `/thumbnails/${thumbRelPath(name, r.id)}` : null,
          stream_url: name === 'videos' && r.category === 'videos'
            ? `/api/stream/${name}/${r.id}`
            : null,
        });
      }
    }

    if (target.length > 1) {
      const sortFns = {
        size_desc: (a, b) => b.file_size - a.file_size,
        size_asc: (a, b) => a.file_size - b.file_size,
        date_desc: (a, b) => b.indexed_at - a.indexed_at,
        date_asc: (a, b) => a.indexed_at - b.indexed_at,
        name_asc: (a, b) => a.file_name.localeCompare(b.file_name),
        name_desc: (a, b) => b.file_name.localeCompare(a.file_name),
      };
      results.sort(sortFns[sort] || sortFns.size_desc);
      results.splice(parseInt(limit) || 60);
    }

    res.json({ results, total: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── File detail ───
router.get('/files/:db/:id', (req, res) => {
  const { db: dbName, id } = req.params;
  try {
    db.initAll();
    const row = db.getFile(dbName, parseInt(id, 10));
    if (!row) return res.status(404).json({ error: 'no encontrado' });
    res.json({
      db: dbName,
      ...row,
      thumb_url: row.has_thumb === 1 ? `/thumbnails/${thumbRelPath(dbName, row.id)}` : null,
      stream_url: dbName === 'videos' && row.category === 'videos'
        ? `/api/stream/${dbName}/${row.id}`
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Streaming (con Range) ───
router.get('/stream/:db/:id', async (req, res) => {
  const { db: dbName, id } = req.params;

  try {
    db.initAll();
    const row = db.getFile(dbName, parseInt(id, 10));
    if (!row) return res.status(404).json({ error: 'no encontrado' });
    if (row.category !== 'videos') {
      return res.status(400).json({ error: 'solo videos soportan streaming' });
    }

    const client = await getStreamClient();
    const { resolveEntity } = require('../../connection/telegram');
    const { Api } = require('telegram');

    const entity = await resolveEntity(client, row);
    const [msg] = await client.getMessages(entity, { ids: row.message_id });
    if (!msg?.document) return res.status(404).json({ error: 'mensaje sin documento' });

    const doc = msg.document;
    const fileSize = Number(doc.size) || 0;
    const mimeType = doc.mimeType || 'video/mp4';

    const location = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: '',
    });

    const CHUNK = 512 * 1024;
    const range = req.headers.range;

    let aborted = false;
    req.on('close', () => { aborted = true; });

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const rawStart = parseInt(parts[0], 10) || 0;
      // Telegram exige offset múltiplo de 4 KB
      const start = Math.floor(rawStart / 4096) * 4096;
      const end = parts[1]
        ? parseInt(parts[1], 10)
        : Math.min(start + 4 * 1024 * 1024, fileSize - 1);
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=3600',
      });

      let bytesSent = 0;
      try {
        const iter = client.iterDownload({
          file: location,
          offset: BigInteger(start),   // ✅ big-integer
          requestSize: CHUNK,
          chunkSize: CHUNK,
        });

        for await (const chunk of iter) {
          if (aborted) break;
          const remaining = chunkSize - bytesSent;
          if (chunk.length >= remaining) {
            res.write(chunk.slice(0, remaining));
            bytesSent += remaining;
            break;
          }
          res.write(chunk);
          bytesSent += chunk.length;
          if (bytesSent >= chunkSize) break;
        }
        res.end();
      } catch (e) {
        console.error('Stream range error:', e.message);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      }
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });

      try {
        const iter = client.iterDownload({
          file: location,
          offset: BigInteger(0),       // ✅ big-integer
          requestSize: CHUNK,
          chunkSize: CHUNK,
        });

        for await (const chunk of iter) {
          if (aborted) break;
          res.write(chunk);
        }
        res.end();
      } catch (e) {
        console.error('Stream full error:', e.message);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      }
    }
  } catch (e) {
    console.error('Stream setup error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
});

// ─── Download ───
router.post('/download/:db/:id', (req, res) => {
  const { db: dbName, id } = req.params;
  const fileId = parseInt(id, 10);
  try {
    db.initAll();
    const row = db.getFile(dbName, fileId);
    if (!row) return res.status(404).json({ error: 'archivo no encontrado' });
    if (row.downloaded_path && fs.existsSync(row.downloaded_path)) {
      return res.json({ jobId: null, alreadyDone: true, path: row.downloaded_path });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const jobId = createJob('download', { db: dbName, id: fileId });
  res.json({ jobId });

  (async () => {
    try {
      updateJob(jobId, { status: 'running' });
      const m = require('../../modules/telegram-indexer');
      await m.download(dbName, fileId, {
        out: './downloads',
        onProgress: (d, t) => updateJob(jobId, { progress: d, total: t }),
      });
      updateJob(jobId, { status: 'done', progress: 1, total: 1 });
    } catch (e) {
      updateJob(jobId, { status: 'error', error: e.message });
    }
  })();
});

// ─── Scan ───
router.post('/scan', (req, res) => {
  const { mode = 'new', channel = null, maxMsgs = 0 } = req.body || {};
  if (!['new', 'force'].includes(mode)) {
    return res.status(400).json({ error: "mode inválido (usa 'new' o 'force')" });
  }

  const jobId = createJob('scan', { mode, channel, maxMsgs });
  res.json({ jobId });

  (async () => {
    try {
      updateJob(jobId, { status: 'running' });
      const m = require('../../modules/telegram-indexer');
      await m.scan({ mode, channel, maxMsgs });
      updateJob(jobId, { status: 'done' });
    } catch (e) {
      updateJob(jobId, { status: 'error', error: e.message });
    }
  })();
});

// ─── Thumbs job ───
router.post('/thumbs', (req, res) => {
  const { db: dbName = 'all', limit = 100 } = req.body || {};
  const jobId = createJob('thumbs', { db: dbName, limit });
  res.json({ jobId });

  (async () => {
    try {
      updateJob(jobId, { status: 'running' });
      const { indexThumbnails } = require('../../modules/thumbnails');
      await indexThumbnails({ db: dbName, limit });
      updateJob(jobId, { status: 'done' });
    } catch (e) {
      updateJob(jobId, { status: 'error', error: e.message });
    }
  })();
});

// ─── Job status ───
router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job no encontrado' });
  res.json(job);
});

module.exports = router;
