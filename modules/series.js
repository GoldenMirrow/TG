/**
 * series.js — Helpers para agrupar mangas por serie + CLI (node index.js series).
 */
function extractSeriesName(fileName) {
  if (!fileName) return '';
  let name = String(fileName).replace(/\.[a-z0-9]{2,8}$/i, '');
  name = name.replace(/^\s*\[[^\]]+\]\s*/g, '');
  name = name.replace(/^\s*\([^)]+\)\s*/g, '');
  name = name.replace(/\s*\(?\b(tomo|vol(?:ume)?|v)\s*\.?\s*\d+\)?\b/gi, '');
  name = name.replace(/\s+\d+\s*[-–—]\s*\d+/g, '');
  name = name.replace(/\s+\d+\s*$/g, '');
  name = name.replace(/\s*\([^)]*\)\s*$/g, '');
  name = name.replace(/\s*\[[^\]]*\]\s*$/g, '');
  name = name.replace(/\s+/g, ' ').trim();
  return name || String(fileName).replace(/\.[a-z0-9]{2,8}$/i, '');
}

function extractVolume(fileName) {
  if (!fileName) return null;
  const m = String(fileName).match(/\b(?:tomo|vol(?:ume)?|v)\s*\.?\s*(\d{1,4})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

async function runSeriesCLI(chat, opts = {}) {
  const db = require('../db');
  db.initAll();
  const TOP = parseInt(opts.top, 10) || 50;
  const MIN = parseInt(opts.min, 10) || 1;

  const rows = db.searchFiles('mangas', { chat, limit: 999999, offset: 0 });
  if (!rows.length) {
    console.error(`❌ No hay mangas indexados de "${chat}"`);
    return;
  }

  const series = {};
  for (const r of rows) {
    const name = r.series_name || extractSeriesName(r.file_name);
    if (!series[name]) series[name] = { count: 0, size: 0, exts: new Set() };
    series[name].count++;
    series[name].size += r.file_size;
    if (r.extension) series[name].exts.add(r.extension);
  }

  const sorted = Object.entries(series)
    .filter(([, v]) => v.count >= MIN)
    .sort((a, b) => b[1].count - a[1].count || b[1].size - a[1].size);

  const fmtSize = (b) => {
    if (!b) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    let n = b, i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
  };

  console.log(`\n📚 ${sorted.length} series en "${chat}" (min ${MIN})\n`);
  console.log('   ' + 'SERIE'.padEnd(50) + 'PDFs'.padStart(6) + '   TAMAÑO'.padStart(12));
  console.log('   ' + '─'.repeat(50) + ' ' + '─'.repeat(6) + '   ' + '─'.repeat(10));

  for (const [name, info] of sorted.slice(0, TOP)) {
    const exts = [...info.exts].join(',').toUpperCase();
    console.log(`   ${name.slice(0,48).padEnd(50)}${String(info.count).padStart(6)}   ${fmtSize(info.size).padStart(10)}  ${exts}`);
  }
  if (sorted.length > TOP) console.log(`   ... y ${sorted.length - TOP} más (usa --top N)`);
}

module.exports = { extractSeriesName, extractVolume, runSeriesCLI };
