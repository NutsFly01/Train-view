// Train View : position estimée des trains à partir des horaires théoriques.
// Entre deux gares, le train est placé par interpolation linéaire entre l'heure
// de départ et l'heure d'arrivée ; pendant un arrêt, il reste en gare.
'use strict';

const TZ = 'Europe/Paris';
// Catégories communes à tous les pays (couleurs et filtres).
const CATEGORIES = {
  hs: { label: 'Grande vitesse', color: '#8b5cf6' },
  gl: { label: 'Grandes lignes', color: '#14b8a6' },
  reg: { label: 'Régional', color: '#3b82f6' },
  sub: { label: 'Banlieue / S-Bahn', color: '#f59e0b' },
};

const state = {
  countries: [],       // pays chargés : { id, name, flag, data }
  trips: [],
  usedStops: [],       // gares desservies (tous pays), pour la carte et la recherche
  active: [],          // trains en circulation : { key, trip, date, offset }
  hiddenCats: new Set(),
  hiddenCountries: new Set(),
  selected: null,      // élément de `active`
  follow: false,
  hover: null,
  drawn: [],           // positions écran des trains dessinés (pour le clic)
  pendingNumber: null, // train à sélectionner depuis l'URL
};

const isHidden = (trip) => state.hiddenCats.has(trip.cat) || state.hiddenCountries.has(trip.country.id);

// ---------------------------------------------------------------------------
// Temps : les horaires GTFS sont exprimés dans le fuseau de chaque pays.

const formatters = {};
function timeIn(tz, ms) {
  const fmt = formatters[tz] || (formatters[tz] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}${p.month}${p.day}`,
    minutes: +p.hour * 60 + +p.minute + (+p.second + (ms % 1000) / 1000) / 60,
    label: `${p.hour}:${p.minute}:${p.second}`,
  };
}

// Instantané de l'heure courante, décliné par fuseau à la demande.
function clock() {
  const ms = Date.now();
  const cache = {};
  return { in: (tz) => cache[tz] || (cache[tz] = timeIn(tz, ms)) };
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
  const stops = trip.S;
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
      const g = segment(trip, i - 1);
      if (g) {
        // Sur la voie réelle : on avance de la même fraction de la longueur du tracé.
        const p = pointAlong(g, k * g.len);
        return { lat: p[0], lon: p[1], seg: i - 1, k, atStop: false, g };
      }
      return { lat: a[1] + (b[1] - a[1]) * k, lon: a[2] + (b[2] - a[2]) * k, seg: i - 1, k, atStop: false };
    }
  }
  const last = stops[f[(n - 1) * 3]];
  return { lat: last[1], lon: last[2], seg: n - 1, k: 0, atStop: true };
}

// Distances cumulées (km) le long du trajet (voie réelle si connue), calculées à la demande.
function cumulativeKm(trip) {
  if (trip.cum) return trip.cum;
  const stops = trip.S;
  const cum = [0];
  for (let i = 3; i < trip.flat.length; i += 3) {
    const g = segment(trip, i / 3 - 1);
    cum.push(cum[cum.length - 1] + (g ? g.len / 1000 : haversine(stops[trip.flat[i - 3]], stops[trip.flat[i]])));
  }
  return (trip.cum = cum);
}

// ---------------------------------------------------------------------------
// Tracés des voies entre deux gares (fournis par les données, encodés au format « polyline »)

function decodePolyline(str) {
  const pts = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

function withLengths(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + haversine([0, pts[i - 1][0], pts[i - 1][1]], [0, pts[i][0], pts[i][1]]) * 1000);
  }
  return { pts, cum, len: cum[cum.length - 1] };
}

// Tracé du tronçon entre la gare i et la gare i+1 du train (orienté dans son sens), ou null.
function segment(trip, i) {
  const country = trip.country;
  const a = trip.flat[i * 3];
  const b = trip.flat[(i + 1) * 3];
  if (a === undefined || b === undefined || !country.data.segs) return null;
  const key = a < b ? `${a},${b}` : `${b},${a}`;
  const ck = a < b ? key : `${key}r`;
  let g = country.segCache.get(ck);
  if (g === undefined) {
    const enc = country.data.segs[key];
    g = null;
    if (enc) {
      const pts = decodePolyline(enc);
      g = withLengths(a < b ? pts : pts.reverse());
    }
    country.segCache.set(ck, g);
  }
  return g;
}

// Point situé à `d` mètres du début du tracé.
function pointAlong(g, d) {
  const { pts, cum } = g;
  if (d <= 0) return pts[0];
  if (d >= g.len) return pts[pts.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const k = (d - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * k, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * k];
}

// Points (lat, lon) du tronçon i, voie réelle ou ligne droite.
function segmentPoints(trip, i) {
  const g = segment(trip, i);
  if (g) return g.pts;
  const a = trip.S[trip.flat[i * 3]];
  const b = trip.S[trip.flat[(i + 1) * 3]];
  return [[a[1], a[2]], [b[1], b[2]]];
}

const tNow = (item, now) => now.in(item.trip.tz).minutes + item.offset;

// ---------------------------------------------------------------------------
// Carte

const map = L.map('map', { zoomControl: false, minZoom: 2, worldCopyJump: true });
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
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Horaires : SNCF, DB (gtfs.de), CFF, SNCB, OVapi, Renfe (GTFS)',
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
    map.setView([47, 5], 5);
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
  // Orientation à l'écran : direction de la voie autour du train (à ±150 m sur le tracé),
  // sinon direction du tronçon en cours (ou du suivant si le train est à quai).
  const f = trip.flat;
  const n = f.length / 3;
  let i = pos.seg;
  if (i >= n - 1) i = n - 2;
  const g = pos.g || segment(trip, i);
  let a;
  let b;
  if (g) {
    const d = pos.g ? pos.k * g.len : (pos.seg >= n - 1 ? g.len : 0);
    a = pointAlong(g, d - 150);
    b = pointAlong(g, d + 150);
  } else {
    const sa = trip.S[f[i * 3]];
    const sb = trip.S[f[(i + 1) * 3]];
    a = [sa[1], sa[2]];
    b = [sb[1], sb[2]];
  }
  const pa = map.latLngToContainerPoint(a);
  const pb = map.latLngToContainerPoint(b);
  return Math.atan2(pb.x - pa.x, -(pb.y - pa.y));
}

function draw() {
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);
  if (!state.trips.length) return;
  const now = clock();
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.1);

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
    if (isHidden(item.trip)) continue;
    const pos = positionAt(item.trip, tNow(item, now));
    if (!pos || !bounds.contains([pos.lat, pos.lon])) continue;
    const p = map.latLngToContainerPoint([pos.lat, pos.lon]);
    drawTrain(p, bearing(item.trip, pos), icon, item.trip.color, item === state.hover);
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
  const stops = trip.S;
  const n = f.length / 3;
  const pts = [];
  for (let i = 0; i < f.length; i += 3) {
    const s = stops[f[i]];
    pts.push(map.latLngToContainerPoint([s[1], s[2]]));
  }
  const cur = map.latLngToContainerPoint([pos.lat, pos.lon]);
  const color = trip.color;
  const line = (latlngs) => {
    for (const ll of latlngs) {
      const p = map.latLngToContainerPoint(ll);
      ctx.lineTo(p.x, p.y);
    }
  };

  // Le tronçon en cours est coupé à la position du train.
  const g = pos.g;
  const cutAt = g ? pos.k * g.len : 0;
  const curSeg = Math.min(pos.seg, n - 2);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Partie parcourue (sur les voies réelles quand le tracé est connu).
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pos.seg && i < n - 1; i++) line(segmentPoints(trip, i));
  if (g) line(g.pts.filter((_, j) => g.cum[j] < cutAt));
  ctx.lineTo(cur.x, cur.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();
  // Partie restante.
  ctx.beginPath();
  ctx.moveTo(cur.x, cur.y);
  if (pos.seg < n - 1) {
    if (g) line(g.pts.filter((_, j) => g.cum[j] > cutAt));
    else if (pos.atStop) line(segmentPoints(trip, curSeg));
    else line(segmentPoints(trip, curSeg).slice(-1));
    for (let i = pos.seg + 1; i < n - 1; i++) line(segmentPoints(trip, i));
  }
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
    tooltip.innerHTML = `${t.country.flag} <b>${escapeHtml(t.number)}</b> ${escapeHtml(t.label)} · ${escapeHtml(t.origin)} → ${escapeHtml(t.destination)}`;
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

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    // Ouverture en file:// ou réseau indisponible : géré par l'appelant.
    return null;
  }
}

// Charge l'index des pays, puis chaque pays en parallèle : les trains apparaissent
// au fur et à mesure que les fichiers arrivent.
async function load() {
  const index = await fetchJson('data/index.json');
  if (!index) {
    setStatus('Horaires introuvables. Générez-les avec <code>npm run data</code> puis ouvrez le site via <code>npm run serve</code>.');
    return;
  }
  setStatus(`Chargement des horaires (${index.countries.map((c) => c.flag).join(' ')})…`);
  buildFilters(index.countries);
  setInterval(refreshActive, 1000);
  requestAnimationFrame(loop);

  let pending = index.countries.length;
  await Promise.all(index.countries.map(async (c) => {
    const data = await fetchJson(`data/${c.file}`);
    pending--;
    if (data) addCountry(c, data);
    if (pending) setStatus(`Chargement des horaires… (${index.countries.length - pending}/${index.countries.length})`);
  }));
  state.allLoaded = true;
  setStatus(null);
  checkDates();
  refreshActive();
}

function addCountry(meta, data) {
  const country = { id: meta.id, name: meta.name, flag: meta.flag, data, segCache: new Map() };
  state.countries.push(country);
  const stops = data.stops;
  const used = new Set();
  const days = data.services.map((svc) => new Set(svc.map((d) => data.dates[d])));
  for (const [number, typeIdx, service, flat, line] of data.trips) {
    for (let k = 0; k < flat.length; k += 3) used.add(flat[k]);
    const [type, cat] = data.types[typeIdx];
    // Libellé affiché : type + numéro de ligne quand il apporte quelque chose (« RE 1 », « S 3 »).
    const label = line && line.replace(/\s+/g, '').toUpperCase() !== type.toUpperCase() && line.toUpperCase().startsWith(type.toUpperCase())
      ? line : type;
    state.trips.push({
      id: state.trips.length,
      number,
      type,
      label,
      cat,
      color: CATEGORIES[cat].color,
      country,
      tz: data.timezone,
      S: stops,
      days: days[service],
      flat,
      origin: stops[flat[0]][0],
      destination: stops[flat[flat.length - 3]][0],
    });
  }
  for (const i of used) state.usedStops.push(stops[i]);
  refreshActive();
}

function checkDates() {
  const now = clock();
  const stale = state.countries.filter((c) => !c.data.dates.includes(now.in(c.data.timezone).date));
  if (stale.length) {
    setStatus(`Horaires périmés pour ${stale.map((c) => c.name).join(', ')}. Régénérez les données avec <code>npm run data</code>.`);
  }
}

// Liste des trains en circulation, recalculée chaque seconde.
function refreshActive() {
  const now = clock();
  document.getElementById('clock').textContent = now.in(TZ).label;

  // Un train parti la veille au soir peut encore rouler après minuit (horaires GTFS > 24:00).
  const daysByTz = {};
  const daysFor = (tz) => {
    if (daysByTz[tz]) return daysByTz[tz];
    const c = now.in(tz);
    return (daysByTz[tz] = [
      { date: c.date, offset: 0, minutes: c.minutes },
      { date: shiftDate(c.date, -1), offset: 1440, minutes: c.minutes },
    ]);
  };
  const previous = new Map(state.active.map((a) => [a.key, a]));
  const active = [];
  const counts = {};
  for (const trip of state.trips) {
    for (const { date, offset, minutes } of daysFor(trip.tz)) {
      if (!trip.days.has(date)) continue;
      const t = minutes + offset;
      if (t < trip.flat[2] || t > trip.flat[trip.flat.length - 2]) continue;
      const key = `${trip.id}:${date}`;
      // On réutilise l'objet existant pour garder la sélection et le survol.
      active.push(previous.get(key) || { key, trip, date, offset });
      counts[trip.cat] = (counts[trip.cat] || 0) + 1;
      counts[trip.country.id] = (counts[trip.country.id] || 0) + 1;
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
    if (item || state.allLoaded) state.pendingNumber = null;
    if (item) select(item, { pan: false });
  }

  const visible = active.filter((a) => !isHidden(a.trip)).length;
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
// Filtres : catégories de trains et pays

function buildFilters(countries) {
  const box = document.getElementById('filters');
  box.innerHTML = '';
  const add = (key, set, html, extraClass = '') => {
    const b = document.createElement('button');
    b.className = `chip ${extraClass}`;
    b.dataset.key = key;
    b.title = 'Afficher / masquer';
    b.innerHTML = `${html}<span class="n">0</span>`;
    b.addEventListener('click', () => {
      if (set.has(key)) set.delete(key);
      else set.add(key);
      b.classList.toggle('off', set.has(key));
      refreshActive();
    });
    box.appendChild(b);
  };
  for (const [key, c] of Object.entries(CATEGORIES)) {
    add(key, state.hiddenCats, `<span class="dot" style="background:${c.color}"></span><span class="label">${c.label}</span>`);
  }
  if (countries.length > 1) {
    // Liste des pays repliable : elle devient longue.
    const toggle = document.createElement('button');
    toggle.className = 'chip toggle';
    toggle.innerHTML = `<span class="label">Pays (${countries.length})</span><span class="caret">▾</span>`;
    toggle.addEventListener('click', () => box.classList.toggle('collapsed'));
    box.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
    box.appendChild(toggle);
    for (const c of countries) {
      add(c.id, state.hiddenCountries, `<span class="flag">${c.flag}</span><span class="label">${escapeHtml(c.name)}</span>`, 'country');
    }
    if (countries.length > 6) box.classList.add('collapsed');
  }
}

function updateFilterCounts(counts) {
  for (const b of document.querySelectorAll('#filters .chip[data-key]')) {
    b.querySelector('.n').textContent = (counts[b.dataset.key] || 0).toLocaleString('fr-FR');
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
  if (!q || !state.trips.length) { resultsBox.classList.add('hidden'); results = []; return; }

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
      return `<li data-i="${i}" class="${i === resultIdx ? 'active' : ''}"><span class="tag" style="background:${t.color}">${escapeHtml(t.number)}</span><span class="main">${t.country.flag} ${escapeHtml(t.origin)} → ${escapeHtml(t.destination)} <small>${escapeHtml(t.label)}</small></span></li>`;
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
    const pos = positionAt(item.trip, tNow(item, clock()));
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
    for (let i = 0; i < f.length; i += 3) { const s = state.selected.trip.S[f[i]]; pts.push([s[1], s[2]]); }
    setFollow(false);
    const wide = innerWidth > 720;
    map.flyToBounds(pts, {
      paddingTopLeft: [wide ? panel.offsetWidth + 40 : 30, 40],
      paddingBottomRight: [40, wide ? 40 : map.getSize().y * 0.6 + 20],
      duration: 1,
    });
  } else if (li) {
    const s = state.selected.trip.S[+li.dataset.stop];
    setFollow(false);
    const z = Math.max(map.getZoom(), 11);
    map.flyTo(visibleCenter([s[1], s[2]], z), z, { duration: 1 });
  }
});

function renderPanel() {
  const item = state.selected;
  if (!item) return;
  const { trip } = item;
  const now = clock();
  const t = tNow(item, now);
  const pos = positionAt(trip, t);
  if (!pos) return;

  const f = trip.flat;
  const n = f.length / 3;
  const stops = trip.S;
  const color = trip.color;
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
      <div><div class="num">${escapeHtml(trip.number)}</div><div class="sub">${trip.country.flag} ${escapeHtml(trip.label)} · ${CATEGORIES[trip.cat].label}</div></div>
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
