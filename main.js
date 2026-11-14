/**
 * main.js — Orquestador de comandos
 *
 * Este archivo NO contiene lógica de bajo nivel. Delega en:
 *   - telegram.js    → cliente GramJS, login, fetch de mensajes, descargas
 *   - db.js          → SQLite, queries, progreso
 *   - categorizer.js → clasificación por extensión/MIME + filtro isIndexable
 */
const path = require('path');
const fs = require('fs');

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────
const CATEGORY_ICONS = {
  libros: '📚', videos: '🎬', audio: '🎵', imagenes: '🖼️',
  comprimidos: '📦', software: '💿', documentos: '📄',
  juegos: '🎮', otros: '⚙️',
};

function iconFor(cat) {
  return CATEGORY_ICONS[cat] || '⚙️';
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function makeLink(row) {
  if (row.chat_username) {
    return `https://t.me/${row.chat_username}/${row.message_id}`;
  }
  return `https://t.me/c/${row.chat_id}/${row.message_id}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────
// LOGIN
// ────────────────────────────────────────────────────────────
async function login() {
  const { interactiveLogin } = require('./telegram');
  await interactiveLogin();
}

// ────────────────────────────────────────────────────────────
// INDEX
// ────────────────────────────────────────────────────────────
async function index(opts = {}) {
  const { withClient, getDialogs, getEntity } = require('./telegram');
  const db = require('./db');
  db.initDb();

  // ── Reset de progreso (necesita resolver el chat primero)
  if (opts.reset) {
    if (opts.channel) {
      await withClient(async (client) => {
        const e = await getEntity(client, opts.channel);
        db.resetProgressForChat(String(e.id));
        console.log(`🔄 Progreso reseteado para ${opts.channel}`);
      });
    } else {
      db.resetAllProgress();
      console.log('🔄 Progreso reseteado para TODOS los chats');
    }
    if (!opts.force) return;
  }

  const maxMsgs = parseInt(opts.maxMsgs) || 0;

  await withClient(async (client) => {
    // ── Resolver lista de entidades a indexar
    let targets = [];
    if (opts.channel) {
      const e = await getEntity(client, opts.channel);
      targets = [{ entity: e, title: e.title || e.username || String(e.id) }];
    } else {
      const dialogs = await getDialogs(client, 500);
      targets = dialogs
        .filter((d) => (d.isChannel || d.isGroup) && !d.isUser)
        .map((d) => ({
          entity: d.entity,
          title: d.title || d.entity?.username || String(d.entity?.id ?? '?'),
        }));
      console.log(`📂 ${targets.length} canales/grupos encontrados\n`);
    }

    let totalNew = 0;
    for (const { entity, title } of targets) {
      try {
        const n = await indexChannel(client, entity, title, { maxMsgs, force: opts.force });
        totalNew += n;
      } catch (e) {
        console.error(`⚠️  ${title}: ${e.message}`);
      }
    }
    console.log(`\n✅ Indexación completa. ${totalNew} archivos nuevos.`);
  });
}

//────────────────────────────────────────────────────────────
//INDEXAR CANALES
//────────────────────────────────────────────────────────────

async function indexChannel(client, entity, title, { maxMsgs, force }) {
  const { fetchMessages } = require('./telegram');
  const { categorize, isIndexable } = require('./categorizer');
  const db = require('./db');

  const chatId = String(entity.id);
  let lastId = force ? 0 : (db.getProgress(chatId) || 0);
  let scanned = 0, inserted = 0, skipped = 0, filtered = 0, noDoc = 0;

  console.log(`\n📥 ${title}`);
  if (lastId) console.log(`   (retomando desde msg ${lastId})`);

  while (true) {
    if (maxMsgs && scanned >= maxMsgs) {
      console.log(`   ⏹️  Límite de ${maxMsgs} msgs alcanzado`);
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

      // Sin document → mensaje de texto, foto, encuesta...
      if (!msg.document) {
        noDoc++;
        continue;
      }

      // Filtro: stickers, GIFs, videos redondos, notas de voz
      const check = isIndexable(msg);
      if (!check.ok) {
        filtered++;
        continue;
      }

      const doc = msg.document;
      const fileName = check.fileName || `file_${doc.id}`;
      const { category, extension } = categorize(fileName, doc.mimeType);

      // ⚠️ CRÍTICO: GramJS devuelve Long, no Number. Convertir SIEMPRE.
      const fileSize = doc.size != null ? Number(doc.size) : 0;
      const messageId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const accessHash = entity.accessHash != null
        ? entity.accessHash.toString()
        : null;

      const isNew = db.insertFile({
        chat_id: chatId,
        access_hash: accessHash,
        chat_title: title,
        chat_username: entity.username || null,
        message_id: messageId,
        file_name: fileName,
        file_size: fileSize,
        mime_type: doc.mimeType || null,
        category,
        extension,
      });
      isNew ? inserted++ : skipped++;
    }

    lastId = batch[batch.length - 1].id;
    db.setProgress(chatId, lastId);

    process.stdout.write(
      `\r   → ${scanned} msgs | ${inserted} nuevos | ${skipped} dup | ${filtered} filtrados | ${noDoc} texto   `
    );

    if (batch.length < limit) break;
    await sleep(500);
  }

  console.log(
    `\n   ✅ ${inserted} nuevos | ${skipped} duplicados | ${filtered} basura | ${noDoc} sin archivo`
  );
  return inserted;
}

// ────────────────────────────────────────────────────────────
// SEARCH
// ────────────────────────────────────────────────────────────
async function search(query, opts = {}) {
  const db = require('./db');
  db.initDb();

  const rows = db.searchFiles({
    query,
    category: opts.category,
    extension: opts.ext,
    minSize: parseInt(opts.minSize) || 0,
    maxSize: parseInt(opts.maxSize) || 0,
    limit: parseInt(opts.limit) || 20,
    offset: parseInt(opts.offset) || 0,
  });

  if (!rows.length) {
    console.log('❌ Sin resultados');
    return;
  }

  console.log(`\n🔎 ${rows.length} resultado(s):\n`);
  for (const r of rows) {
    const icon = iconFor(r.category);
    const ext = r.extension ? `.${r.extension}` : '';
    const dl = r.downloaded_path ? ' ✅ ya descargado' : '';
    console.log(`${icon} [#${r.id}] ${r.file_name}${dl}`);
    console.log(`   📦 ${formatSize(r.file_size)} | 📁 ${r.chat_title} | 🏷️  ${r.category}${ext}`);
    console.log(`   🔗 ${makeLink(r)}`);
    if (!r.downloaded_path) {
      console.log(`   ⬇️  node index.js download ${r.id}\n`);
    } else {
      console.log('');
    }
  }
}

// ────────────────────────────────────────────────────────────
// DOWNLOAD
// ────────────────────────────────────────────────────────────
async function download(id, opts = {}) {
  const db = require('./db');
  db.initDb();

  const row = db.getFile(id);
  if (!row) {
    console.error(`❌ No existe archivo con ID ${id}`);
    return;
  }

  const outDir = path.resolve(opts.out || './downloads');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, row.file_name);

  if (fs.existsSync(outPath) && !opts.force) {
    console.log(`✅ Ya existe: ${outPath}`);
    db.markDownloaded(id, outPath);
    return;
  }

  const { withClient, resolveEntity, downloadMedia } = require('./telegram');

  await withClient(async (client) => {
    const entity = await resolveEntity(client, row);
    console.log(`⬇️  ${row.file_name} (${formatSize(row.file_size)})`);

    let lastPct = -1;
    await downloadMedia(client, entity, row.message_id, outPath, (downloaded, total) => {
      const pct = total ? Math.floor((downloaded / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(
          `\r   ${pct}% - ${formatSize(downloaded)} / ${formatSize(total)}   `
        );
      }
    });

    console.log(`\n✅ Guardado: ${outPath}`);
    db.markDownloaded(id, outPath);
  });
}

// ────────────────────────────────────────────────────────────
// DOWNLOAD-ALL
// ────────────────────────────────────────────────────────────
async function downloadAll(query, opts = {}) {
  const db = require('./db');
  db.initDb();

  const rows = db.searchFiles({
    query,
    category: opts.category,
    extension: opts.ext,
    limit: parseInt(opts.limit) || 10,
    offset: 0,
  });

  if (!rows.length) {
    console.log('❌ Sin resultados');
    return;
  }

  console.log(`📦 Descargando ${rows.length} archivo(s)...\n`);
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      await download(r.id, opts);
      ok++;
    } catch (e) {
      console.error(`❌ [#${r.id}] ${r.file_name}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n✅ ${ok} descargados, ❌ ${fail} fallidos`);
}

// ────────────────────────────────────────────────────────────
// STATS
// ────────────────────────────────────────────────────────────
async function stats() {
  const db = require('./db');
  db.initDb();

  const total = db.getStats();
  const byCat = db.getStatsByCategory();
  const topChannels = db.getTopChannels(10);

  console.log(`\n📊 RESUMEN DEL ÍNDICE`);
  console.log(`   Total archivos: ${total.count}`);
  console.log(`   Tamaño total:   ${formatSize(total.total_size)}`);
  console.log(`   Canales:        ${total.channels}`);

  if (byCat.length) {
    console.log(`\n📂 POR CATEGORÍA:`);
    for (const c of byCat) {
      const name = (c.category || 'otros').padEnd(12);
      console.log(
        `   ${iconFor(c.category)} ${name} ${String(c.count).padStart(6)} archivos   ${formatSize(c.total_size)}`
      );
    }
  }

  if (topChannels.length) {
    console.log(`\n🏆 TOP CANALES:`);
    for (const c of topChannels) {
      console.log(`   ${(c.chat_title || '?').padEnd(30)} ${String(c.count).padStart(6)} archivos`);
    }
  }
}

// ────────────────────────────────────────────────────────────
// CHANNELS
// ────────────────────────────────────────────────────────────
async function channels() {
  const db = require('./db');
  db.initDb();

  const rows = db.listChannels();
  if (!rows.length) {
    console.log('📭 No hay canales indexados aún');
    return;
  }

  console.log(`\n📂 ${rows.length} canal(es) indexado(s):\n`);
  for (const r of rows) {
    const handle = r.chat_username ? `@${r.chat_username}` : '(privado)';
    console.log(`   📁 ${r.chat_title} ${handle}`);
    console.log(`      ${r.count} archivos | ${formatSize(r.total_size)} | último msg: ${r.last_msg_id || '-'}`);
  }
}

// ────────────────────────────────────────────────────────────
// FILES (listado simple)
// ────────────────────────────────────────────────────────────
async function listFiles(opts = {}) {
  const db = require('./db');
  db.initDb();

  const rows = db.searchFiles({
    query: '',
    chat: opts.channel,
    category: opts.category,
    extension: opts.ext,
    limit: parseInt(opts.limit) || 50,
    offset: parseInt(opts.offset) || 0,
  });

  if (!rows.length) return console.log('📭 Sin archivos');

  for (const r of rows) {
    console.log(
      `${iconFor(r.category)} [#${r.id}] ${r.file_name} (${formatSize(r.file_size)}) — ${r.chat_title}`
    );
  }
}

// ────────────────────────────────────────────────────────────
module.exports = {
  login, index, search, download, downloadAll, stats, channels, listFiles,
  formatSize, makeLink, iconFor,
};
