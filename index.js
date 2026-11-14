#!/usr/bin/env node
/**
 * index.js — Punto de entrada CLI de TG Indexer
 *
 * Solo enruta los comandos. La lógica real vive en main.js.
 * Cada comando carga main.js perezosamente (lazy require),
 * así podemos ir construyendo el proyecto por pasos.
 */
require('dotenv').config();
const { Command } = require('commander');

const program = new Command();

program
  .name('tg')
  .description('🔍 Indexa, busca y descarga archivos de canales de Telegram')
  .version('0.1.0', '-v, --version')
  .showHelpAfterError('(usa --help para más info)');

// ────────────────────────────────────────────────────────────
// AUTENTICACIÓN
// ────────────────────────────────────────────────────────────
program
  .command('login')
  .description('Iniciar sesión en Telegram (crea .session)')
  .action(async () => {
    const main = require('./main');
    await main.login();
  });

// ────────────────────────────────────────────────────────────
// INDEXACIÓN
// ────────────────────────────────────────────────────────────
program
  .command('index')
  .description('Indexar archivos de todos tus canales/grupos')
  .option('-c, --channel <chat>', 'Solo indexar este chat (@user, ID o título)')
  .option('--reset', 'Resetear progreso de este chat (o de todos si sin -c)')
  .option('--force', 'Re-indexar desde cero ignorando progreso')
  .option('--max-msgs <n>', 'Máx. mensajes a escanear por chat (0 = sin límite)', '0')
  .action(async (opts) => {
    const main = require('./main');
    await main.index(opts);
  });

// ────────────────────────────────────────────────────────────
// BÚSQUEDA
// ────────────────────────────────────────────────────────────
program
  .command('search [query...]')
  .description('Buscar archivos en el índice')
  .option('-l, --limit <n>', 'Máx. resultados', '20')
  .option('-c, --category <cat>', 'Filtrar por categoría (libros|videos|audio|imagenes|comprimidos|software|documentos|juegos|otros)')
  .option('-e, --ext <ext>', 'Filtrar por extensión (pdf, mp4, mp3...)')
  .option('--min-size <mb>', 'Tamaño mínimo en MB', '0')
  .option('--max-size <mb>', 'Tamaño máximo en MB (0 = sin límite)', '0')
  .option('-o, --offset <n>', 'Paginación', '0')
  .action(async (query, opts) => {
    const main = require('./main');
    await main.search(query.join(' '), opts);
  });

// ────────────────────────────────────────────────────────────
// DESCARGA
// ────────────────────────────────────────────────────────────
program
  .command('download <id>')
  .description('Descargar un archivo por ID del índice')
  .option('-o, --out <dir>', 'Carpeta destino', './downloads')
  .option('--force', 'Sobrescribir si ya existe')
  .action(async (id, opts) => {
    const main = require('./main');
    await main.download(parseInt(id), opts);
  });

program
  .command('download-all [query...]')
  .description('Descargar todos los archivos que coincidan con la búsqueda')
  .option('-c, --category <cat>', 'Filtrar por categoría')
  .option('-e, --ext <ext>', 'Filtrar por extensión')
  .option('-l, --limit <n>', 'Máx. archivos a descargar', '10')
  .option('-o, --out <dir>', 'Carpeta destino', './downloads')
  .option('--force', 'Sobrescribir si ya existe')
  .action(async (query, opts) => {
    const main = require('./main');
    await main.downloadAll(query.join(' '), opts);
  });

// ────────────────────────────────────────────────────────────
// CONSULTAS / INFO
// ────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Estadísticas del índice (total archivos, tamaño, top canales)')
  .action(async () => {
    const main = require('./main');
    await main.stats();
  });

program
  .command('channels')
  .description('Listar canales/grupos indexados')
  .action(async () => {
    const main = require('./main');
    await main.channels();
  });

program
  .command('files')
  .description('Listar archivos del índice')
  .option('-c, --channel <chat>', 'Filtrar por canal (@user, título o chat_id)')
  .option('--category <cat>', 'Filtrar por categoría')
  .option('-e, --ext <ext>', 'Filtrar por extensión')
  .option('-l, --limit <n>', 'Límite', '50')
  .option('-o, --offset <n>', 'Paginación', '0')
  .action(async (opts) => {
    const main = require('./main');
    await main.listFiles(opts);
  });

//───────────────────────────────────────────────────────>
//AUTENTICACION CON WHATSAPP
//───────────────────────────────────────────────────────>
program
  .command('wa-connect')
  .description('Conectar WhatsApp con pairing code (8 dígitos)')
  .option('-p, --phone <numero>', 'Número con código país (ej: 5351092358)')
  .action(async (opts) => {
    const { startWhatsApp } = require('./connection');
    await startWhatsApp({
      phoneNumber: opts.phone,
      onMessage: async (msg, sock) => {
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || '';
        console.log(`💬 [${msg.key.remoteJid}] ${text}`);
      },
    });
  });


program
  .command('categories')
  .description('Listar categorías disponibles y sus extensiones')
  .action(() => {
    const { listCategories } = require('./categorizer');
    listCategories().forEach(c => {
      console.log(`\n${c.icon}  ${c.name.toUpperCase()}`);
      console.log(`   ${c.extensions.join(', ')}`);
    });
  });

// ────────────────────────────────────────────────────────────
// EJECUCIÓN
// ────────────────────────────────────────────────────────────
program.parseAsync(process.argv).catch(err => {
  console.error('\n❌ Error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
