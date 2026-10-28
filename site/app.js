// Train View : position estimée des trains à partir des horaires théoriques.
// Entre deux gares, le train est placé par interpolation linéaire entre l'heure
// de départ et l'heure d'arrivée ; pendant un arrêt, il reste en gare.
'use strict';

const TZ = 'Europe/Paris';
const TYPE_COLORS = {
  'TGV INOUI': '#8b5cf6',
  'OUIGO': '#ec4899',
  'OUIGO Train Classique': '#f472b6',
  'TER': '#3b82f6',
  'Intercités': '#14b8a6',
  'Intercités de nuit': '#6366f1',
  'Lyria': '#ef4444',
  'ICE': '#e11d48',
  'TramTrain': '#22c55e',
  'Navette': '#f59e0b',
};
const FALLBACK_COLORS = ['#eab308', '#06b6d4', '#84cc16', '#f97316', '#a855f7', '#94a3b8'];

const state = {
  data: null,
  trips: [],
  colors: {},
  active: [],          // trains en circulation : { key, trip, date, offset }
  hiddenTypes: new Set(),
  selected: null,      // élément de `active`
  follow: false,
  hover: null,
  drawn: [],           // positions écran des trains dessinés (pour le clic)
  pendingNumber: null, // train à sélectionner depuis l'URL
};

// ---------------------------------------------------------------------------
// Temps (heure de Paris)

const clockFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parisNow() {
  const now = Date.now();
  const p = Object.fromEntries(clockFmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}${p.month}${p.day}`,
    minutes: +p.hour * 60 + +p.minute + (+p.second + (now % 1000) / 1000) / 60,
    label: `${p.hour}:${p.minute}:${p.second}`,
  };
}

function shiftDate(yyyymmdd, days) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const fmtDate = (d) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
const fmtTime = (min) => {
  const m = Math.round(min) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const fmtDuration = (min) => {
  const m = Math.max(0, Math.round(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Géométrie

function haversine(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[2] - a[2]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Position d'un train à l'instant `t` (minutes depuis minuit de son jour de service).
// Renvoie { lat, lon, seg, k, atStop } ou null s'il ne circule pas.
// `seg` est l'indice de la gare de départ du tronçon en cours, `k` l'avancement sur ce tronçon.
function positionAt(trip, t) {
  const f = trip.flat;
  const n = f.length / 3;
  if (t < f[2] || t > f[f.length - 2]) return null;
  const stops = state.data.stops;
  for (let i = 0; i < n; i++) {
    const dep = f[i * 3 + 2];
    if (t <= dep) {
      if (t >= f[i * 3 + 1]) {
        const s = stops[f[i * 3]];
        return { lat: s[1], lon: s[2], seg: i, k: 0, atStop: true };
      }
      // Entre la gare i-1 et la gare i.
      const prevDep = f[(i - 1) * 3 + 2];
      const arr = f[i * 3 + 1];
      const a = stops[f[(i - 1) * 3]];
      const b = stops[f[i * 3]];
      const k = (t - prevDep) / Math.max(1e-6, arr - prevDep);
      return { lat: a[1] + (b[1] - a[1]) * k, lon: a[2] + (b[2] - a[2]) * k, seg: i - 1, k, atStop: false };
    }
  }
  const last = stops[f[(n - 1) * 3]];
  return { lat: last[1], lon: last[2], seg: n - 1, k: 0, atStop: true };
}

// Distances cumulées (km) le long du trajet, calculées à la demande.
function cumulativeKm(trip) {
  if (trip.cum) return trip.cum;
  const stops = state.data.stops;
  const cum = [0];
  for (let i = 3; i < trip.flat.length; i += 3) {
    cum.push(cum[cum.length - 1] + haversine(stops[trip.flat[i - 3]], stops[trip.flat[i]]));
  }
  return (trip.cum = cum);
}

const tNow = (item, now) => now.minutes + item.offset;

// ---------------------------------------------------------------------------
// Carte

const map = L.map('map', { zoomControl: false, minZoom: 4, worldCopyJump: true });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);

// Fond de carte OpenStreetMap : aucune clé d'API nécessaire. Si le serveur principal
// refuse les tuiles (trop d'erreurs), on bascule sur le serveur d'OpenStreetMap France.
const TILE_SOURCES = [
  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
  { url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', maxZoom: 20, subdomains: 'abc' },
];
let tileSource = 0;
let tileErrors = 0;
function addTiles() {
  const src = TILE_SOURCES[tileSource];
  const layer = L.tileLayer(src.url, {
    maxZoom: src.maxZoom,
    subdomains: src.subdomains || 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Horaires SNCF (GTFS)',
  }).addTo(map);
  layer.on('tileerror', () => {
    if (++tileErrors < 6 || tileSource >= TILE_SOURCES.length - 1) return;
    tileSource++;
    tileErrors = 0;
    layer.remove();
    addTiles();
  });
}
addTiles();

// Vue initiale : depuis l'URL (#lat,lon/zoom[/train]) comme Flightradar24, sinon la France.
(function readHash() {
  const m = /^#(-?[\d.]+),(-?[\d.]+)\/(\d+(?:\.\d+)?)(?:\/(.+))?$/.exec(location.hash);
  if (m) {
    map.setView([+m[1], +m[2]], +m[3]);
    if (m[4]) state.pendingNumber = decodeURIComponent(m[4]);
  } else {
    map.setView([46.6, 2.4], 6);
  }
})();

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = map.getCenter();
    const z = map.getZoom();
    const train = state.selected ? `/${encodeURIComponent(state.selected.trip.number)}` : '';
    history.replaceState(null, '', `#${c.lat.toFixed(2)},${c.lng.toFixed(2)}/${z}${train}`);
  }, 200);
}
map.on('moveend', writeHash);

// ---------------------------------------------------------------------------
// Calque canvas des trains (bien plus rapide que des milliers de marqueurs DOM)

const canvas = L.DomUtil.create('canvas', 'train-canvas', map.getContainer());
const ctx = canvas.getContext('2d');
let dirty = true;
let lastDraw = 0;

function resizeCanvas() {
  const size = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size.x * dpr;
  canvas.height = size.y * dpr;
  canvas.style.width = `${size.x}px`;
  canvas.style.height = `${size.y}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}
resizeCanvas();
map.on('resize', resizeCanvas);
map.on('move zoom', () => { dirty = true; });
// Pendant l'animation CSS du zoom, les tuiles sont mises à l'échelle mais pas le canvas :
// on le masque le temps de l'animation.
map.on('zoomanim', () => { canvas.style.visibility = 'hidden'; });
map.on('zoomend', () => { canvas.style.visibility = ''; dirty = true; });

// Icône de train vue de dessus, nez vers le haut (y négatif), à l'échelle `s`.
function trainPath(s) {
  const p = new Path2D();
  p.moveTo(0, -10 * s);
  p.bezierCurveTo(3.5 * s, -8 * s, 4 * s, -5 * s, 4 * s, -2 * s);
  p.lineTo(4 * s, 8 * s);
  p.quadraticCurveTo(4 * s, 10 * s, 2 * s, 10 * s);
  p.lineTo(-2 * s, 10 * s);
  p.quadraticCurveTo(-4 * s, 10 * s, -4 * s, 8 * s);
  p.lineTo(-4 * s, -2 * s);
  p.bezierCurveTo(-4 * s, -5 * s, -3.5 * s, -8 * s, 0, -10 * s);
  p.closePath();
  return p;
}
const DARK = matchMedia('(prefers-color-scheme: dark)').matches;
const ICONS = { normal: trainPath(0.9), small: trainPath(0.65), big: trainPath(1.35) };

function bearing(trip, pos) {
  // Orientation à l'écran : direction du tronçon en cours (ou du suivant si le train est à quai).
  const f = trip.flat;
  const n = f.length / 3;
  let i = pos.seg;
  if (i >= n - 1) i = n - 2;
  const a = state.data.stops[f[i * 3]];
  const b = state.data.stops[f[(i + 1) * 3]];
  const pa = map.latLngToContainerPoint([a[1], a[2]]);
  const pb = map.latLngToContainerPoint([b[1], b[2]]);
  return Math.atan2(pb.x - pa.x, -(pb.y - pa.y));
}

function draw() {
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);
  if (!state.data) return;
  const now = parisNow();
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.1);
  const stops = state.data.stops;

  // Gares, visibles à partir d'un certain zoom.
  if (zoom >= 8) {
    ctx.fillStyle = DARK ? 'rgba(220, 224, 230, 0.6)' : 'rgba(30, 33, 40, 0.55)';
    ctx.font = '11px system-ui, sans-serif';
    for (const s of state.usedStops) {
      if (!bounds.contains([s[1], s[2]])) continue;
      const p = map.latLngToContainerPoint([s[1], s[2]]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, zoom >= 11 ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (zoom >= 11) ctx.fillText(s[0], p.x + 6, p.y + 4);
    }
  }

  // Trajet du train sélectionné : parcouru en plein, restant en pointillés.
  const sel = state.selected;
  let selPos = null;
  if (sel) {
    selPos = positionAt(sel.trip, tNow(sel, now));
    if (selPos) drawRoute(sel.trip, selPos);
  }

  // Trains.
  const icon = zoom <= 6 ? ICONS.small : ICONS.normal;
  const drawn = [];
  for (const item of state.active) {
    if (item === sel) continue;
    if (state.hiddenTypes.has(item.trip.type)) continue;
    const pos = positionAt(item.trip, tNow(item, now));
    if (!pos || !bounds.contains([pos.lat, pos.lon])) continue;
    const p = map.latLngToContainerPoint([pos.lat, pos.lon]);
    drawTrain(p, bearing(item.trip, pos), icon, state.colors[item.trip.type], item === state.hover);
    drawn.push({ x: p.x, y: p.y, item });
  }
  if (sel && selPos) {
    const p = map.latLngToContainerPoint([selPos.lat, selPos.lon]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 193, 7, 0.3)';
    ctx.fill();
    drawTrain(p, bearing(sel.trip, selPos), ICONS.big, '#ffc107', false, '#111');
    drawn.push({ x: p.x, y: p.y, item: sel });
  }
  state.drawn = drawn;
}

function drawTrain(p, angle, icon, color, highlight, stroke = '#fff') {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 3;
  ctx.fillStyle = color;
  ctx.fill(icon);
  ctx.shadowBlur = 0;
  ctx.lineWidth = highlight ? 2.5 : 1.2;
  ctx.strokeStyle = highlight ? '#ffc107' : stroke;
  ctx.stroke(icon);
  ctx.restore();
}

function drawRoute(trip, pos) {
  const f = trip.flat;
  const stops = state.data.stops;
  const pts = [];
  for (let i = 0; i < f.length; i += 3) {
    const s = stops[f[i]];
    pts.push(map.latLngToContainerPoint([s[1], s[2]]));
  }
  const cur = map.latLngToContainerPoint([pos.lat, pos.lon]);
  const color = state.colors[trip.type];

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Partie parcourue.
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i <= pos.seg; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(cur.x, cur.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();
  // Partie restante.
  ctx.beginPath();
  ctx.moveTo(cur.x, cur.y);
  for (let i = pos.seg + 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
  // Gares du trajet.
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, i === 0 || i === pts.length - 1 ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  });
}

// Animation : on redessine quand la carte bouge, sinon ~5 fois par seconde
// (à l'échelle de la France, un train avance de moins d'un pixel par seconde).
function loop(ts) {
  if (dirty || ts - lastDraw > 200) {
    draw();
    dirty = false;
    lastDraw = ts;
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Interaction avec les trains

const tooltip = document.getElementById('tooltip');

function hitTest(point) {
  let best = null;
  let bestD = 14 * 14;
  for (const d of state.drawn) {
    const dx = d.x - point.x;
    const dy = d.y - point.y;
    const dist = dx * dx + dy * dy;
    if (dist <= bestD) { best = d; bestD = dist; }
  }
  return best;
}

map.on('mousemove', (e) => {
  const hit = hitTest(e.containerPoint);
  const item = hit?.item || null;
  map.getContainer().style.cursor = item ? 'pointer' : '';
  if (item !== state.hover) { state.hover = item; dirty = true; }
  if (item) {
    const t = item.trip;
    tooltip.innerHTML = `<b>${escapeHtml(t.number)}</b> ${escapeHtml(t.type)} · ${escapeHtml(t.origin)} → ${escapeHtml(t.destination)}`;
    const rect = map.getContainer().getBoundingClientRect();
    tooltip.style.left = `${rect.left + hit.x}px`;
    tooltip.style.top = `${rect.top + hit.y}px`;
    tooltip.classList.remove('hidden');
  } else {
    tooltip.classList.add('hidden');
  }
});
map.on('mouseout', () => { tooltip.classList.add('hidden'); state.hover = null; });

map.on('click', (e) => {
  const hit = hitTest(e.containerPoint);
  if (hit) select(hit.item);
  else deselect();
});
map.on('dragstart', () => { if (state.follow) setFollow(false); });

// ---------------------------------------------------------------------------
// Données

async function load() {
  let res = null;
  try {
    res = await fetch('data/network.json', { cache: 'no-cache' });
  } catch {
    // Ouverture en file:// ou réseau indisponible : géré ci-dessous.
  }
  if (!res || !res.ok) {
    setStatus('Horaires introuvables. Générez-les avec <code>npm run data</code> puis ouvrez le site via <code>npm run serve</code>.');
    return;
  }
  const data = await res.json();
  state.data = data;
  const stops = data.stops;
  const used = new Set();
  state.trips = data.trips.map(([number, type, service, flat], i) => {
    for (let k = 0; k < flat.length; k += 3) used.add(flat[k]);
    return {
      id: i,
      number,
      type: data.types[type],
      days: new Set(data.services[service].map((d) => data.dates[d])),
      flat,
      origin: stops[flat[0]][0],
      destination: stops[flat[flat.length - 3]][0],
    };
  });
  state.usedStops = [...used].map((i) => stops[i]);

  let extra = 0;
  for (const t of data.types) state.colors[t] = TYPE_COLORS[t] || FALLBACK_COLORS[extra++ % FALLBACK_COLORS.length];

  const today = parisNow().date;
  if (!data.dates.includes(today)) {
    setStatus(`Les horaires chargés couvrent du ${fmtDate(data.dates[1])} au ${fmtDate(data.dates.at(-1))}, pas aujourd'hui. Régénérez les données avec <code>npm run data</code>.`);
  }
  buildFilters();
  refreshActive();
  setInterval(refreshActive, 1000);
  requestAnimationFrame(loop);
}

// Liste des trains en circulation, recalculée chaque seconde.
function refreshActive() {
  const now = parisNow();
  document.getElementById('clock').textContent = now.label;

  // Un train parti la veille au soir peut encore rouler après minuit (horaires GTFS > 24:00).
  const days = [
    { date: now.date, offset: 0 },
    { date: shiftDate(now.date, -1), offset: 1440 },
  ];
  const previous = new Map(state.active.map((a) => [a.key, a]));
  const active = [];
  const counts = {};
  for (const trip of state.trips) {
    for (const { date, offset } of days) {
      if (!trip.days.has(date)) continue;
      const t = now.minutes + offset;
      if (t < trip.flat[2] || t > trip.flat[trip.flat.length - 2]) continue;
      const key = `${trip.id}:${date}`;
      // On réutilise l'objet existant pour garder la sélection et le survol.
      active.push(previous.get(key) || { key, trip, date, offset });
      counts[trip.type] = (counts[trip.type] || 0) + 1;
    }
  }
  state.active = active;

  if (state.selected && !active.includes(state.selected)) {
    const { trip } = state.selected;
    deselect();
    flash(`Le train ${escapeHtml(trip.number)} est arrivé à ${escapeHtml(trip.destination)}.`);
  }
  if (state.pendingNumber) {
    const item = active.find((a) => a.trip.number === state.pendingNumber);
    state.pendingNumber = null;
    if (item) select(item, { pan: false });
  }

  const visible = active.filter((a) => !state.hiddenTypes.has(a.trip.type)).length;
  document.getElementById('count').textContent = visible.toLocaleString('fr-FR');
  updateFilterCounts(counts);

  if (state.selected) {
    renderPanel();
    if (state.follow) {
      const pos = positionAt(state.selected.trip, tNow(state.selected, now));
      if (pos) map.panTo(visibleCenter([pos.lat, pos.lon]), { animate: true, duration: 0.8 });
    }
  }
  dirty = true;
}

// ---------------------------------------------------------------------------
// Filtres par type

function buildFilters() {
  const box = document.getElementById('filters');
  box.innerHTML = '';
  for (const type of state.data.types) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.type = type;
    b.title = 'Afficher / masquer';
    b.innerHTML = `<span class="dot" style="background:${state.colors[type]}"></span><span class="label">${escapeHtml(type)}</span><span class="n">0</span>`;
    b.addEventListener('click', () => {
      if (state.hiddenTypes.has(type)) state.hiddenTypes.delete(type);
      else state.hiddenTypes.add(type);
      b.classList.toggle('off', state.hiddenTypes.has(type));
      refreshActive();
    });
    box.appendChild(b);
  }
}

function updateFilterCounts(counts) {
  for (const b of document.querySelectorAll('#filters .chip')) {
    const n = counts[b.dataset.type] || 0;
    b.querySelector('.n').textContent = n.toLocaleString('fr-FR');
    b.classList.toggle('hidden', n === 0 && !state.hiddenTypes.has(b.dataset.type));
  }
}

// ---------------------------------------------------------------------------
// Recherche (trains en circulation et gares)

const searchInput = document.getElementById('search');
const resultsBox = document.getElementById('results');
let results = [];
let resultIdx = 0;

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function runSearch() {
  const q = normalize(searchInput.value.trim());
  if (!q || !state.data) { resultsBox.classList.add('hidden'); results = []; return; }

  const trains = [];
  for (const a of state.active) {
    const t = a.trip;
    if (normalize(t.number).startsWith(q) || normalize(t.origin).includes(q) || normalize(t.destination).includes(q)) {
      trains.push({ kind: 'train', item: a });
      if (trains.length >= 8) break;
    }
  }
  const stations = [];
  const seen = new Set();
  for (const s of state.usedStops) {
    if (seen.has(s[0]) || !normalize(s[0]).includes(q)) continue;
    seen.add(s[0]);
    stations.push({ kind: 'station', stop: s });
    if (stations.length >= 5) break;
  }
  results = [...trains, ...stations];
  resultIdx = 0;
  renderResults();
}

function renderResults() {
  resultsBox.classList.remove('hidden');
  if (!results.length) {
    resultsBox.innerHTML = '<li class="empty">Aucun train en circulation ni gare trouvés</li>';
    return;
  }
  resultsBox.innerHTML = results.map((r, i) => {
    if (r.kind === 'train') {
      const t = r.item.trip;
      return `<li data-i="${i}" class="${i === resultIdx ? 'active' : ''}"><span class="tag" style="background:${state.colors[t.type]}">${escapeHtml(t.number)}</span><span class="main">${escapeHtml(t.origin)} → ${escapeHtml(t.destination)} <small>${escapeHtml(t.type)}</small></span></li>`;
    }
    return `<li data-i="${i}" class="${i === resultIdx ? 'active' : ''}"><span class="tag" style="background:#4b5563">Gare</span><span class="main">${escapeHtml(r.stop[0])}</span></li>`;
  }).join('');
}

function pickResult(r) {
  if (!r) return;
  searchInput.value = '';
  resultsBox.classList.add('hidden');
  searchInput.blur();
  if (r.kind === 'train') {
    select(r.item, { zoom: Math.max(map.getZoom(), 9) });
  } else {
    map.flyTo([r.stop[1], r.stop[2]], 12, { duration: 1 });
  }
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('focus', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!results.length) return;
    resultIdx = (resultIdx + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
    renderResults();
  } else if (e.key === 'Enter') {
    pickResult(results[resultIdx]);
  } else if (e.key === 'Escape') {
    resultsBox.classList.add('hidden');
    searchInput.blur();
  }
});
resultsBox.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); pickResult(results[+li.dataset.i]); }
});
searchInput.addEventListener('blur', () => setTimeout(() => resultsBox.classList.add('hidden'), 100));

// ---------------------------------------------------------------------------
// Panneau de détail

const panel = document.getElementById('panel');

function select(item, { pan = true, zoom } = {}) {
  state.selected = item;
  setFollow(false);
  panel.classList.remove('hidden');
  renderPanel();
  if (pan) {
    const pos = positionAt(item.trip, tNow(item, parisNow()));
    if (pos) {
      if (zoom) map.flyTo(visibleCenter([pos.lat, pos.lon], zoom), zoom, { duration: 1 });
      else if (!visibleBounds().contains([pos.lat, pos.lon])) map.panTo(visibleCenter([pos.lat, pos.lon]));
    }
  }
  writeHash();
  dirty = true;
}

// Le panneau couvre la gauche de la carte (ou le bas sur mobile) : on décale le centre
// pour que le train reste dans la partie visible.
function panelOffset() {
  const size = map.getSize();
  return innerWidth > 720 ? L.point(-panel.offsetWidth / 2, 0) : L.point(0, size.y * 0.3);
}

function visibleCenter(latlng, zoom = map.getZoom()) {
  return map.unproject(map.project(latlng, zoom).add(panelOffset()), zoom);
}

function visibleBounds() {
  const size = map.getSize();
  const tl = innerWidth > 720 ? L.point(panel.offsetWidth + 40, 40) : L.point(40, 40);
  const br = innerWidth > 720 ? L.point(size.x - 40, size.y - 40) : L.point(size.x - 40, size.y * 0.4 - 20);
  return L.latLngBounds(map.containerPointToLatLng(tl), map.containerPointToLatLng(br));
}

function deselect() {
  if (!state.selected) return;
  state.selected = null;
  setFollow(false);
  panel.classList.add('hidden');
  writeHash();
  dirty = true;
}

function setFollow(on) {
  state.follow = on;
  panel.querySelector('[data-action=follow]')?.classList.toggle('on', on);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement !== searchInput) deselect();
});

panel.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const li = e.target.closest('li[data-stop]');
  if (action === 'close') deselect();
  else if (action === 'follow') {
    setFollow(!state.follow);
    if (state.follow) refreshActive();
  } else if (action === 'route') {
    const pts = [];
    const f = state.selected.trip.flat;
    for (let i = 0; i < f.length; i += 3) { const s = state.data.stops[f[i]]; pts.push([s[1], s[2]]); }
    setFollow(false);
    const wide = innerWidth > 720;
    map.flyToBounds(pts, {
      paddingTopLeft: [wide ? panel.offsetWidth + 40 : 30, 40],
      paddingBottomRight: [40, wide ? 40 : map.getSize().y * 0.6 + 20],
      duration: 1,
    });
  } else if (li) {
    const s = state.data.stops[+li.dataset.stop];
    setFollow(false);
    const z = Math.max(map.getZoom(), 11);
    map.flyTo(visibleCenter([s[1], s[2]], z), z, { duration: 1 });
  }
});

function renderPanel() {
  const item = state.selected;
  if (!item) return;
  const { trip } = item;
  const now = parisNow();
  const t = tNow(item, now);
  const pos = positionAt(trip, t);
  if (!pos) return;

  const f = trip.flat;
  const n = f.length / 3;
  const stops = state.data.stops;
  const color = state.colors[trip.type];
  const cum = cumulativeKm(trip);
  const total = cum[n - 1];
  const done = pos.atStop ? cum[pos.seg] : cum[pos.seg] + (cum[pos.seg + 1] - cum[pos.seg]) * pos.k;
  const start = f[2];
  const end = f[f.length - 2];
  const progress = Math.min(1, done / Math.max(total, 1e-6));

  // Prochain arrêt et vitesse moyenne estimée sur le tronçon en cours.
  const nextIdx = pos.atStop ? pos.seg : pos.seg + 1;
  let speed = 0;
  if (!pos.atStop) {
    const minutes = f[(pos.seg + 1) * 3 + 1] - f[pos.seg * 3 + 2];
    speed = (cum[pos.seg + 1] - cum[pos.seg]) / Math.max(minutes, 1) * 60;
  }
  const status = pos.atStop
    ? (nextIdx === n - 1 ? 'Arrivé' : `À quai · départ ${fmtTime(f[nextIdx * 3 + 2])}`)
    : `${Math.round(speed)} km/h <small>moy. estimée</small>`;
  const nextStop = stops[f[nextIdx * 3]][0];
  const nextIn = pos.atStop ? 'maintenant' : `${fmtTime(f[nextIdx * 3 + 1])} <small>(${fmtDuration(f[nextIdx * 3 + 1] - t)})</small>`;

  let rows = '';
  for (let i = 0; i < n; i++) {
    const arr = f[i * 3 + 1];
    const dep = f[i * 3 + 2];
    const cls = i < nextIdx ? 'passed' : i === nextIdx ? 'current' : '';
    const time = i === 0 ? fmtTime(dep) : arr === dep || i === n - 1 ? fmtTime(arr) : `${fmtTime(arr)} – ${fmtTime(dep)}`;
    rows += `<li class="${cls}" data-stop="${f[i * 3]}"><span>${escapeHtml(stops[f[i * 3]][0])}</span><span class="time">${time}</span></li>`;
  }

  const following = state.follow ? 'on' : '';
  panel.innerHTML = `
    <div class="ph" style="background:${color}">
      <div><div class="num">${escapeHtml(trip.number)}</div><div class="sub">${escapeHtml(trip.type)}</div></div>
      <button data-action="close" aria-label="Fermer">×</button>
    </div>
    <div class="section">
      <div class="ends">
        <div class="end"><div class="lbl">Départ</div><div class="city">${escapeHtml(trip.origin)}</div><div class="tm">${fmtTime(start)}</div></div>
        <div class="arrow">→</div>
        <div class="end right"><div class="lbl">Arrivée</div><div class="city">${escapeHtml(trip.destination)}</div><div class="tm">${fmtTime(end)}</div></div>
      </div>
      <div class="prog">
        <div class="bar">
          <div class="fill" style="width:${(progress * 100).toFixed(1)}%;background:${color}"></div>
          <svg class="ico" style="left:${(progress * 100).toFixed(1)}%" viewBox="-6 -12 12 24"><path d="M0-10C3.5-8 4-5 4-2V8Q4 10 2 10H-2Q-4 10-4 8V-2C-4-5-3.5-8 0-10Z" fill="${color}" stroke="#fff" stroke-width="1.2"/></svg>
        </div>
        <div class="prog-lbl">
          <span>${Math.round(done)} km · ${fmtDuration(t - start)}</span>
          <span>${Math.round(total - done)} km · ${fmtDuration(end - t)}</span>
        </div>
      </div>
    </div>
    <div class="grid">
      <div><div class="lbl">Vitesse</div><div class="val">${status}</div></div>
      <div><div class="lbl">Prochain arrêt</div><div class="val" title="${escapeHtml(nextStop)}">${escapeHtml(nextStop)}</div></div>
      <div><div class="lbl">Arrivée prochain arrêt</div><div class="val">${nextIn}</div></div>
      <div><div class="lbl">Parcours</div><div class="val">${Math.round(total)} km <small>· ${n} arrêts</small></div></div>
    </div>
    <div class="actions">
      <button data-action="follow" class="${following}">Suivre le train</button>
      <button data-action="route">Voir le trajet</button>
    </div>
    <h3>Arrêts</h3>
    <ul class="stops" style="--c:${color}">${rows}</ul>`;
}

// ---------------------------------------------------------------------------
// Divers

function setStatus(html) {
  const el = document.getElementById('status');
  el.classList.toggle('hidden', !html);
  if (html) el.innerHTML = html;
}

let flashTimer;
function flash(html) {
  setStatus(html);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setStatus(null), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load();
