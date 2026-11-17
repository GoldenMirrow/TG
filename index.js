#!/usr/bin/env node
/**
 * index.js — CLI unificado (Telegram + Identifier + WhatsApp + Web)
 */
require('dotenv').config();
const { Command } = require('commander');
const program = new Command();

program
  .name('tg')
  .description('🔍 Indexa mangas/videos de Telegram, identifica con IA, busca, descarga')
  .version('2.1.0', '-v, --version')
  .showHelpAfterError('(usa --help para más info)');

// ──────────────── AUTH ────────────────
program.command('login')
  .description('Iniciar sesión en Telegram (crea .session)')
  .action(async () => {
    const m = require('./modules/telegram-indexer');
    await m.login();
  });

// ──────────────── SCAN ────────────────
program.command('scan')
  .description("Escanear canales (mode: 'force' | 'new')")
  .argument('[mode]', "force (desde cero) | new (desde lastScan)", 'new')
  .option('-c, --channel <chat>', 'Solo este chat')
  .option('--reset', 'Borrar progreso antes de escanear')
  .option('--max-msgs <n>', 'Máx. mensajes por chat', '0')
  .action(async (mode, opts) => {
    const m = require('./modules/telegram-indexer');
    await m.scan({ ...opts, mode });
  });

program.command('set-date <iso>')
  .description('Cambiar fecha base scanFrom en data.json')
  .action((iso) => {
    const { setScanFrom } = require('./modules/scanner');
    console.log(`✅ scanFrom = ${setScanFrom(iso)}`);
  });

// ──────────────── SEARCH ────────────────
program.command('search [query...]')
  .description('Buscar en todas las DBs (o con --db)')
  .option('-d, --db <name>', 'DB: mangas|videos|otros')
  .option('-l, --limit <n>', 'Límite', '20')
  .option('-c, --category <cat>', 'Categoría')
  .option('-e, --ext <ext>', 'Extensión')
  .option('-s, --series <name>', 'Serie')
  .option('--kind <kind>', 'anime_movie|anime_series|movie|serie')
  .option('--min-size <mb>', 'Tamaño mín. MB', '0')
  .option('--max-size <mb>', 'Tamaño máx. MB', '0')
  .option('-o, --offset <n>', 'Offset', '0')
  .action(async (query, opts) => {
    const m = require('./modules/telegram-indexer');
    await m.search(query.join(' '), opts);
  });

// ──────────────── THUMBNAILS ────────────────
program.command('thumbs')
  .description('Indexar thumbnails de todos los archivos')
  .option('-d, --db <name>', 'DB: videos|mangas|otros|all', 'all')
  .option('-l, --limit <n>', 'Máx. thumbnails (0 = sin límite)', '0')
  .option('--delay <ms>', 'Pausa entre descargas', '200')
  .option('--force', 'Re-descargar aunque ya exista')
  .action(async (opts) => {
    const { indexThumbnails } = require('./modules/thumbnails');
    await indexThumbnails({
      db: opts.db,
      limit: parseInt(opts.limit, 10),
      delayMs: parseInt(opts.delay, 10),
      force: opts.force,
    });
  });

// ──────────────── DOWNLOAD ────────────────
program.command('download <db> <id>')
  .description('Descargar archivo (db: mangas|videos|otros|auto)')
  .option('-o, --out <dir>', 'Carpeta destino', './downloads')
  .option('--force', 'Sobrescribir')
  .action(async (db, id, opts) => {
    const m = require('./modules/telegram-indexer');
    await m.download(db, parseInt(id), opts);
  });

program.command('download-all [query...]')
  .description('Descargar todos los que coincidan')
  .option('-d, --db <name>', 'DB', 'auto')
  .option('-c, --category <cat>', 'Categoría')
  .option('-e, --ext <ext>', 'Extensión')
  .option('-l, --limit <n>', 'Límite', '10')
  .option('-o, --out <dir>', 'Carpeta', './downloads')
  .option('--force', 'Sobrescribir')
  .action(async (query, opts) => {
    const m = require('./modules/telegram-indexer');
    await m.downloadAll(query.join(' '), opts);
  });

// ──────────────── INFO ────────────────
program.command('stats')
  .description('Estadísticas de las 3 DBs')
  .action(async () => {
    const m = require('./modules/telegram-indexer');
    await m.stats();
  });

program.command('channels')
  .description('Canales indexados')
  .action(async () => {
    const m = require('./modules/telegram-indexer');
    await m.channels();
  });

program.command('files')
  .description('Listar archivos')
  .option('-d, --db <name>', 'DB', 'mangas')
  .option('-c, --channel <chat>', 'Canal')
  .option('--category <cat>', 'Categoría')
  .option('-e, --ext <ext>', 'Extensión')
  .option('-l, --limit <n>', 'Límite', '50')
  .option('-o, --offset <n>', 'Offset', '0')
  .action(async (opts) => {
    const m = require('./modules/telegram-indexer');
    await m.listFiles(opts);
  });

program.command('series [chat]')
  .description('Series de mangas (con chat) o videos (sin chat)')
  .option('-d, --db <name>', 'DB', 'videos')
  .option('--top <n>', 'Top N', '50')
  .option('--min <n>', 'Mínimo archivos', '1')
  .action(async (chat, opts) => {
    if (chat) {
      const { runSeriesCLI } = require('./modules/series');
      await runSeriesCLI(chat, opts);
    } else {
      const m = require('./modules/telegram-indexer');
      await m.listSeries(opts.db);
    }
  });

program.command('categories')
  .description('Categorías y extensiones')
  .action(() => {
    const { listCategories } = require('./modules/categorizer');
    listCategories().forEach(c => {
      console.log(`\n${c.icon}  ${c.name.toUpperCase()}`);
      console.log(`   ${c.extensions.join(', ')}`);
    });
  });

// ──────────────── LINK ────────────────
program.command('link <id>')
  .description('Ver enlace de Telegram de un archivo por ID')
  .option('-d, --db <name>', 'DB específica (mangas|videos|otros)')
  .action((id, opts) => {
    const db = require('./db');
    db.initAll();

    const fileId = parseInt(id, 10);
    let row, dbName;

    if (opts.db) {
      row = db.getFile(opts.db, fileId);
      dbName = opts.db;
    } else {
      const found = db.findFile(fileId);
      if (found) { row = found.row; dbName = found.db; }
    }

    if (!row) {
      console.error(`❌ No existe archivo con ID ${id}`);
      process.exit(1);
    }

    const sizeMB = (row.file_size / 1024 / 1024).toFixed(2);
    const isPrivate = !row.chat_username;
    const link = isPrivate
      ? `https://t.me/c/${row.chat_id}/${row.message_id}`
      : `https://t.me/${row.chat_username}/${row.message_id}`;

    console.log(`\n📄 ${row.file_name}`);
    console.log(`   DB:        ${dbName}#${row.id}`);
    console.log(`   Categoría: ${row.category}${row.extension ? '.' + row.extension : ''}`);
    console.log(`   Tamaño:    ${sizeMB} MB (${row.file_size} bytes)`);
    console.log(`   Canal:     ${row.chat_title || '?'} ${isPrivate ? '(privado)' : '@' + row.chat_username}`);
    console.log(`   Msg ID:    ${row.message_id}`);
    console.log(`\n🔗 ${link}`);
    if (isPrivate) console.log(`   ⚠️  Canal privado: solo abre si estás dentro del canal.`);
    console.log('');
  });

// ──────────────── IDENTIFIER ────────────────
program.command('synthetic')
  .description('Listar archivos con nombres sintéticos (video_123, file_456...)')
  .option('-d, --db <name>', 'DB: videos|mangas|all', 'all')
  .option('-c, --category <cat>', 'Filtrar categoría')
  .option('-e, --ext <ext>', 'Filtrar extensión')
  .option('-l, --limit <n>', 'Máx. a mostrar', '50')
  .action((opts) => {
    const { listSynthetic } = require('./modules/identifier');
    listSynthetic({
      db: opts.db,
      category: opts.category,
      ext: opts.ext,
      limit: parseInt(opts.limit, 10),
    });
  });

program.command('identify <db> <id>')
  .description('Identificar UN archivo con Gemini y renombrarlo')
  .option('--no-apply', 'Solo mostrar resultado, no tocar la DB')
  .option('--rename-on-disk', 'También renombrar el archivo descargado')
  .action(async (dbName, id, opts) => {
    const { identify } = require('./modules/identifier');
    try {
      await identify(dbName, parseInt(id, 10), opts);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

program.command('identify-batch <db>')
  .description('Identificar varios archivos de una DB en lote')
  .option('-c, --category <cat>', 'Filtrar por categoría')
  .option('-e, --ext <ext>', 'Filtrar por extensión')
  .option('-l, --limit <n>', 'Máx. archivos', '10')
  .option('--delay <ms>', 'Pausa entre requests (rate limit)', '4500')
  .option('--no-apply', 'Solo mostrar resultado')
  .option('--rename-on-disk', 'Renombrar archivos en disco')
  .action(async (dbName, opts) => {
    const { identifyBatch } = require('./modules/identifier');
    try {
      await identifyBatch(dbName, {
        category: opts.category,
        extension: opts.ext,
      }, {
        apply: opts.apply,
        renameOnDisk: opts.renameOnDisk,
        limit: parseInt(opts.limit, 10),
        delayMs: parseInt(opts.delay, 10),
      });
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

program.command('identify-all')
  .description('Identificar TODOS los archivos con nombre sintético')
  .option('-d, --db <name>', 'DB: videos|mangas|all', 'all')
  .option('-c, --category <cat>', 'Filtrar categoría')
  .option('-e, --ext <ext>', 'Filtrar extensión')
  .option('-l, --limit <n>', 'Máx. archivos (0 = sin límite)', '0')
  .option('--delay <ms>', 'Pausa entre requests', '4500')
  .option('--force', 'Procesar TODOS (no solo sintéticos)')
  .option('--no-apply', 'Solo mostrar, no tocar la DB')
  .option('--rename-on-disk', 'Renombrar archivos descargados en disco')
  .action(async (opts) => {
    const { identifyAll } = require('./modules/identifier');
    try {
      await identifyAll({
        db: opts.db,
        category: opts.category,
        ext: opts.ext,
        limit: parseInt(opts.limit, 10),
        delayMs: parseInt(opts.delay, 10),
        force: opts.force,
        apply: opts.apply,
        renameOnDisk: opts.renameOnDisk,
      });
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  });

// ──────────────── WHATSAPP ────────────────
program.command('wa-bot')
  .description('Bot WhatsApp')
  .action(() => { require('./modules/wa-bot'); });

program.command('wa-cli')
  .description('REPL WhatsApp')
  .action(() => { require('./connection/wa-cli'); });

program.command('wa-connect')
  .description('Conectar WhatsApp con pairing code')
  .option('-p, --phone <numero>', 'Número')
  .action(async (opts) => {
    const { startWhatsApp } = require('./connection/whatsapp');
    await startWhatsApp({
      phoneNumber: opts.phone,
      onMessage: async (msg) => {
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        console.log(`💬 [${msg.key.remoteJid}] ${text}`);
      },
    });
  });

// ──────────────── WEB ────────────────
program.command('web')
  .description('Servidor web (interfaz gráfica)')
  .option('-p, --port <n>', 'Puerto', '3000')
  .option('-h, --host <host>', 'Host (127.0.0.1 = solo local)', '127.0.0.1')
  .action((opts) => {
    process.env.WEB_PORT = opts.port;
    process.env.WEB_HOST = opts.host;
    require('./web/server');
  });

// ──────────────── EJECUCIÓN ────────────────
program.parseAsync(process.argv).catch(err => {
  console.error('\n❌ Error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
