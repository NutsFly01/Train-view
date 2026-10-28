// Géométrie des voies entre deux gares consécutives :
//   1. découpe des tracés GTFS (shapes.txt) quand l'opérateur les fournit ;
//   2. sinon, plus court chemin sur le réseau ferré OpenStreetMap (extraits Geofabrik) ;
//   3. sinon, rien (le navigateur trace une ligne droite).

import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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
//
// Les voies viennent des extraits Geofabrik, filtrés par scripts/osm-rail.sh avec osmium :
// un fichier OPL par région dans .cache/osm-rail, dont chaque ligne « w… » contient les
// nœuds de la voie avec leurs coordonnées (« Nn12x2.35y48.85,n13x… »).

const CACHE_DIR = join(process.cwd(), '.cache', 'osm-rail');

async function loadRegion(graph, region) {
  const file = join(CACHE_DIR, `${region.replace(/\//g, '_')}.opl`);
  try {
    await stat(file);
  } catch {
    return false;
  }
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.charCodeAt(0) !== 119) continue; // « w »
    const sp = line.indexOf(' ');
    const id = Number(line.slice(1, sp));
    const n = line.indexOf(' N');
    if (n < 0) continue;
    const refs = line.slice(n + 2).split(' ')[0].split(',');
    const nodes = [];
    const geom = [];
    for (const r of refs) {
      const x = r.indexOf('x');
      const y = r.indexOf('y');
      if (x < 0 || y < 0 || y === x + 1) continue; // position inconnue
      nodes.push(Number(r.slice(1, x)));
      geom.push(Number(r.slice(y + 1)), Number(r.slice(x + 1, y)));
    }
    if (nodes.length > 1) graph.addWays([{ id, nodes, geom }]);
  }
  return true;
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

// Calcule les tracés OSM des tronçons `pairs` ([[a, b], …], indices dans `stops`) sur les voies
// des régions Geofabrik `regions`. Renvoie une Map "a,b" -> polyligne ; les tronçons trop
// longs ou introuvables sont ignorés.
export async function routeOnOsm(pairs, stops, regions, log = console.log) {
  const result = new Map();
  if (!pairs.length || !regions?.length) return result;
  const MAX_KM = 600;
  const usable = pairs.filter(([a, b]) => {
    const d = distance(stops[a][1], stops[a][2], stops[b][1], stops[b][2]);
    return d >= 300 && d <= MAX_KM * 1000;
  });

  const graph = new RailGraph();
  const started = Date.now();
  const loaded = [];
  for (const region of regions) if (await loadRegion(graph, region)) loaded.push(region);
  if (!loaded.length) {
    log(`  voies OSM : aucun extrait disponible (${regions.join(', ')}) — lancez scripts/osm-rail.sh`);
    return result;
  }
  log(`  voies OSM : ${graph.lat.length} nœuds (${loaded.join(', ')}) en ${Math.round((Date.now() - started) / 1000)} s`);

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
  log(`  tracés OSM trouvés : ${ok}/${usable.length} (${Math.round((Date.now() - started) / 1000)} s)`);
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
