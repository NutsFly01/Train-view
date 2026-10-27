// Télécharge les horaires théoriques SNCF (GTFS) et produit site/data/network.json,
// un fichier compact que le navigateur utilise pour calculer la position des trains.
//
// Usage :
//   node scripts/build-data.mjs                  # télécharge les flux SNCF par défaut
//   GTFS_URLS="url1 url2" node scripts/build-data.mjs
//   GTFS_FILES="a.zip b.zip" node scripts/build-data.mjs   # fichiers locaux
//   DAYS=7 node scripts/build-data.mjs           # nombre de jours couverts (défaut 7)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'site', 'data', 'network.json');
const TZ = 'Europe/Paris';
const DAYS = Number(process.env.DAYS || 7);

// Flux publiés par SNCF Voyageurs sur transport.data.gouv.fr. On essaie d'abord
// l'export combiné (TGV + Intercités + TER), puis les exports séparés.
const DEFAULT_SOURCES = [
  ['https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip'],
  [
    'https://eu.ftp.opendatasoft.com/sncf/gtfs/export_gtfs_voyages.zip',
    'https://eu.ftp.opendatasoft.com/sncf/gtfs/export-intercites-gtfs-last.zip',
    'https://eu.ftp.opendatasoft.com/sncf/gtfs/export-ter-gtfs-last.zip',
  ],
];

// ---------------------------------------------------------------------------
// Lecture des flux

async function loadFeeds() {
  if (process.env.GTFS_FILES) {
    const files = process.env.GTFS_FILES.split(/\s+/).filter(Boolean);
    return Promise.all(files.map(async (f) => ({ name: f, zip: unzip(await readFile(f)) })));
  }
  const candidates = process.env.GTFS_URLS
    ? [process.env.GTFS_URLS.split(/\s+/).filter(Boolean)]
    : DEFAULT_SOURCES;

  let lastError;
  for (const urls of candidates) {
    try {
      const feeds = [];
      for (const url of urls) {
        console.log(`Téléchargement de ${url}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
        feeds.push({ name: url, zip: unzip(new Uint8Array(await res.arrayBuffer())) });
      }
      return feeds;
    } catch (err) {
      console.warn(`  échec : ${err.message}`);
      lastError = err;
    }
  }
  throw lastError;
}

function unzip(buf) {
  // Certains exports rangent les fichiers dans un sous-dossier : on indexe par nom de base.
  const files = unzipSync(buf, { filter: (f) => f.name.endsWith('.txt') });
  const out = {};
  for (const [path, data] of Object.entries(files)) out[path.split('/').pop()] = data;
  return out;
}

// Parse un CSV GTFS (RFC 4180) et appelle onRow(objet) pour chaque ligne.
function parseCsv(u8, onRow) {
  if (!u8) return;
  let text = strFromU8(u8);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let header = null;
  let row = [];
  let field = '';
  let i = 0;
  const n = text.length;

  const endRow = () => {
    row.push(field);
    field = '';
    if (!header) {
      header = row.map((h) => h.trim());
    } else if (row.length > 1 || row[0] !== '') {
      const obj = {};
      for (let k = 0; k < header.length; k++) obj[header[k]] = row[k] ?? '';
      onRow(obj);
    }
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          break;
        }
        field += text[i++];
      }
    } else if (c === ',') {
      row.push(field); field = ''; i++;
    } else if (c === '\n' || c === '\r') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length) endRow();
}

// ---------------------------------------------------------------------------
// Dates

function parisDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

function weekday(yyyymmdd) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getUTCDay()];
}

const toMinutes = (t) => {
  if (!t) return null;
  const [h, m, s] = t.trim().split(':').map(Number);
  return h * 60 + m + Math.round((s || 0) / 60);
};

// ---------------------------------------------------------------------------
// Type de train (TGV INOUI, OUIGO, TER…)

function trainType(stopId, route, agencyName) {
  // Les identifiants SNCF ressemblent à « StopPoint:OCETGV INOUI-87686006 ».
  const m = /OCE(.+)-[^-]+$/.exec(stopId || '');
  let t = m ? m[1].trim() : '';
  if (!t || /^\d+$/.test(t)) t = route?.route_desc || agencyName || 'Train';
  t = t.replace(/^Train /i, '');
  if (/^INTERCIT/i.test(t)) t = /nuit/i.test(t) ? 'Intercités de nuit' : 'Intercités';
  if (/^TER/i.test(t)) t = 'TER';
  return t;
}

const RAIL_ROUTE_TYPES = (type) => {
  const n = Number(type);
  return n === 0 || n === 1 || n === 2 || (n >= 100 && n < 200) || n === 900;
};

// ---------------------------------------------------------------------------

async function main() {
  const dates = [];
  for (let d = -1; d < DAYS; d++) dates.push(parisDate(d));
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  const feeds = await loadFeeds();

  const stops = [];           // [nom, lat, lon]
  const stopKeyIndex = new Map();
  const types = [];
  const typeIndex = new Map();
  const serviceKeys = new Map(); // "0,1,2" -> index
  const services = [];
  const trips = [];
  const seenTrips = new Set();

  feeds.forEach((feed, feedNo) => {
    const { zip } = feed;

    // Agences et lignes
    const agencies = new Map();
    parseCsv(zip['agency.txt'], (r) => agencies.set(r.agency_id, r.agency_name));
    const routes = new Map();
    parseCsv(zip['routes.txt'], (r) => {
      if (RAIL_ROUTE_TYPES(r.route_type)) routes.set(r.route_id, r);
    });

    // Arrêts : on regroupe les points d'arrêt sur leur gare parente.
    const rawStops = new Map();
    parseCsv(zip['stops.txt'], (r) => rawStops.set(r.stop_id, r));
    const stopIdx = new Map();
    const resolveStop = (id) => {
      if (stopIdx.has(id)) return stopIdx.get(id);
      const s = rawStops.get(id);
      if (!s) return -1;
      const parent = s.parent_station && rawStops.get(s.parent_station);
      const ref = parent && parent.stop_lat ? parent : s;
      const lat = Number(ref.stop_lat);
      const lon = Number(ref.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { stopIdx.set(id, -1); return -1; }
      // Une même gare peut apparaître dans plusieurs flux : on fusionne sur nom + coordonnées arrondies.
      const key = `${ref.stop_name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
      let idx = stopKeyIndex.get(key);
      if (idx === undefined) {
        idx = stops.length;
        stops.push([ref.stop_name.replace(/^gare de /i, ''), +lat.toFixed(5), +lon.toFixed(5)]);
        stopKeyIndex.set(key, idx);
      }
      stopIdx.set(id, idx);
      return idx;
    };

    // Calendriers -> liste des jours (indices dans `dates`) où le service roule.
    const serviceDays = new Map();
    parseCsv(zip['calendar.txt'], (r) => {
      const days = new Set();
      for (const d of dates) {
        if (d >= r.start_date && d <= r.end_date && r[weekday(d)] === '1') days.add(dateIndex.get(d));
      }
      serviceDays.set(r.service_id, days);
    });
    parseCsv(zip['calendar_dates.txt'], (r) => {
      if (!dateIndex.has(r.date)) {
        if (!serviceDays.has(r.service_id)) serviceDays.set(r.service_id, new Set());
        return;
      }
      let days = serviceDays.get(r.service_id);
      if (!days) serviceDays.set(r.service_id, (days = new Set()));
      if (r.exception_type === '1') days.add(dateIndex.get(r.date));
      else if (r.exception_type === '2') days.delete(dateIndex.get(r.date));
    });
    const serviceIndexFor = (serviceId) => {
      const days = serviceDays.get(serviceId);
      if (!days || days.size === 0) return -1;
      const key = [...days].sort((a, b) => a - b).join(',');
      let idx = serviceKeys.get(key);
      if (idx === undefined) {
        idx = services.length;
        services.push(key.split(',').map(Number));
        serviceKeys.set(key, idx);
      }
      return idx;
    };

    // Courses ferroviaires circulant dans la fenêtre de dates.
    const feedTrips = new Map();
    parseCsv(zip['trips.txt'], (r) => {
      const route = routes.get(r.route_id);
      if (!route) return;
      const service = serviceIndexFor(r.service_id);
      if (service < 0) return;
      feedTrips.set(r.trip_id, { r, route, service, stops: [] });
    });

    parseCsv(zip['stop_times.txt'], (r) => {
      const t = feedTrips.get(r.trip_id);
      if (!t) return;
      t.stops.push(r);
    });

    for (const [tripId, t] of feedTrips) {
      if (t.stops.length < 2) continue;
      t.stops.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
      const flat = [];
      let prev = -Infinity;
      let ok = true;
      for (const st of t.stops) {
        const idx = resolveStop(st.stop_id);
        let arr = toMinutes(st.arrival_time);
        let dep = toMinutes(st.departure_time);
        if (arr === null) arr = dep;
        if (dep === null) dep = arr;
        if (idx < 0 || arr === null || arr < prev) { ok = false; break; }
        flat.push(idx, arr, dep);
        prev = dep;
      }
      if (!ok || flat.length < 6) continue;

      const number = (t.r.trip_short_name || t.r.trip_headsign || tripId).trim();
      const type = trainType(t.stops[0].stop_id, t.route, agencies.get(t.route.agency_id));
      // Les flux SNCF dupliquent parfois une même course (ex. train partagé entre deux régions).
      const dedupKey = `${number}|${t.service}|${flat.join(',')}`;
      if (seenTrips.has(dedupKey)) continue;
      seenTrips.add(dedupKey);

      let ti = typeIndex.get(type);
      if (ti === undefined) { ti = types.length; types.push(type); typeIndex.set(type, ti); }
      trips.push([number, ti, t.service, flat]);
    }
    console.log(`${feed.name} : ${feedTrips.size} courses ferroviaires dans la fenêtre`);
  });

  if (trips.length === 0) throw new Error('Aucune course trouvée : vérifiez les flux GTFS.');

  const out = {
    generated: new Date().toISOString(),
    timezone: TZ,
    dates,
    types,
    stops,
    services,
    trips,
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(OUT_FILE, json);
  console.log(`${trips.length} courses, ${stops.length} gares, ${types.length} types -> ${OUT_FILE} (${(json.length / 1e6).toFixed(1)} Mo)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
