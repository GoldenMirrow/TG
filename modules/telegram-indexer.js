/**
 * telegram-indexer.js — Orquesta indexación/búsqueda/descarga Telegram.
 * Delega en scanner.js, db/, connection/telegram.js.
 */
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { scanChannel, clearProgress, clearAllProgress } = require('./scanner');

const CATEGORY_ICONS = {
  libros:'📚', videos:'🎬', audio:'🎵', imagenes:'🖼️',
  comprimidos:'📦', software:'💿', documentos:'📄',
  juegos:'🎮', otros:'⚙️',
};
const iconFor = c => CATEGORY_ICONS[c] || '⚙️';

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '?';
  const u = ['B','KB','MB','GB','TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function makeLink(row) {
  if (row.chat_username) return `https://t.me/${row.chat_username}/${row.message_id}`;
  return `https://t.me/c/${row.chat_id}/${row.message_id}`;
}

// ────────────────────────────────────────────────────────────
// LOGIN
// ────────────────────────────────────────────────────────────
async function login() {
  const { interactiveLogin } = require('../connection/telegram');
  await interactiveLogin();
}

// ────────────────────────────────────────────────────────────
// SCAN
// ────────────────────────────────────────────────────────────
async function scan(opts = {}) {
  const { withClient, getDialogs, getEntity } = require('../connection/telegram');
  db.initAll();

  const mode = opts.force ? 'force' : (opts.mode || 'new');

  if (opts.reset) {
    if (opts.channel) {
      await withClient(async (client) => {
        const e = await getEntity(client, opts.channel);
        clearProgress(e);
        console.log(`🔄 Progreso reseteado: ${opts.channel}`);
      });
    } else {
      clearAllProgress();
      console.log('🔄 Progreso reseteado: TODOS');
    }
    if (!opts.force) return;
  }

  const maxMsgs = parseInt(opts.maxMsgs) || 0;

  await withClient(async (client) => {
    let targets = [];
    if (opts.channel) {
      const e = await getEntity(client, opts.channel);
      targets = [{ entity: e, title: e.title || e.username || String(e.id) }];
    } else {
      const dialogs = await getDialogs(client, 500);
      targets = dialogs
        .filter(d => (d.isChannel || d.isGroup) && !d.isUser)
        .map(d => ({
          entity: d.entity,
          title: d.title || d.entity?.username || String(d.entity?.id ?? '?'),
        }));
      console.log(`📂 ${targets.length} canales/grupos\n`);
    }

    let totalNew = 0;
    for (const { entity, title } of targets) {
      try {
        const r = await scanChannel(client, entity, title, { mode, maxMsgs });
        totalNew += r.inserted;
      } catch (e) {
        console.error(`⚠️  ${title}: ${e.message}`);
      }
    }
    console.log(`\n✅ Escaneo completo. ${totalNew} archivos nuevos.`);
  });
}

// ────────────────────────────────────────────────────────────
// SEARCH
// ────────────────────────────────────────────────────────────
async function search(query, opts = {}) {
  db.initAll();
  const dbName = opts.db || null;
  const common = {
    query,
    category: opts.category,
    extension: opts.ext,
    series: opts.series,
    kind: opts.kind,
    minSize: parseInt(opts.minSize) || 0,
    maxSize: parseInt(opts.maxSize) || 0,
    limit: parseInt(opts.limit) || 20,
    offset: parseInt(opts.offset) || 0,
  };

  let rows;
  if (dbName) rows = db.searchFiles(dbName, common);
  else        rows = db.searchAll(common);

  if (!rows.length) { console.log('❌ Sin resultados'); return; }

  console.log(`\n🔎 ${rows.length} resultado(s):\n`);
  for (const r of rows) {
    const tag = r._db ? ` [${r._db}#${r.id}]` : ` [#${r.id}]`;
    const icon = iconFor(r.category);
    const dl = r.downloaded_path ? ' ✅' : '';
    console.log(`${icon}${tag} ${r.file_name}${dl}`);
    console.log(`   📦 ${formatSize(r.file_size)} | 📁 ${r.chat_title} | 🏷️ ${r.category}${r.extension ? '.'+r.extension : ''}`);
    if (r.kind) {
      let extra = `   🎬 ${r.kind}`;
      if (r.series_display) extra += ` | serie: ${r.series_display}`;
      if (r.season) extra += ` | S${r.season}`;
      if (r.episode) extra += ` E${r.episode}`;
      if (r.duration) extra += ` | ${(r.duration/60).toFixed(0)} min`;
      console.log(extra);
    }
    console.log(`   🔗 ${makeLink(r)}`);
    if (!r.downloaded_path) {
      console.log(`   ⬇️  node index.js download ${r._db || dbName} ${r.id}\n`);
    } else console.log('');
  }
}

// ────────────────────────────────────────────────────────────
// DOWNLOAD
// ────────────────────────────────────────────────────────────
async function download(dbName, id, opts = {}) {
  db.initAll();
  let row, srcDb = dbName;
  if (dbName && dbName !== 'auto') {
    row = db.getFile(dbName, id);
  } else {
    const found = db.findFile(id);
    if (found) { row = found.row; srcDb = found.db; }
  }
  if (!row) { console.error(`❌ No existe #${id}`); return; }

  const outDir = path.resolve(opts.out || './downloads');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, row.file_name);

  if (fs.existsSync(outPath) && !opts.force) {
    console.log(`✅ Ya existe: ${outPath}`);
    db.markDownloaded(srcDb, id, outPath);
    return outPath;
  }

  const { withClient, resolveEntity, downloadMedia } = require('../connection/telegram');
  await withClient(async (client) => {
    const entity = await resolveEntity(client, row);
    console.log(`⬇️  ${row.file_name} (${formatSize(row.file_size)})`);
    let lastPct = -1;
    await downloadMedia(client, entity, row.message_id, outPath, (d, t) => {
      if (opts.onProgress) opts.onProgress(d, t);
      const pct = t ? Math.floor(d / t * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r   ${pct}% - ${formatSize(d)} / ${formatSize(t)}   `);
      }
    });
    console.log(`\n✅ Guardado: ${outPath}`);
    db.markDownloaded(srcDb, id, outPath);
  });
  return outPath;
}


async function downloadAll(query, opts = {}) {
  db.initAll();
  const dbName = opts.db && opts.db !== 'auto' ? opts.db : null;
  const common = {
    query,
    category: opts.category,
    extension: opts.ext,
    limit: parseInt(opts.limit) || 10,
    offset: 0,
  };
  const rows = dbName ? db.searchFiles(dbName, common) : db.searchAll(common);
  if (!rows.length) { console.log('❌ Sin resultados'); return; }

  console.log(`📦 Descargando ${rows.length}...\n`);
  let ok = 0, fail = 0;
  for (const r of rows) {
    try { await download(r._db || dbName, r.id, opts); ok++; }
    catch (e) { console.error(`❌ ${r.file_name}: ${e.message}`); fail++; }
  }
  console.log(`\n✅ ${ok} ok, ❌ ${fail} fallos`);
}

// ────────────────────────────────────────────────────────────
// STATS / CHANNELS / FILES / SERIES
// ────────────────────────────────────────────────────────────
async function stats() {
  db.initAll();
  for (const name of ['mangas', 'videos', 'otros']) {
    const t = db.getStats(name);
    if (!t || !t.count) continue;
    console.log(`\n📊 ${name.toUpperCase()}: ${t.count} archivos | ${formatSize(t.total_size)} | ${t.channels} canales`);
    for (const c of db.getStatsByCategory(name)) {
      console.log(`   ${iconFor(c.category)} ${(c.category || '?').padEnd(12)} ${String(c.count).padStart(6)} | ${formatSize(c.total_size)}`);
    }
    if (name === 'videos') {
      const kinds = db.getStatsByKind(name);
      if (kinds.length) {
        console.log('   — por tipo:');
        for (const k of kinds) console.log(`     ${(k.kind || '?').padEnd(14)} ${String(k.count).padStart(6)}`);
      }
    }
  }
}

async function channels() {
  db.initAll();
  for (const name of ['mangas', 'videos', 'otros']) {
    const rows = db.listChannels(name);
    if (!rows.length) continue;
    console.log(`\n📂 ${name.toUpperCase()} — ${rows.length} canal(es):`);
    for (const r of rows) {
      const handle = r.chat_username ? `@${r.chat_username}` : '(privado)';
      console.log(`   📁 ${r.chat_title} ${handle} — ${r.count} archivos | ${formatSize(r.total_size)}`);
    }
  }
}

async function listFiles(opts = {}) {
  db.initAll();
  const dbName = opts.db || 'mangas';
  const rows = db.searchFiles(dbName, {
    query: '',
    chat: opts.channel,
    category: opts.category,
    extension: opts.ext,
    limit: parseInt(opts.limit) || 50,
    offset: parseInt(opts.offset) || 0,
  });
  if (!rows.length) return console.log(`📭 Sin archivos en ${dbName}`);
  for (const r of rows) {
    console.log(`${iconFor(r.category)} [${dbName}#${r.id}] ${r.file_name} (${formatSize(r.file_size)}) — ${r.chat_title}`);
  }
}

async function listSeries(dbName = 'videos') {
  db.initAll();
  const rows = db.listSeries(dbName);
  if (!rows.length) return console.log(`📭 Sin series en ${dbName}`);
  console.log(`\n🎬 ${rows.length} series en ${dbName}:\n`);
  for (const r of rows) {
    const display = (r.series_display || r.series_name || '?').slice(0, 55).padEnd(57);
    console.log(`   ${display} ${String(r.count).padStart(5)} | ${formatSize(r.total_size).padStart(10)} | ${r.kind || '-'}`);
  }
}

module.exports = {
  login, scan, search, download, downloadAll,
  stats, channels, listFiles, listSeries,
  formatSize, makeLink, iconFor,
};
