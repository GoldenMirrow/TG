#!/usr/bin/env node
/**
 * series.js — Agrupa los archivos de un canal por serie (manga, anime, etc.)
 *
 * Uso:
 *   node series.js <canal> [--top N] [--min-pdfs N]
 *
 * Ejemplos:
 *   node series.js @MangaBluease1080p
 *   node series.js @MangaBluease1080p --top 15
 *   node series.js @MangaBluease1080p --min-pdfs 3
 */
require('dotenv').config();
const db = require('./db');

const args = process.argv.slice(2);
const chat = args[0];
if (!chat) {
  console.error('Uso: node series.js <canal> [--top N] [--min-pdfs N]');
  console.error('Ej:  node series.js @MangaBluease1080p');
  process.exit(1);
}

const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 ? parseInt(args[topIdx + 1]) : 50;

const minIdx = args.indexOf('--min-pdfs');
const MIN_PDFS = minIdx >= 0 ? parseInt(args[minIdx + 1]) : 1;

db.initDb();
const d = db.initDb();

// Cargar archivos del canal (acepta @username, título o chat_id)
const c = String(chat).replace(/^@/, '');
const rows = d.prepare(`
  SELECT file_name, file_size, extension
  FROM files
  WHERE chat_username = ? OR chat_title = ? OR chat_id = ?
`).all(c, chat, c);

if (!rows.length) {
  console.error(`❌ No hay archivos indexados de "${chat}"`);
  console.error('   Verifica el nombre con: node index.js channels');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
// NORMALIZACIÓN: intenta extraer el nombre de la serie
// ────────────────────────────────────────────────────────────
function extractSeries(fileName) {
  let name = fileName;

  // 1. Quitar extensión
  name = name.replace(/\.[a-z0-9]{2,8}$/i, '');

  // 2. Quitar prefijos tipo [Bluease1080p], [Grupo], [Scan], [Editorial]
  name = name.replace(/^\s*\[[^\]]+\]\s*/g, '');
  name = name.replace(/^\s*\([^)]+\)\s*/g, '');

  // 3. Quitar "TOMO X", "Tomo X", "Vol. X", "Volume X", "v01"
  name = name.replace(/\s*\(?\b(tomo|vol(ume)?|v)\s*\d+\)?\b/gi, '');

  // 4. Quitar rangos de capítulos: "01-15", "1-5", "154-164"
  name = name.replace(/\s+\d+\s*[-–—]\s*\d+/g, '');

  // 5. Quitar capítulos simples al final: " 01", " 123"
  name = name.replace(/\s+\d+\s*$/g, '');

  // 6. Quitar sufijos tipo "(FINAL)", "(ESPECIAL)", "(TOMO7)"
  name = name.replace(/\s*\([^)]*\)\s*$/g, '');

  // 7. Quitar tags comunes: [Digital], [Español], (ESP), etc.
  name = name.replace(/\s*\[[^\]]*\]\s*$/g, '');

  // 8. Colapsar espacios múltiples
  name = name.replace(/\s+/g, ' ').trim();

  return name || fileName.replace(/\.[a-z0-9]{2,8}$/i, '');
}

// ────────────────────────────────────────────────────────────
// AGRUPAR
// ────────────────────────────────────────────────────────────
const series = {};

for (const r of rows) {
  const base = extractSeries(r.file_name);
  if (!series[base]) {
    series[base] = {
      count: 0,
      size: 0,
      extensions: new Set(),
      files: [],
    };
  }
  series[base].count++;
  series[base].size += r.file_size;
  if (r.extension) series[base].extensions.add(r.extension);
  series[base].files.push(r.file_name);
}

// ────────────────────────────────────────────────────────────
// ORDENAR Y FILTRAR
// ────────────────────────────────────────────────────────────
const sorted = Object.entries(series)
  .filter(([, info]) => info.count >= MIN_PDFS)
  .sort((a, b) => b[1].count - a[1].count || b[1].size - a[1].size);

// ────────────────────────────────────────────────────────────
// MOSTRAR
// ────────────────────────────────────────────────────────────
function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = b, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

console.log(`\n📚 ${sorted.length} series detectadas en "${chat}" (min ${MIN_PDFS} PDFs)\n`);
console.log('   ' + 'SERIE'.padEnd(50) + 'PDFs'.padStart(6) + '   TAMAÑO'.padStart(12));
console.log('   ' + '─'.repeat(50) + ' ' + '─'.repeat(6) + '   ' + '─'.repeat(10));

for (const [name, info] of sorted.slice(0, TOP)) {
  const exts = [...info.extensions].join(',').toUpperCase();
  console.log(
    `   ${name.slice(0, 48).padEnd(50)}${String(info.count).padStart(6)}   ${fmtSize(info.size).padStart(10)}  ${exts}`
  );
}

if (sorted.length > TOP) {
  console.log(`   ... y ${sorted.length - TOP} más (usa --top N para ver más)`);
}

// ────────────────────────────────────────────────────────────
// RESUMEN
// ────────────────────────────────────────────────────────────
const totalSeries = Object.keys(series).length;
const totalFiles = rows.length;
const totalSize = rows.reduce((a, r) => a + r.file_size, 0);

console.log('\n' + '─'.repeat(75));
console.log(`📊 ${totalFiles} archivos | ${totalSeries} series únicas | ${fmtSize(totalSize)} total`);
console.log('');
