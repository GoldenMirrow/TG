#!/usr/bin/env node
/**
 * modules/wa-bot.js — Bot WhatsApp con multi-DB.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { startWhatsApp, stopWhatsApp } = require('../connection/whatsapp');
const db = require('../db');
const { sendButtons, sendInteractiveMessage } = require('gifted-btns');

const MAX_FILE_MB   = 100;
const MAX_RESULTS   = 50;
const PER_PAGE      = 10;
const MAX_BTN_TITLE = 24;
const TEMP_DIR      = path.join(__dirname, '..', 'downloads', 'wa_temp');

// ────────────────────────────────────────────────────────────
// CATEGORÍAS → DB destino
// ────────────────────────────────────────────────────────────
const CATEGORIAS = {
  anime:      { label: '🎬 Anime',      db: 'videos', category: 'videos',     exts: null },
  manga:      { label: '📚 Manga',      db: 'mangas', category: 'libros',     exts: ['pdf','cbz','cbr','cb7'] },
  libros:     { label: '📖 Libros',     db: 'mangas', category: 'libros',     exts: null },
  software:   { label: '💿 Software',   db: 'otros',  category: 'software',   exts: null },
  audio:      { label: '🎵 Audio',      db: 'otros',  category: 'audio',      exts: null },
  juegos:     { label: '🎮 Juegos',     db: 'otros',  category: 'juegos',     exts: null },
  documentos: { label: '📄 Documentos', db: 'otros',  category: 'documentos', exts: null },
};

// ────────────────────────────────────────────────────────────
// ESTADO
// ────────────────────────────────────────────────────────────
const state = new Map();
function getState(jid) {
  if (!state.has(jid)) {
    state.set(jid, {
      botEnabled: false, category: null, query: '',
      page: 0, results: [], lastListKey: null, lastNavKey: null,
    });
  }
  return state.get(jid);
}

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function shortName(fileName, max = MAX_BTN_TITLE) {
  const noExt = fileName.replace(/\.[a-z0-9]{2,8}$/i, '');
  return noExt.length <= max ? noExt : noExt.slice(0, max - 1) + '…';
}

function extraerTexto(msg) {
  const m = msg.message;
  if (!m) return '';
  return m.conversation || m.extendedTextMessage?.text
    || m.imageMessage?.caption || m.videoMessage?.caption || '';
}

function parseCommand(text) {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const sendMatch = t.match(/^\/send(\d+)$/i);
  if (sendMatch) return { cmd: 'send', args: sendMatch[1] };
  const match = t.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { cmd: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

// ────────────────────────────────────────────────────────────
// DELETE / SEARCH / PAGINACIÓN
// ────────────────────────────────────────────────────────────
async function deleteOldPage(sock, jid, s) {
  if (s.lastListKey) { try { await sock.sendMessage(jid, { delete: s.lastListKey }); } catch {} s.lastListKey = null; }
  if (s.lastNavKey)  { try { await sock.sendMessage(jid, { delete: s.lastNavKey  }); } catch {} s.lastNavKey  = null; }
}

function buscar(query, categoriaKey) {
  const cat = CATEGORIAS[categoriaKey];
  if (!cat) return [];
  db.initAll();
  let rows = db.searchFiles(cat.db, {
    query, category: cat.category, limit: MAX_RESULTS * 2, offset: 0,
  });
  if (cat.exts) rows = rows.filter(r => cat.exts.includes(r.extension));
  return rows.slice(0, MAX_RESULTS).map(r => ({ ...r, _db: cat.db }));
}

function getPagina(resultados, page) {
  const pages = Math.ceil(resultados.length / PER_PAGE) || 1;
  const validPage = Math.max(0, Math.min(page, pages - 1));
  const items = resultados.slice(validPage * PER_PAGE, (validPage + 1) * PER_PAGE);
  return { items, page: validPage, pages, total: resultados.length };
}

// ────────────────────────────────────────────────────────────
// ENVIAR PÁGINA / MENÚ
// ────────────────────────────────────────────────────────────
async function enviarPaginaResultados(sock, jid, s) {
  const { items, page, pages, total } = getPagina(s.results, s.page);
  s.page = page;

  if (!items.length) { await sock.sendMessage(jid, { text: '❌ Sin resultados' }); return; }

  let bodyText = `🔍 *"${s.query}"* en ${CATEGORIAS[s.category].label}\n`;
  bodyText += `Página *${page + 1}/${pages}* — *${total}* resultado(s)\n\n`;

  items.forEach((r, i) => {
    const globalIdx = page * PER_PAGE + i + 1;
    bodyText += `*${globalIdx}.* ${r.file_name}\n   📦 ${fmtSize(r.file_size)}\n`;
    if (r.kind) bodyText += `   🎬 ${r.kind}${r.series_display ? ' — ' + r.series_display : ''}\n`;
  });
  bodyText += `\n👉 Despliega *Ver archivos* para descargar.`;
  if (pages > 1) bodyText += `\nUsa ⬅️ ➡️ o /next /after para navegar.`;

  const rows = items.map((r) => ({
    header: fmtSize(r.file_size),
    title: shortName(r.file_name, 24),
    description: (r.chat_title || '').slice(0, 72),
    id: `send_${r.id}`,
  }));

  try {
    const result = await sendInteractiveMessage(sock, jid, {
      text: bodyText,
      footer: `Página ${page + 1}/${pages} — ${total} resultados`,
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: '📂 Ver archivos',
          sections: [{ title: 'Resultados', rows }],
        }),
      }],
    });
    s.lastListKey = result?.key || null;
  } catch (e) {
    console.error('⚠️ Error lista:', e.message);
    const fallback = bodyText + '\n\n' + items.map((r, i) => `/send${page * PER_PAGE + i + 1}`).join(' ');
    const result = await sock.sendMessage(jid, { text: fallback });
    s.lastListKey = result?.key || null;
  }

  const navButtons = [];
  if (page > 0) navButtons.push({ id: 'nav_after', text: '⬅️ Anterior' });
  if (page < pages - 1) navButtons.push({ id: 'nav_next', text: '➡️ Siguiente' });

  if (navButtons.length > 0) {
    try {
      const result = await sendButtons(sock, jid, {
        title: `Página ${page + 1}/${pages}`,
        text: 'Navegar:',
        buttons: navButtons,
      });
      s.lastNavKey = result?.key || null;
    } catch (e) { console.error('⚠️ Error nav:', e.message); }
  }
}

async function enviarMenu(sock, jid) {
  const buttons = Object.entries(CATEGORIAS).map(([key, c]) => ({ id: `cat_${key}`, text: c.label }));
  try {
    await sendButtons(sock, jid, {
      title: '📂 Categorías',
      text: 'Selecciona una categoría para buscar:',
      footer: 'También puedes usar /cat <categoría>',
      buttons,
    });
  } catch (e) { console.error('⚠️ Error menú:', e.message); }

  const opciones = Object.entries(CATEGORIAS).map(([k, c]) => `• ${c.label} → /cat ${k}`).join('\n');
  await sock.sendMessage(jid, { text: `*Si los botones no aparecen:*\n\n${opciones}` });
}

// ────────────────────────────────────────────────────────────
// ENVIAR ARCHIVO
// ────────────────────────────────────────────────────────────
async function enviarArchivo(sock, jid, row) {
  const sizeMB = (row.file_size || 0) / 1024 / 1024;
  if (sizeMB > MAX_FILE_MB) {
    await sock.sendMessage(jid, {
      text: `⚠️ Archivo demasiado grande (${fmtSize(row.file_size)}).\nLímite: ${MAX_FILE_MB} MB.\n\nDescarga manual:\n\`node index.js download ${row._db || 'auto'} ${row.id}\``,
    });
    return;
  }

  await sock.sendMessage(jid, {
    text: `⬇️ Descargando *${row.file_name}* (${fmtSize(row.file_size)})...`,
  });

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const safeName = row.file_name.replace(/[^\w.\-]/g, '_');
  const tempPath = path.join(TEMP_DIR, `${row.id}_${safeName}`);

  try {
    const { withClient, resolveEntity, downloadMedia } = require('../connection/telegram');
    await withClient(async (client) => {
      const entity = await resolveEntity(client, row);
      await downloadMedia(client, entity, row.message_id, tempPath, () => {});
    });
    if (!fs.existsSync(tempPath)) throw new Error('Descarga de Telegram falló');

    const buffer = fs.readFileSync(tempPath);
    const ext = path.extname(row.file_name).toLowerCase();
    const payload = {};

    if (['.mp4','.mkv','.avi','.mov','.webm','.m4v','.3gp'].includes(ext)) {
      payload.video = buffer; payload.caption = row.file_name; payload.mimetype = 'video/mp4';
    } else if (['.mp3','.m4a','.ogg','.opus','.wav','.flac'].includes(ext)) {
      payload.audio = buffer; payload.mimetype = 'audio/mp4';
    } else if (['.jpg','.jpeg','.png','.webp'].includes(ext)) {
      payload.image = buffer; payload.caption = row.file_name;
    } else {
      payload.document = buffer; payload.fileName = row.file_name; payload.mimetype = 'application/octet-stream';
    }

    await sock.sendMessage(jid, payload);
    await sock.sendMessage(jid, { text: `✅ *${row.file_name}* enviado\n\n_/list para ver la lista otra vez_` });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` });
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

async function enviarArchivoPorId(sock, jid, dbid) {
  db.initAll();
  const hit = db.findFile(dbid);
  if (!hit) { await sock.sendMessage(jid, { text: `❌ Archivo #${dbid} no encontrado` }); return; }
  hit.row._db = hit.db;
  await enviarArchivo(sock, jid, hit.row);
}

// ────────────────────────────────────────────────────────────
// COMANDOS
// ────────────────────────────────────────────────────────────
async function handleCommand(sock, jid, text) {
  const parsed = parseCommand(text);
  if (!parsed) return;
  const s = getState(jid);

  if (parsed.cmd === 'help') {
    await sock.sendMessage(jid, {
      text: `🤖 *Comandos*\n\n` +
        `*/on_bot* → activar\n*/off_bot* → desactivar\n` +
        `*/cat* <categoría> → seleccionar\n*/search* <término> → buscar\n` +
        `*/next* / */after* → paginar\n*/list* → repetir página\n` +
        `*/send<N>* → enviar por número\n*/help* → ayuda\n\n` +
        `*Categorías:* ${Object.keys(CATEGORIAS).join(', ')}`,
    });
    return;
  }

  if (parsed.cmd === 'on_bot') {
    s.botEnabled = true;
    await sock.sendMessage(jid, { text: '✅ Bot activado' });
    await enviarMenu(sock, jid);
    return;
  }

  if (!s.botEnabled) {
    await sock.sendMessage(jid, { text: '⚠️ Bot desactivado. Escribe /on_bot' });
    return;
  }

  if (parsed.cmd === 'off_bot') {
    s.botEnabled = false; s.category = null; s.results = []; s.page = 0;
    await deleteOldPage(sock, jid, s);
    await sock.sendMessage(jid, { text: '👋 Bot desactivado' });
    return;
  }

  if (parsed.cmd === 'cat') {
    const key = parsed.args.toLowerCase().split(/\s+/)[0];
    if (!CATEGORIAS[key]) {
      await sock.sendMessage(jid, { text: `❌ Categoría inválida: "${key}"\nUsa: ${Object.keys(CATEGORIAS).join(', ')}` });
      return;
    }
    s.category = key;
    await sock.sendMessage(jid, { text: `✅ Categoría *${CATEGORIAS[key].label}*\n\nAhora usa:\n/search <término>` });
    return;
  }

  if (parsed.cmd === 'search') {
    if (!s.category) { await sock.sendMessage(jid, { text: '⚠️ Primero selecciona categoría' }); return; }
    const query = parsed.args;
    if (!query) { await sock.sendMessage(jid, { text: 'Uso: /search <término>' }); return; }

    await deleteOldPage(sock, jid, s);
    const results = buscar(query, s.category);
    s.results = results; s.query = query; s.page = 0;

    if (!results.length) {
      await sock.sendMessage(jid, { text: `❌ Sin resultados para "${query}" en ${CATEGORIAS[s.category].label}` });
      return;
    }
    await enviarPaginaResultados(sock, jid, s);
    return;
  }

  if (parsed.cmd === 'list') {
    if (!s.results.length) { await sock.sendMessage(jid, { text: '⚠️ Haz /search primero' }); return; }
    await deleteOldPage(sock, jid, s);
    await enviarPaginaResultados(sock, jid, s);
    return;
  }

  if (parsed.cmd === 'next') {
    if (!s.results.length) { await sock.sendMessage(jid, { text: '⚠️ Haz /search primero' }); return; }
    const { pages } = getPagina(s.results, s.page);
    if (s.page >= pages - 1) { await sock.sendMessage(jid, { text: '📄 Última página' }); return; }
    await deleteOldPage(sock, jid, s);
    s.page++;
    await enviarPaginaResultados(sock, jid, s);
    return;
  }

  if (parsed.cmd === 'after') {
    if (!s.results.length) { await sock.sendMessage(jid, { text: '⚠️ Haz /search primero' }); return; }
    if (s.page <= 0) { await sock.sendMessage(jid, { text: '📄 Primera página' }); return; }
    await deleteOldPage(sock, jid, s);
    s.page--;
    await enviarPaginaResultados(sock, jid, s);
    return;
  }

  if (parsed.cmd === 'send') {
    const n = parseInt(parsed.args, 10);
    if (!n || n < 1) { await sock.sendMessage(jid, { text: 'Uso: /send<N>' }); return; }
    const row = s.results[n - 1];
    if (!row) { await sock.sendMessage(jid, { text: `❌ No existe #${n}. Total: ${s.results.length}` }); return; }
    await deleteOldPage(sock, jid, s);
    await enviarArchivo(sock, jid, row);
    return;
  }

  await sock.sendMessage(jid, { text: `❓ Comando desconocido: /${parsed.cmd}` });
}

// ────────────────────────────────────────────────────────────
// INTERACTIVE REPLIES
// ────────────────────────────────────────────────────────────
async function handleInteractiveReply(sock, jid, selectedId) {
  if (!selectedId) return false;
  const s = getState(jid);

  if (selectedId.startsWith('cat_')) {
    const key = selectedId.slice(4);
    if (!CATEGORIAS[key]) { await sock.sendMessage(jid, { text: `❌ Categoría inválida: "${key}"` }); return true; }
    s.botEnabled = true; s.category = key;
    await sock.sendMessage(jid, { text: `✅ Categoría *${CATEGORIAS[key].label}*\n\nAhora usa:\n/search <término>` });
    return true;
  }

  if (selectedId.startsWith('send_')) {
    const dbid = parseInt(selectedId.slice(5), 10);
    if (!dbid) { await sock.sendMessage(jid, { text: '❌ ID inválido' }); return true; }
    await deleteOldPage(sock, jid, s);
    const inResults = s.results.find(r => r.id === dbid);
    if (inResults) await enviarArchivo(sock, jid, inResults);
    else           await enviarArchivoPorId(sock, jid, dbid);
    return true;
  }

  if (selectedId === 'nav_next') {
    if (!s.results.length) return true;
    const { pages } = getPagina(s.results, s.page);
    if (s.page < pages - 1) { await deleteOldPage(sock, jid, s); s.page++; await enviarPaginaResultados(sock, jid, s); }
    return true;
  }

  if (selectedId === 'nav_after') {
    if (!s.results.length) return true;
    if (s.page > 0) { await deleteOldPage(sock, jid, s); s.page--; await enviarPaginaResultados(sock, jid, s); }
    return true;
  }

  return false;
}

// ────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────
async function main() {
  console.log('🤖 Iniciando bot de WhatsApp...\n');
  db.initAll();
  const sock = await startWhatsApp();

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout conectando (60s)')), 60000);
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'open') { clearTimeout(t); resolve(); }
    });
  });
  console.log('✅ Bot listo\n');

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue;

      try {
        const tbr = msg.message.templateButtonReplyMessage;
        if (tbr) { if (await handleInteractiveReply(sock, jid, tbr.selectedId)) continue; }

        const br = msg.message.buttonsResponseMessage;
        if (br) { if (await handleInteractiveReply(sock, jid, br.selectedButtonId)) continue; }

        const lr = msg.message.listResponseMessage;
        if (lr) { if (await handleInteractiveReply(sock, jid, lr.singleSelectReply?.selectedRowId)) continue; }

        const ir = msg.message.interactiveResponseMessage;
        if (ir) {
          let id = null;
          try {
            const params = JSON.parse(ir.nativeFlowResponseMessage?.paramsJson || '{}');
            id = params.id || params.selectedId || null;
          } catch {}
          if (id && await handleInteractiveReply(sock, jid, id)) continue;
        }

        const text = extraerTexto(msg);
        if (!text || !text.trim().startsWith('/')) continue;
        console.log(`📨 [${jid}] ${text.slice(0, 80)}`);
        await handleCommand(sock, jid, text);
      } catch (e) {
        console.error('❌ Error:', e.message);
        try { await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` }); } catch {}
      }
    }
  });

  process.on('SIGINT', async () => {
    console.log('\n👋 Cerrando...');
    await stopWhatsApp();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('💥', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});


