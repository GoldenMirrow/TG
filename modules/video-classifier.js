/**
 * video-classifier.js — Clasifica videos por duración + nombre.
 *
 * Reglas (en orden de prioridad):
 *   - Duración >= 60 min  → movie
 *   - Duración <  60 min  → serie/episodio
 *   - Nombre con hint anime → prefijo anime_
 *   - Nombre con hint movie → fuerza movie
 */
const MOVIE_THRESHOLD_SEC = 60 * 60;

const ANIME_HINTS  = /\b(anime|ova|ona|shonen|seinen|shojo|josei|manga|fansub|sub\s*esp|dub\s*esp|japonés|japones|japanese)\b/i;
const MOVIE_HINTS  = /\b(movie|pelicula|película|film|largometraje|the\s+movie)\b/i;
const SERIES_HINTS = /\b(s\d{1,2}\s*e\d{1,3}|season|temporada|episode|episodio|cap\s*\.?\s*\d+|ep\s*\.?\s*\d+|serie)\b/i;

function getVideoAttr(msg) {
  if (!msg?.document?.attributes) return null;
  return msg.document.attributes.find(a => {
    const n = a.className || a.constructor?.name || '';
    return n.includes('DocumentAttributeVideo');
  }) || null;
}

function getDuration(msg) {
  const a = getVideoAttr(msg);
  return a?.duration ?? null;
}

function getVideoMeta(msg) {
  const a = getVideoAttr(msg);
  return {
    duration: a?.duration ?? null,
    w: a?.w ?? null,
    h: a?.h ?? null,
    roundMessage: a?.roundMessage ?? false,
  };
}

/**
 * @param {string} fileName
 * @param {number|null} duration  segundos
 */
function classifyVideo(fileName, duration) {
  const isAnimeName  = ANIME_HINTS.test(fileName);
  const isMovieName  = MOVIE_HINTS.test(fileName);
  const isSeriesName = SERIES_HINTS.test(fileName);

  let isMovie;
  if (duration != null && duration > 0) {
    isMovie = duration >= MOVIE_THRESHOLD_SEC;
  } else {
    isMovie = isMovieName || (!isSeriesName && !isAnimeName);
  }

  let kind;
  if (isAnimeName) kind = isMovie ? 'anime_movie' : 'anime_series';
  else             kind = isMovie ? 'movie'       : (isSeriesName ? 'serie' : 'unknown');

  let season = null, episode = null;
  if (!isMovie) {
    const se = fileName.match(/\b[sS](\d{1,2})\s*[eE](\d{1,3})\b/);
    if (se) { season = parseInt(se[1], 10); episode = parseInt(se[2], 10); }
    else {
      const ep = fileName.match(/\b(?:ep?|episode|episodio|cap|capitulo|capítulo|chapter)\s*\.?\s*(\d{1,4})\b/i);
      if (ep) episode = parseInt(ep[1], 10);
    }
  }

  return { kind, isMovie, isSeries: !isMovie, season, episode, duration };
}

module.exports = { classifyVideo, getDuration, getVideoMeta, MOVIE_THRESHOLD_SEC };
