/**
 * categorizer.js — Clasificación de archivos por categoría + filtro de basura
 *
 * Sin dependencias. Usa 3 señales en cascada:
 *   1. Extensión del nombre
 *   2. MIME type (si el nombre es inútil)
 *   3. Palabras clave en el nombre (último recurso)
 *
 * Filtro `isIndexable` (descarta basura antes de tocar la DB):
 *   - Stickers, GIFs animados, videos redondos, notas de voz
 *   - Tamaño mínimo POR CATEGORÍA:
 *       • libros → 1 MB  (PDFs/CBZ/EPUB pueden ser pequeños)
 *       • videos → 10 MB (memes/clips → fuera)
 *       • resto  → 10 MB
 *   - Duración mínima para videos: 3 min (180 s) → corta trailers
 *
 * Umbrales configurables vía .env:
 *   MIN_VIDEO_MB=10
 *   MIN_VIDEO_SEC=180
 *   MIN_BOOK_MB=1
 *   MIN_GENERIC_MB=10
 */

// ────────────────────────────────────────────────────────────
// MAPA DE EXTENSIONES → CATEGORÍA
// ────────────────────────────────────────────────────────────
const EXT_MAP = {
  // 📚 LIBROS
  libros: [
    'pdf', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr', 'cb7',
    'chm', 'lit', 'pdb', 'prc', 'ibooks', 'oxps', 'xps', 'kfx', 'tpz', 'azw4',
  ],

  // 🎬 VIDEOS
  videos: [
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv',
    '3gp', '3g2', 'ts', 'mts', 'm2ts', 'vob', 'ogv', 'rm', 'rmvb', 'asf',
    'divx', 'f4v', 'hevc', 'h264', 'h265', 'vp9', 'av1', 'mxf', 'wtv', 'dvr-ms',
  ],

  // 🎵 AUDIO
  audio: [
    'mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'aiff', 'aif',
    'alac', 'ape', 'dsf', 'dff', 'mka', 'ra', 'amr', 'ac3', 'dts', 'mid', 'midi',
    'wv', 'tta', 'spx', 'caf',
  ],

  // 🖼️ IMÁGENES
  imagenes: [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'tif', 'ico',
    'heic', 'heif', 'avif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'psd', 'xcf',
    'jfif', 'pjpeg', 'pjp', 'apng', 'jxl',
  ],

  // 📦 COMPRIMIDOS
  comprimidos: [
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'tgz',
    'tbz2', 'txz', 'cab', 'arj', 'lzh', 'ace', 'z', 'z01', 'r00', 'r01', '001',
  ],

  // 💿 SOFTWARE
  software: [
    'apk', 'aab', 'ipa', 'exe', 'msi', 'msix', 'deb', 'rpm', 'pkg', 'dmg',
    'iso', 'img', 'appimage', 'flatpak', 'snap', 'run', 'bin', 'elf',
    'jar', 'war', 'whl', 'egg', 'xapk', 'apks', 'appx', 'msixbundle', 'crx',
  ],

  // 📄 DOCUMENTOS
  documentos: [
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
    'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'html', 'htm',
    'tex', 'log', 'nfo', 'srt', 'vtt', 'ass', 'ssa', 'sub', 'lrc', 'sql',
    'py', 'js', 'ts', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'go', 'rs',
  ],

  // 🎮 JUEGOS / ROMS
  juegos: [
    'nes', 'snes', 'smc', 'sfc', 'gba', 'gbc', 'gb', 'nds', '3ds', 'cia', 'nsp', 'xci',
    'wbfs', 'wad', 'n64', 'z64', 'v64', 'gen', 'smd', 'sms', 'gg', 'pce', 'sgx',
    'cue', 'rom', 'gcm', 'rvz', 'wud', 'wux', 'cso', 'pbp', 'chd', 'gdi', 'cdi',
    'md', '32x', 'a26', 'a52', 'a78', 'col', 'int', 'vec', 'ws', 'wsc', 'ngp', 'ngc',
  ],
};

// ────────────────────────────────────────────────────────────
// REVERSE INDEX (ext → categoría)
// ────────────────────────────────────────────────────────────
const EXT_TO_CAT = {};
for (const [cat, exts] of Object.entries(EXT_MAP)) {
  for (const e of exts) EXT_TO_CAT[e] = cat;
}

// ────────────────────────────────────────────────────────────
// UMBRALES (configurables por .env)
// ────────────────────────────────────────────────────────────
const MIN_VIDEO_MB   = parseFloat(process.env.MIN_VIDEO_MB)   || 10;
const MIN_VIDEO_SEC  = parseInt(process.env.MIN_VIDEO_SEC, 10) || 180;   // 3 min
const MIN_BOOK_MB    = parseFloat(process.env.MIN_BOOK_MB)    || 1;
const MIN_GENERIC_MB = parseFloat(process.env.MIN_GENERIC_MB) || 10;

function minSizeMBFor(category) {
  if (category === 'libros') return MIN_BOOK_MB;
  if (category === 'videos') return MIN_VIDEO_MB;
  return MIN_GENERIC_MB;
}

// ────────────────────────────────────────────────────────────
// MIME → categoría (fallback)
// ────────────────────────────────────────────────────────────
function categorizeByMime(mime) {
  if (!mime) return null;
  const m = mime.toLowerCase();

  if (m.startsWith('video/')) return 'videos';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'imagenes';

  if (m === 'application/pdf') return 'libros';
  if (m === 'application/epub+zip') return 'libros';
  if (m === 'application/x-mobipocket-ebook') return 'libros';
  if (m === 'application/vnd.amazon.ebook') return 'libros';

  if (m.includes('zip') || m.includes('rar') || m.includes('7z') ||
      m.includes('tar') || m.includes('gzip') || m.includes('compressed') ||
      m.includes('x-bzip') || m.includes('x-xz') || m.includes('zstd')) {
    return 'comprimidos';
  }

  if (m.includes('android.package') || m.includes('x-msdownload') ||
      m.includes('x-msi') || m.includes('x-deb') || m.includes('x-rpm') ||
      m.includes('x-apple.diskimage') || m.includes('x-iso9660') ||
      m.includes('x-executable') || m.includes('x-sharedlib')) {
    return 'software';
  }

  if (m.startsWith('text/') ||
      m.includes('word') || m.includes('excel') || m.includes('spreadsheet') ||
      m.includes('powerpoint') || m.includes('presentation') ||
      m.includes('opendocument') || m.includes('json') || m.includes('xml') ||
      m.includes('rtf')) {
    return 'documentos';
  }

  return null;
}

// ────────────────────────────────────────────────────────────
// HEURÍSTICA POR NOMBRE (último recurso)
// ────────────────────────────────────────────────────────────
function normalizeName(name) {
  return name.toLowerCase().replace(/[._\-]+/g, ' ');
}

const NAME_HINTS = [
  { cat: 'libros',      re: /\b(libros?|libreria|book|ebooks?|novel|novela|manual|guia|guide|comic|manga|revista|magazine|ensayo|cuento|poesia|antologia|diccionario|enciclopedia)\b/i },
  { cat: 'videos',      re: /\b(pelicula|movie|film|serie|season|temporada|episod|capitulo|trailer|documental|documentary|clip|anime|ova|amv|hentai)\b/i },
  { cat: 'audio',       re: /\b(album|discografia|discography|single|podcast|song|cancion|ost|soundtrack|concierto|live|remix|mixtape)\b/i },
  { cat: 'software',    re: /\b(setup|installer|instalador|portable|crack|keygen|patch|activador|activator|loader|repack|mod|mods)\b/i },
  { cat: 'comprimidos', re: /\b(part\d+|backup|bundle|pack|coleccion|collection|complete|full)\b/i },
  { cat: 'juegos',      re: /\b(game|juego|rom|emu|emulador|emulator|retro|arcade|iso\s*game)\b/i },
  { cat: 'imagenes',    re: /\b(wallpaper|fondo|screenshot|captura|photo|foto|artwork|render)\b/i },
  { cat: 'documentos',  re: /\b(factura|invoice|contrato|contract|apuntes|notas|resumen|tarea|examen|formulario)\b/i },
];

function categorizeByName(name) {
  if (!name) return null;
  const norm = normalizeName(name);
  for (const { cat, re } of NAME_HINTS) {
    if (re.test(norm)) return cat;
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// EXTRAER EXTENSIÓN
// ────────────────────────────────────────────────────────────
function getExtension(fileName) {
  if (!fileName) return '';
  const clean = fileName.split('?')[0].split('#')[0];
  const lastDot = clean.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === clean.length - 1) return '';
  const ext = clean.slice(lastDot + 1).toLowerCase();
  return ext.length > 8 ? '' : ext;
}

// ────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL DE CLASIFICACIÓN
// ────────────────────────────────────────────────────────────
/**
 * Clasifica un archivo por extensión → MIME → heurística de nombre.
 * @param {string} fileName
 * @param {string} [mimeType]
 * @returns {{ category: string, extension: string, source: string }}
 */
function categorize(fileName, mimeType) {
  const ext = getExtension(fileName);

  if (ext && EXT_TO_CAT[ext]) {
    return { category: EXT_TO_CAT[ext], extension: ext, source: 'extension' };
  }

  const byMime = categorizeByMime(mimeType);
  if (byMime) {
    return { category: byMime, extension: ext, source: 'mime' };
  }

  const byName = categorizeByName(fileName);
  if (byName) {
    return { category: byName, extension: ext, source: 'name' };
  }

  return { category: 'otros', extension: ext, source: 'fallback' };
}

// ────────────────────────────────────────────────────────────
// FILTRO: ¿este mensaje contiene un archivo indexable?
// ────────────────────────────────────────────────────────────
/**
 * Descarta basura antes de tocar la DB:
 *   • Stickers / GIFs animados / videos redondos / notas de voz
 *   • Tamaño mínimo por categoría:
 *       libros → 1 MB (PDF/CBZ/EPUB pequeños son válidos)
 *       videos → 10 MB
 *       resto  → 10 MB
 *   • Duración mínima para videos: 3 min (corta trailers, memes, clips)
 *
 * @param {object} msg  Mensaje de GramJS
 * @returns {{ ok: boolean, reason: string, fileName?: string, category?: string, extension?: string }}
 */
function isIndexable(msg) {
  const doc = msg && msg.document;
  if (!doc) return { ok: false, reason: 'no-document' };

  const attrs = doc.attributes || [];
  const typeNames = attrs.map(a => a.className || a.constructor?.name || '');

  // ── Stickers (webp, webm, tgs)
  if (typeNames.some(t => t.includes('DocumentAttributeSticker'))) {
    return { ok: false, reason: 'sticker' };
  }

  // ── GIFs animados
  if (typeNames.some(t => t.includes('DocumentAttributeAnimated'))) {
    return { ok: false, reason: 'animated-gif' };
  }

  // ── Videos redondos (video-note)
  const videoAttr = attrs.find(a =>
    (a.className || a.constructor?.name || '').includes('DocumentAttributeVideo')
  );
  if (videoAttr && videoAttr.roundMessage) {
    return { ok: false, reason: 'round-video' };
  }

  // ── Notas de voz
  const audioAttr = attrs.find(a =>
    (a.className || a.constructor?.name || '').includes('DocumentAttributeAudio')
  );
  if (audioAttr && audioAttr.voice) {
    return { ok: false, reason: 'voice-note' };
  }

  const nameAttr = attrs.find(a => a.fileName);
  const fileName = nameAttr?.fileName;

  // ── Nombre genérico "sticker.*"
  if (fileName && /^sticker\./i.test(fileName)) {
    return { ok: false, reason: 'sticker-name' };
  }

  // ── Categorizar (necesario para conocer el umbral correcto)
  const cat = categorize(fileName || '', doc.mimeType);
  const sizeBytes = Number(doc.size) || 0;
  const minMB = minSizeMBFor(cat.category);
  const minBytes = minMB * 1024 * 1024;

  // ── Tamaño mínimo según categoría
  if (sizeBytes > 0 && sizeBytes < minBytes) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(2);
    return {
      ok: false,
      reason: `${cat.category}-too-small (${mb}MB < ${minMB}MB)`,
    };
  }

  // ── Duración mínima solo para videos
  if (cat.category === 'videos' && videoAttr) {
    const durSec = Number(videoAttr.duration) || 0;
    if (durSec > 0 && durSec < MIN_VIDEO_SEC) {
      const mins = (durSec / 60).toFixed(1);
      const targetMin = (MIN_VIDEO_SEC / 60).toFixed(0);
      return {
        ok: false,
        reason: `video-too-short (${mins}min < ${targetMin}min)`,
      };
    }
  }

  // ── Sin nombre + tamaño ridículo → basura (defensivo)
  if (!fileName && sizeBytes < 50 * 1024) {
    return { ok: false, reason: 'too-small-no-name' };
  }

  return {
    ok: true,
    reason: 'ok',
    fileName,
    category: cat.category,
    extension: cat.extension,
  };
}

// ────────────────────────────────────────────────────────────
// INFO DE CATEGORÍAS
// ────────────────────────────────────────────────────────────
const CATEGORY_META = {
  libros:      { icon: '📚', label: 'Libros / Ebooks' },
  videos:      { icon: '🎬', label: 'Películas / Videos' },
  audio:       { icon: '🎵', label: 'Música / Audio' },
  imagenes:    { icon: '🖼️', label: 'Imágenes' },
  comprimidos: { icon: '📦', label: 'Archivos comprimidos' },
  software:    { icon: '💿', label: 'Software / Apps' },
  documentos:  { icon: '📄', label: 'Documentos' },
  juegos:      { icon: '🎮', label: 'Juegos / ROMs' },
  otros:       { icon: '⚙️', label: 'Otros' },
};

function listCategories() {
  const out = [];
  for (const cat of Object.keys(CATEGORY_META)) {
    out.push({
      name: cat,
      icon: CATEGORY_META[cat].icon,
      label: CATEGORY_META[cat].label,
      extensions: EXT_MAP[cat] || [],
      minSizeMB: minSizeMBFor(cat),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
module.exports = {
  categorize,
  isIndexable,
  getExtension,
  categorizeByMime,
  categorizeByName,
  listCategories,
  minSizeMBFor,
  EXT_MAP,
  CATEGORY_META,
  // umbrales expuestos por si el scanner los quiere mostrar
  MIN_VIDEO_MB,
  MIN_VIDEO_SEC,
  MIN_BOOK_MB,
  MIN_GENERIC_MB,
};
