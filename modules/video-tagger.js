/**
 * video-tagger.js — Agrupa videos por similitud de título.
 * Usa Jaccard sobre tokens normalizados. Umbral 0.6.
 */
const { normalizeTitle, jaccard } = require('./title-normalizer');

const SIMILARITY_THRESHOLD = 0.6;

/**
 * @param {Array<{series_name:string, series_display:string}>} existing
 * @param {string} rawFileName
 * @param {string} normalizedTitle
 */
function findOrCreateSeries(existing, rawFileName, normalizedTitle) {
  let best = null, bestScore = 0;
  for (const r of existing) {
    if (!r.series_name) continue;
    const score = jaccard(normalizedTitle, r.series_name);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (best && bestScore >= SIMILARITY_THRESHOLD) {
    return {
      series_name: best.series_name,
      series_display: best.series_display || best.series_name,
      isNew: false,
      score: bestScore,
    };
  }
  const display = rawFileName.replace(/\.[a-z0-9]{2,8}$/i, '').trim();
  return {
    series_name: normalizedTitle,
    series_display: display || normalizedTitle,
    isNew: true,
    score: 0,
  };
}

module.exports = { findOrCreateSeries, SIMILARITY_THRESHOLD };
