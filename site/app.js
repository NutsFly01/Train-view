// Train View : position estimée des trains à partir des horaires théoriques.
// Entre deux gares, le train est placé par interpolation linéaire entre l'heure
// de départ et l'heure d'arrivée ; pendant un arrêt, il reste en gare.
'use strict';

const TZ = 'Europe/Paris';
const TYPE_COLORS = {
  'TGV INOUI': '#7c3aed',
  'OUIGO': '#e6007e',
  'OUIGO Train Classique': '#f472b6',
  'TER': '#2563eb',
  'Intercités': '#0d9488',
  'Intercités de nuit': '#1e3a8a',
  'Lyria': '#dc2626',
  'ICE': '#9f1239',
  'TramTrain': '#16a34a',
  'Navette': '#d97706',
};
const FALLBACK_COLORS = ['#ca8a04', '#0891b2', '#65a30d', '#c2410c', '#4f46e5', '#64748b'];

const state = {
  data: null,
  trips: [],          // trips enrichis
  markers: new Map(), // clé "trip:jour" -> marker
  hiddenTypes: new Set(),
  query: '',
  selected: null,     // { key, trip, day }
  routeLine: null,
};

// ---------------------------------------------------------------------------
// Carte

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([46.6, 2.4], 6);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Horaires SNCF (GTFS)',
}).addTo(map);
const renderer = L.canvas({ padding: 0.3 });

// ---------------------------------------------------------------------------
// Temps (heure de Paris)

const clockFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parisNow() {
  const p = Object.fromEntries(clockFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}${p.month}${p.day}`,
    minutes: +p.hour * 60 + +p.minute + +p.second / 60,
    label: `${p.hour}:${p.minute}:${p.second}`,
  };
}

const fmtTime = (min) => {
  const m = Math.round(min) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Calcul de position

// Renvoie { lat, lon, seg, atStop, progress } ou null si le train ne circule pas à `t` (minutes).
function positionAt(trip, t) {
  const f = trip.flat;
  const n = f.length / 3;
  if (t < f[2] || t > f[f.length - 2]) return null;
  const stops = state.data.stops;
  for (let i = 0; i < n; i++) {
    const arr = f[i * 3 + 1];
    const dep = f[i * 3 + 2];
    const s = stops[f[i * 3]];
    if (t >= arr && t <= dep) {
      return { lat: s[1], lon: s[2], seg: i, atStop: true, progress: progress(trip, t) };
    }
    if (i < n - 1) {
      const nextArr = f[(i + 1) * 3 + 1];
      if (t > dep && t < nextArr) {
        const s2 = stops[f[(i + 1) * 3]];
        const k = (t - dep) / (nextArr - dep);
        return {
          lat: s[1] + (s2[1] - s[1]) * k,
          lon: s[2] + (s2[2] - s[2]) * k,
          seg: i,
          atStop: false,
          progress: progress(trip, t),
        };
      }
    }
  }
  return null;
}

const progress = (trip, t) => (t - trip.flat[2]) / Math.max(1, trip.flat[trip.flat.length - 2] - trip.flat[2]);

// ---------------------------------------------------------------------------
// Données

async function load() {
  let res;
  try {
    res = await fetch('data/network.json', { cache: 'no-cache' });
  } catch (e) {
    res = null;
  }
  if (!res || !res.ok) {
    setStatus('Horaires introuvables. Générez-les avec <code>npm run data</code>.');
    return;
  }
  const data = await res.json();
  state.data = data;
  const stops = data.stops;
  state.trips = data.trips.map(([number, type, service, flat], i) => {
    const first = stops[flat[0]][0];
    const last = stops[flat[flat.length - 3]][0];
    return {
      id: i,
      number,
      type: data.types[type],
      days: new Set(data.services[service].map((d) => data.dates[d])),
      flat,
      origin: first,
      destination: last,
      search: `${number} ${first} ${last}`.toLowerCase(),
      searchStops: null,
    };
  });

  let extra = 0;
  state.colors = {};
  for (const t of data.types) state.colors[t] = TYPE_COLORS[t] || FALLBACK_COLORS[extra++ % FALLBACK_COLORS.length];

  const today = parisNow().date;
  if (!data.dates.includes(today)) {
    setStatus(`Les horaires chargés couvrent du ${fmtDate(data.dates[1])} au ${fmtDate(data.dates.at(-1))}, pas aujourd'hui. Régénérez les données.`);
  } else {
    setStatus(null);
  }
  buildFilters();
  tick();
  setInterval(tick, 1000);
}

const fmtDate = (d) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;

function shiftDate(yyyymmdd, days) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function setStatus(html) {
  const el = document.getElementById('status');
  el.classList.toggle('hidden', !html);
  if (html) el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Boucle d'affichage

function matches(trip) {
  if (state.hiddenTypes.has(trip.type)) return false;
  if (!state.query) return true;
  if (trip.search.includes(state.query)) return true;
  if (!trip.searchStops) {
    const f = trip.flat;
    const names = [];
    for (let i = 0; i < f.length; i += 3) names.push(state.data.stops[f[i]][0]);
    trip.searchStops = names.join(' ').toLowerCase();
  }
  return trip.searchStops.includes(state.query);
}

function tick() {
  const now = parisNow();
  document.getElementById('clock').textContent = now.label;

  // Un train parti hier soir peut encore rouler après minuit (horaires GTFS > 24:00).
  const serviceDays = [
    { date: now.date, t: now.minutes },
    { date: shiftDate(now.date, -1), t: now.minutes + 1440 },
  ];

  const seen = new Set();
  const counts = {};
  for (const trip of state.trips) {
    for (const { date, t } of serviceDays) {
      if (!trip.days.has(date)) continue;
      const pos = positionAt(trip, t);
      if (!pos) continue;
      counts[trip.type] = (counts[trip.type] || 0) + 1;
      const key = `${trip.id}:${date}`;
      if (!matches(trip) && state.selected?.key !== key) continue;
      seen.add(key);
      let m = state.markers.get(key);
      if (!m) {
        m = L.circleMarker([pos.lat, pos.lon], {
          renderer,
          radius: 5,
          weight: 1.5,
          color: '#fff',
          fillColor: state.colors[trip.type],
          fillOpacity: 1,
        });
        m.bindTooltip(() => `${trip.type} ${trip.number} · ${trip.destination}`, { direction: 'top', offset: [0, -4] });
        m.on('click', () => select(key, trip, date));
        m.addTo(map);
        state.markers.set(key, m);
      } else {
        m.setLatLng([pos.lat, pos.lon]);
      }
      if (state.selected?.key === key) renderPanel(trip, pos, t);
    }
  }

  for (const [key, m] of state.markers) {
    if (!seen.has(key)) {
      m.remove();
      state.markers.delete(key);
      if (state.selected?.key === key) renderArrived();
    }
  }

  if (state.selected) {
    const m = state.markers.get(state.selected.key);
    if (m) { m.setStyle({ radius: 8, weight: 3, color: '#111' }); m.bringToFront(); }
  }

  document.getElementById('count').textContent = seen.size.toLocaleString('fr-FR');
  updateFilterCounts(counts);
}

// ---------------------------------------------------------------------------
// Filtres

function buildFilters() {
  const box = document.getElementById('filters');
  box.innerHTML = '';
  for (const type of state.data.types) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.type = type;
    b.innerHTML = `<span class="dot" style="background:${state.colors[type]}"></span>${escapeHtml(type)} <span class="n">0</span>`;
    b.addEventListener('click', () => {
      if (state.hiddenTypes.has(type)) state.hiddenTypes.delete(type);
      else state.hiddenTypes.add(type);
      b.classList.toggle('off', state.hiddenTypes.has(type));
      tick();
    });
    box.appendChild(b);
  }
}

function updateFilterCounts(counts) {
  for (const b of document.querySelectorAll('#filters .chip')) {
    const n = counts[b.dataset.type] || 0;
    b.querySelector('.n').textContent = n;
    b.classList.toggle('hidden', n === 0 && !state.hiddenTypes.has(b.dataset.type));
  }
}

document.getElementById('search').addEventListener('input', (e) => {
  state.query = e.target.value.trim().toLowerCase();
  tick();
});

// ---------------------------------------------------------------------------
// Panneau de détail

function select(key, trip, date) {
  deselect();
  state.selected = { key, trip, date };
  const pts = [];
  for (let i = 0; i < trip.flat.length; i += 3) {
    const s = state.data.stops[trip.flat[i]];
    pts.push([s[1], s[2]]);
  }
  state.routeLine = L.polyline(pts, { color: state.colors[trip.type], weight: 3, opacity: 0.8, dashArray: '6 6' }).addTo(map);
  document.getElementById('panel').classList.remove('hidden');
  tick();
}

function deselect() {
  if (!state.selected) return;
  const m = state.markers.get(state.selected.key);
  if (m) m.setStyle({ radius: 5, weight: 1.5, color: '#fff' });
  state.routeLine?.remove();
  state.routeLine = null;
  state.selected = null;
  document.getElementById('panel').classList.add('hidden');
}

document.getElementById('close').addEventListener('click', deselect);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') deselect(); });

function renderPanel(trip, pos, t) {
  const f = trip.flat;
  const stops = state.data.stops;
  const color = state.colors[trip.type];
  const nextIdx = pos.atStop ? pos.seg : pos.seg + 1;
  const next = stops[f[nextIdx * 3]][0];
  const nextArr = f[nextIdx * 3 + 1];
  const where = pos.atStop
    ? `À quai à <strong>${escapeHtml(next)}</strong>, départ ${nextIdx * 3 + 3 >= f.length ? '—' : fmtTime(f[nextIdx * 3 + 2])}`
    : `Prochain arrêt : <strong>${escapeHtml(next)}</strong> à ${fmtTime(nextArr)} (dans ${Math.max(1, Math.round(nextArr - t))} min)`;

  let rows = '';
  for (let i = 0; i < f.length / 3; i++) {
    const arr = f[i * 3 + 1];
    const dep = f[i * 3 + 2];
    const passed = i < nextIdx;
    const cls = passed ? 'passed' : i === nextIdx ? 'current' : '';
    const time = i === 0 ? fmtTime(dep) : arr === dep || i === f.length / 3 - 1 ? fmtTime(arr) : `${fmtTime(arr)} – ${fmtTime(dep)}`;
    rows += `<li class="${cls}"><span>${escapeHtml(stops[f[i * 3]][0])}</span><span class="time">${time}</span></li>`;
  }

  document.getElementById('panel-content').innerHTML = `
    <span class="badge" style="background:${color}">${escapeHtml(trip.type)}</span>
    <h2>Train ${escapeHtml(trip.number)}</h2>
    <div class="route">${escapeHtml(trip.origin)} → ${escapeHtml(trip.destination)}</div>
    <div class="progress"><div style="width:${(pos.progress * 100).toFixed(1)}%;background:${color}"></div></div>
    <div class="info">${where}</div>
    <ul class="stops" style="--c:${color}">${rows}</ul>`;
}

function renderArrived() {
  const { trip } = state.selected;
  deselect();
  setStatus(`Le train ${escapeHtml(trip.number)} est arrivé à ${escapeHtml(trip.destination)}.`);
  setTimeout(() => setStatus(null), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load();
