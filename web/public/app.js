const state = {
  db: 'all',
  q: '',
  filters: { series: '', ext: '', minSize: 0, sort: 'size_desc' },
  results: [],
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const ICONS = {
  libros: '📚', videos: '🎬', audio: '🎵', imagenes: '🖼️',
  comprimidos: '📦', software: '💿', documentos: '📄',
  juegos: '🎮', otros: '⚙️',
};

const PLAY_ICON = `<svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>`;

function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = b, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function toast(msg, type = 'info', ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Error');
  }
  return res.json();
}

// ─── Stats para sidebar ───
async function loadStats() {
  try {
    const s = await api('/stats');
    $('#countVideos').textContent = s.videos?.count || 0;
    $('#countMangas').textContent = s.mangas?.count || 0;
    $('#countOtros').textContent = s.otros?.count || 0;
    $('#countAll').textContent = (s.videos?.count || 0) + (s.mangas?.count || 0) + (s.otros?.count || 0);
  } catch {}
}

// ─── Búsqueda ───
async function loadResults() {
  const params = new URLSearchParams({
    db: state.db,
    q: state.q,
    limit: '120',
    sort: state.filters.sort,
  });
  if (state.filters.series) params.set('series', state.filters.series);
  if (state.filters.ext) params.set('ext', state.filters.ext);
  if (state.filters.minSize) params.set('minSize', state.filters.minSize);

  $('#results').innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Cargando...</p></div>`;

  try {
    const data = await api(`/search?${params}`);
    state.results = data.results;
    renderResults();
  } catch (e) {
    $('#results').innerHTML = `<div class="empty-state">❌ ${esc(e.message)}</div>`;
  }
}

function renderResults() {
  $('#resultsCount').textContent = state.results.length;

  const titles = { all: 'Todos los archivos', videos: 'Videos', mangas: 'Mangas', otros: 'Otros' };
  $('#resultsTitle').textContent = titles[state.db] || 'Resultados';

  if (!state.results.length) {
    $('#results').innerHTML = `<div class="empty-state"><p>📭 Sin resultados</p></div>`;
    return;
  }

  $('#results').innerHTML = state.results.map(r => {
    const icon = ICONS[r.category] || '⚙️';
    const hasThumb = r.thumb_url;
    const isVideo = r.stream_url;
    const ext = r.extension ? r.extension.toUpperCase() : '';
    const kindLabel = r.kind ? r.kind.replace(/_/g, ' ') : '';
    const dur = r.duration ? `${Math.round(r.duration / 60)}min` : '';

    const thumbHTML = hasThumb
      ? `<img src="${r.thumb_url}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'card-thumb-placeholder\\'>${icon}</div>'">`
      : `<div class="card-thumb-placeholder">${icon}</div>`;

    const playOverlay = isVideo
      ? `<div class="card-thumb-play">${PLAY_ICON}</div>`
      : '';

    const badge = ext
      ? `<div class="card-thumb-badge">${esc(ext)}</div>`
      : '';

    return `
      <div class="card" data-db="${r.db}" data-id="${r.id}">
        <div class="card-thumb">
          ${thumbHTML}
          ${badge}
          ${playOverlay}
        </div>
        <div class="card-body">
          <div class="card-title">${esc(r.file_name)}</div>
          <div class="card-meta">
            <span>${fmtSize(r.file_size)}</span>
            ${dur ? `<span>· ${dur}</span>` : ''}
          </div>
          ${(kindLabel || r.series_display) ? `
            <div class="card-meta">
              ${kindLabel ? `<span class="card-tag accent">${esc(kindLabel)}</span>` : ''}
              ${r.series_display ? `<span class="card-tag">${esc(r.series_display.slice(0, 20))}</span>` : ''}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  $$('.card').forEach(c => {
    c.addEventListener('click', () => openDetail(c.dataset.db, parseInt(c.dataset.id, 10)));
  });
}

// ─── Detail modal ───
async function openDetail(dbName, id) {
  try {
    const r = await api(`/files/${dbName}/${id}`);
    const isVideo = r.stream_url;

    let html = '';

    if (isVideo) {
      html += `<video class="detail-video-player" controls preload="metadata" src="${r.stream_url}">
        Tu navegador no soporta video HTML5.
      </video>`;
    }

    html += `<div class="detail-content">
      <h2 class="detail-title">${esc(r.file_name)}</h2>
      <div class="detail-grid">
        <div class="detail-field">
          <div class="detail-field-label">Tamaño</div>
          <div class="detail-field-value">${fmtSize(r.file_size)}</div>
        </div>
        <div class="detail-field">
          <div class="detail-field-label">Categoría</div>
          <div class="detail-field-value">${ICONS[r.category] || '⚙️'} ${esc(r.category)}${r.extension ? '.' + r.extension : ''}</div>
        </div>
        ${r.duration ? `
          <div class="detail-field">
            <div class="detail-field-label">Duración</div>
            <div class="detail-field-value">${Math.round(r.duration / 60)} min</div>
          </div>
        ` : ''}
        ${r.kind ? `
          <div class="detail-field">
            <div class="detail-field-label">Tipo</div>
            <div class="detail-field-value">${esc(r.kind.replace(/_/g, ' '))}</div>
          </div>
        ` : ''}
        ${r.series_display ? `
          <div class="detail-field">
            <div class="detail-field-label">Serie</div>
            <div class="detail-field-value">${esc(r.series_display)}</div>
          </div>
        ` : ''}
        ${r.season || r.episode ? `
          <div class="detail-field">
            <div class="detail-field-label">Temporada / Episodio</div>
            <div class="detail-field-value">${r.season ? 'S' + r.season : ''} ${r.episode ? 'E' + r.episode : ''}</div>
          </div>
        ` : ''}
        <div class="detail-field">
          <div class="detail-field-label">Canal</div>
          <div class="detail-field-value">${esc(r.chat_title || '-')}</div>
        </div>
        <div class="detail-field">
          <div class="detail-field-label">DB</div>
          <div class="detail-field-value">${esc(dbName)}#${r.id}</div>
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn-primary" id="downloadBtn" ${r.downloaded_path ? 'disabled' : ''}>
          ${r.downloaded_path ? '✅ Ya descargado' : '⬇️ Descargar'}
        </button>
        ${isVideo ? `<button class="btn-secondary" id="streamBtn">🔗 Abrir en nueva pestaña</button>` : ''}
      </div>
    </div>`;

    $('#detailBody').innerHTML = html;

    if (!r.downloaded_path) {
      $('#downloadBtn').addEventListener('click', () => startDownload(dbName, id));
    }
    if (isVideo) {
      $('#streamBtn').addEventListener('click', () => {
        window.open(r.stream_url, '_blank');
      });
    }

    $('#detailModal').showModal();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Descarga ───
async function startDownload(dbName, id) {
  const btn = $('#downloadBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Iniciando...';

  try {
    const res = await api(`/download/${dbName}/${id}`, { method: 'POST' });
    if (res.alreadyDone) {
      toast('✅ Ya estaba descargado', 'success');
      $('#detailModal').close();
      loadResults();
      return;
    }
    toast('⬇️ Descarga iniciada', 'info');

    pollJob(res.jobId, (job) => {
      if (job.status === 'running' && job.total > 0) {
        const pct = Math.round((job.progress / job.total) * 100);
        btn.textContent = `⬇️ ${pct}% (${fmtSize(job.progress)})`;
      } else if (job.status === 'done') {
        toast('✅ Descargado', 'success');
        $('#detailModal').close();
        loadResults();
      } else if (job.status === 'error') {
        toast(`❌ ${job.error}`, 'error');
        btn.disabled = false;
        btn.textContent = '⬇️ Reintentar';
      }
    });
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = '⬇️ Descargar';
  }
}

async function pollJob(jobId, onChange) {
  const interval = setInterval(async () => {
    try {
      const job = await api(`/jobs/${jobId}`);
      onChange(job);
      if (job.status === 'done' || job.status === 'error') clearInterval(interval);
    } catch { clearInterval(interval); }
  }, 1000);
}

// ─── Stats modal ───
async function showStats() {
  try {
    const s = await api('/stats');
    const sections = [];

    for (const [name, data] of Object.entries(s)) {
      if (!data.count) continue;
      const thumbPct = ((data.with_thumb / data.count) * 100).toFixed(1);
      sections.push(`
        <div class="stats-section">
          <h4>${name} — ${data.count} archivos · ${fmtSize(data.total_size)}</h4>
          <div class="stats-row">
            <span>🖼️ Con thumbnail</span>
            <span class="stats-value">${data.with_thumb} (${thumbPct}%)</span>
          </div>
          <div class="stats-row">
            <span>📁 Canales</span>
            <span class="stats-value">${data.channels}</span>
          </div>
          ${data.byCategory.map(c => `
            <div class="stats-row">
              <span>${ICONS[c.category] || '⚙️'} ${c.category}</span>
              <span class="stats-value">${c.count} · ${fmtSize(c.total_size)}</span>
            </div>`).join('')}
        </div>`);
    }

    $('#statsBody').innerHTML = sections.join('') || '<p>Sin datos</p>';
    $('#statsModal').showModal();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Scan ───
async function startScan() {
  const mode = $('#scanMode').value;
  const channel = $('#scanChannel').value.trim() || null;
  const btn = $('#scanStart');
  const status = $('#scanStatus');

  btn.disabled = true;
  status.textContent = '⏳ Iniciando...';

  try {
    const { jobId } = await api('/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, channel }),
    });

    pollJob(jobId, (job) => {
      if (job.status === 'running') status.textContent = '⏳ Escaneando...';
      else if (job.status === 'done') {
        status.textContent = '✅ Escaneo completado';
        btn.disabled = false;
        loadStats();
        loadResults();
      } else if (job.status === 'error') {
        status.textContent = `❌ ${job.error}`;
        btn.disabled = false;
      }
    });
  } catch (e) {
    status.textContent = `❌ ${e.message}`;
    btn.disabled = false;
  }
}

// ─── Thumbs ───
async function startThumbs() {
  const dbName = $('#thumbsDb').value;
  const limit = parseInt($('#thumbsLimit').value, 10) || 100;
  const btn = $('#thumbsStart');
  const status = $('#thumbsStatus');

  btn.disabled = true;
  status.textContent = '⏳ Descargando thumbnails...';

  try {
    const { jobId } = await api('/thumbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: dbName, limit }),
    });

    pollJob(jobId, (job) => {
      if (job.status === 'running') status.textContent = '⏳ Descargando...';
      else if (job.status === 'done') {
        status.textContent = '✅ Completado';
        btn.disabled = false;
        loadResults();
        loadStats();
      } else if (job.status === 'error') {
        status.textContent = `❌ ${job.error}`;
        btn.disabled = false;
      }
    });
  } catch (e) {
    status.textContent = `❌ ${e.message}`;
    btn.disabled = false;
  }
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadResults();

  // Sidebar DB tabs
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      $$('.nav-item').forEach(x => x.classList.remove('active'));
      item.classList.add('active');
      state.db = item.dataset.db;
      loadResults();
    });
  });

  // Debounce search
  let db;
  const deb = (fn) => { clearTimeout(db); db = setTimeout(fn, 300); };

  $('#searchInput').addEventListener('input', e => {
    deb(() => { state.q = e.target.value; loadResults(); });
  });
  $('#seriesInput').addEventListener('input', e => {
    deb(() => { state.filters.series = e.target.value; loadResults(); });
  });
  $('#extInput').addEventListener('input', e => {
    deb(() => { state.filters.ext = e.target.value; loadResults(); });
  });
  $('#minSizeInput').addEventListener('input', e => {
    deb(() => { state.filters.minSize = parseFloat(e.target.value) || 0; loadResults(); });
  });
  $('#sortSelect').addEventListener('change', e => {
    state.filters.sort = e.target.value;
    loadResults();
  });

  $('#clearFilters').addEventListener('click', () => {
    state.filters = { series: '', ext: '', minSize: 0, sort: 'size_desc' };
    state.q = '';
    $('#searchInput').value = '';
    $('#seriesInput').value = '';
    $('#extInput').value = '';
    $('#minSizeInput').value = '';
    $('#sortSelect').value = 'size_desc';
    loadResults();
  });

  $('#statsBtn').addEventListener('click', showStats);
  $('#scanBtn').addEventListener('click', () => {
    $('#scanStatus').textContent = '';
    $('#scanModal').showModal();
  });
  $('#thumbsBtn').addEventListener('click', () => {
    $('#thumbsStatus').textContent = '';
    $('#thumbsModal').showModal();
  });

  $('#scanStart').addEventListener('click', startScan);
  $('#thumbsStart').addEventListener('click', startThumbs);

  $$('[data-close]').forEach(b => b.addEventListener('click', () => {
    document.getElementById(b.dataset.close).close();
  }));

  // Atajo: / para buscar
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      $('#searchInput').focus();
    }
  });
});
