// Géométrie des voies entre deux gares consécutives :
//   1. découpe des tracés GTFS (shapes.txt) quand l'opérateur les fournit ;
//   2. sinon, plus court chemin sur le réseau ferré OpenStreetMap (API Overpass) ;
//   3. sinon, rien (le navigateur trace une ligne droite).
// Les tuiles OSM téléchargées sont gardées en cache dans .cache/osm-rail (30 jours).

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const R = 6371000;
const RAD = Math.PI / 180;

export function distance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function polylineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += distance(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return d;
}

// Un tracé est plausible s'il n'est ni beaucoup plus long que la ligne droite, ni plus court.
export function plausible(pts, a, b) {
  if (!pts || pts.length < 2) return false;
  const straight = distance(a[0], a[1], b[0], b[1]);
  const len = polylineLength(pts);
  return len >= straight * 0.9 && len <= Math.max(straight * 2.5, straight + 25000);
}

// ---------------------------------------------------------------------------
// Tracés GTFS

// Indice du point du tracé le plus proche de `p`, en cherchant à partir de `from`.
function nearestIndex(shape, p, from) {
  let best = -1;
  let bestD = Infinity;
  const cos = Math.cos(p[0] * RAD);
  for (let i = from; i < shape.length; i++) {
    const dy = shape[i][0] - p[0];
    const dx = (shape[i][1] - p[1]) * cos;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, meters: Math.sqrt(bestD) * 111320 };
}

// Découpe un tracé complet en morceaux entre gares successives. `stopsLatLon` : [[lat, lon], …].
// Renvoie un tableau (un élément par tronçon) de polylignes, ou null pour un tronçon raté.
export function cutShape(shape, stopsLatLon) {
  const out = [];
  let from = 0;
  let prev = nearestIndex(shape, stopsLatLon[0], 0);
  if (prev.meters > 1500) return stopsLatLon.slice(1).map(() => null);
  from = prev.index;
  for (let i = 1; i < stopsLatLon.length; i++) {
    const cur = nearestIndex(shape, stopsLatLon[i], from);
    if (cur.index < 0 || cur.meters > 1500) { out.push(null); continue; }
    const pts = [stopsLatLon[i - 1], ...shape.slice(prev.index + 1, cur.index), stopsLatLon[i]];
    out.push(plausible(pts, stopsLatLon[i - 1], stopsLatLon[i]) ? pts : null);
    prev = cur;
    from = cur.index;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Réseau ferré OpenStreetMap

const TILE = 1; // tuiles de 1° × 1°
const CACHE_DIR = join(process.cwd(), '.cache', 'osm-rail');
const CACHE_DAYS = 30;
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
let serverIdx = 0;
// Budget de temps pour les téléchargements Overpass, tous pays confondus : au-delà, les tronçons
// restants gardent la ligne droite (les tuiles déjà téléchargées restent en cache pour la suite).
const BUDGET_MS = Number(process.env.OSM_BUDGET_MIN || 70) * 60 * 1000;
const startedAt = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = OVERPASS[serverIdx % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'train-view (rail geometry)' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(240 * 1000),
      });
      if (res.ok) {
        const json = await res.json();
        // Une requête interrompue côté serveur renvoie 200 avec une remarque d'erreur.
        if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(`${url} : ${json.remark}`);
        return json;
      }
      lastErr = new Error(`${url} : HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    serverIdx++;
    await sleep(Math.min(30000, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

// Télécharge (ou lit en cache) les voies d'une tuile : [{ id, nodes: [id…], geom: [lat, lon, lat, lon…] }].
async function loadTile(tx, ty) {
  const file = join(CACHE_DIR, `${ty}_${tx}.json`);
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs < CACHE_DAYS * 86400000) return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // Pas en cache : on télécharge.
  }
  if (Date.now() - startedAt > BUDGET_MS) throw new Error('budget de temps OSM épuisé');
  const s = ty * TILE;
  const w = tx * TILE;
  const query = `[out:json][timeout:200];way["railway"~"^(rail|light_rail|narrow_gauge)$"](${s},${w},${s + TILE},${w + TILE});out skel geom qt;`;
  const json = await overpass(query);
  const ways = [];
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !el.geometry || !el.nodes) continue;
    const geom = [];
    for (const g of el.geometry) geom.push(+g.lat.toFixed(6), +g.lon.toFixed(6));
    ways.push({ id: el.id, nodes: el.nodes, geom });
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(ways));
  return ways;
}

class RailGraph {
  constructor() {
    this.index = new Map(); // id OSM -> indice
    this.lat = [];
    this.lon = [];
    this.adj = [];
    this.ways = new Set();
    this.grid = new Map(); // cellule 0,01° -> indices de nœuds
  }

  node(id, lat, lon) {
    let i = this.index.get(id);
    if (i === undefined) {
      i = this.lat.length;
      this.index.set(id, i);
      this.lat.push(lat);
      this.lon.push(lon);
      this.adj.push([]);
      const key = `${Math.floor(lat * 100)},${Math.floor(lon * 100)}`;
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, (cell = []));
      cell.push(i);
    }
    return i;
  }

  addWays(ways) {
    for (const w of ways) {
      if (this.ways.has(w.id)) continue;
      this.ways.add(w.id);
      let prev = -1;
      for (let k = 0; k < w.nodes.length; k++) {
        const i = this.node(w.nodes[k], w.geom[k * 2], w.geom[k * 2 + 1]);
        if (prev >= 0 && prev !== i) {
          const d = distance(this.lat[prev], this.lon[prev], this.lat[i], this.lon[i]);
          this.adj[prev].push(i, d);
          this.adj[i].push(prev, d);
        }
        prev = i;
      }
    }
  }

  // Nœud le plus proche d'un point (dans un rayon d'environ 1,5 km).
  nearest(lat, lon) {
    let best = -1;
    let bestD = 1500;
    const cy = Math.floor(lat * 100);
    const cx = Math.floor(lon * 100);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (const i of this.grid.get(`${cy + dy},${cx + dx}`) || []) {
          const d = distance(lat, lon, this.lat[i], this.lon[i]);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }

  // A* (heuristique : distance à vol d'oiseau), avec une limite de nœuds explorés.
  route(from, to, maxVisits = 400000) {
    if (from === to) return [from];
    const g = new Map([[from, 0]]);
    const parent = new Map();
    const heap = new MinHeap();
    const h = (i) => distance(this.lat[i], this.lon[i], this.lat[to], this.lon[to]);
    heap.push(h(from), from);
    const closed = new Set();
    let visits = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === to) break;
      if (closed.has(cur)) continue;
      closed.add(cur);
      if (++visits > maxVisits) return null;
      const gc = g.get(cur);
      const adj = this.adj[cur];
      for (let k = 0; k < adj.length; k += 2) {
        const nb = adj[k];
        const ng = gc + adj[k + 1];
        if (ng < (g.get(nb) ?? Infinity)) {
          g.set(nb, ng);
          parent.set(nb, cur);
          heap.push(ng + h(nb), nb);
        }
      }
    }
    if (!parent.has(to)) return null;
    const path = [to];
    for (let c = to; c !== from;) { c = parent.get(c); path.push(c); }
    return path.reverse();
  }
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop();
    const lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c];
        i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// Calcule les tracés OSM des tronçons `pairs` ([[a, b], …], indices dans `stops`).
// Renvoie une Map "a,b" -> polyligne. Les tronçons trop longs ou introuvables sont ignorés.
export async function routeOnOsm(pairs, stops, log = console.log) {
  const result = new Map();
  if (!pairs.length) return result;
  const MAX_KM = 400;

  // Tuiles nécessaires : rectangle englobant de chaque tronçon, avec une marge.
  const tiles = new Set();
  const usable = [];
  for (const [a, b] of pairs) {
    const A = stops[a];
    const B = stops[b];
    const d = distance(A[1], A[2], B[1], B[2]);
    if (d < 300 || d > MAX_KM * 1000) continue;
    usable.push([a, b]);
    const pad = 0.05;
    for (let y = Math.floor((Math.min(A[1], B[1]) - pad) / TILE); y <= Math.floor((Math.max(A[1], B[1]) + pad) / TILE); y++) {
      for (let x = Math.floor((Math.min(A[2], B[2]) - pad) / TILE); x <= Math.floor((Math.max(A[2], B[2]) + pad) / TILE); x++) {
        tiles.add(`${x},${y}`);
      }
    }
  }
  log(`  voies OSM : ${tiles.size} tuiles pour ${usable.length} tronçons`);

  const graph = new RailGraph();
  let loaded = 0;
  let failed = 0;
  const started = Date.now();
  for (const t of tiles) {
    const [x, y] = t.split(',').map(Number);
    try {
      graph.addWays(await loadTile(x, y));
    } catch (err) {
      failed++;
      log(`    tuile ${y},${x} indisponible : ${err.message}`);
    }
    if (++loaded % 25 === 0) log(`    ${loaded}/${tiles.size} tuiles (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  log(`  graphe ferré : ${graph.lat.length} nœuds${failed ? `, ${failed} tuiles manquantes` : ''}`);

  let ok = 0;
  for (const [a, b] of usable) {
    const A = stops[a];
    const B = stops[b];
    const na = graph.nearest(A[1], A[2]);
    const nb = graph.nearest(B[1], B[2]);
    if (na < 0 || nb < 0) continue;
    const path = graph.route(na, nb);
    if (!path) continue;
    const pts = [[A[1], A[2]], ...path.map((i) => [graph.lat[i], graph.lon[i]]), [B[1], B[2]]];
    if (!plausible(pts, [A[1], A[2]], [B[1], B[2]])) continue;
    result.set(`${a},${b}`, pts);
    ok++;
  }
  log(`  tracés OSM trouvés : ${ok}/${usable.length}`);
  return result;
}

// ---------------------------------------------------------------------------
// Simplification (Douglas-Peucker) et encodage (format « polyline » de Google, précision 1e-5)

export function simplify(pts, tolMeters = 12) {
  if (pts.length <= 2) return pts;
  const tol = tolMeters / 111320;
  const cos = Math.cos(pts[0][0] * RAD);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const ay = pts[s][0]; const ax = pts[s][1] * cos;
    const by = pts[e][0]; const bx = pts[e][1] * cos;
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-18;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const py = pts[i][0]; const px = pts[i][1] * cos;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px; const ey = ay + t * dy - py;
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function encodePolyline(pts) {
  let out = '';
  let plat = 0;
  let plon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of pts) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    out += enc(la - plat) + enc(lo - plon);
    plat = la;
    plon = lo;
  }
  return out;
}
