/**
 * title-normalizer.js — Normaliza títulos para comparación por similitud.
 * Usado por series.js (mangas) y video-tagger.js (videos).
 */
function normalizeTitle(name) {
  if (!name) return '';
  return String(name)
    .replace(/\.[a-z0-9]{2,8}$/i, '')
    .replace(/^\s*\[[^\]]+\]\s*/g, '')
    .replace(/^\s*\([^)]+\)\s*/g, '')
    .replace(/\b(s\d{1,2}\s*e\d{1,3})\b/gi, '')
    .replace(/\b(ep?|episode|episodio|cap|capitulo|capítulo|chapter)\s*\.?\s*\d+(?:\s*[-–—]\s*\d+)?\b/gi, '')
    .replace(/\b(tomo|vol(?:ume)?|v)\s*\.?\s*\d+\b/gi, '')
    .replace(/\b(1080p|720p|2160p|480p|4k|8k|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|hdtv|dvdrip|x264|x265|h264|h265|hevc|av1|aac|ac3|dts|5\.1|10bit)\b/gi, '')
    .replace(/\d+\s*[-–—]\s*\d+/g, '')
    .replace(/[\s._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function jaccard(a, b) {
  if (!a || !b) return 0;
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

module.exports = { normalizeTitle, jaccard };
