// Télécharge les horaires théoriques (GTFS) des trains de plusieurs pays et produit,
// dans site/data/, un fichier compact par pays plus un index (index.json). Le navigateur
// s'en sert pour calculer la position des trains.
//
// Usage :
//   node scripts/build-data.mjs                     # tous les pays
//   COUNTRIES="fr de" node scripts/build-data.mjs   # seulement certains pays
//   GTFS_FILES="a.zip b.zip" COUNTRIES=fr node scripts/build-data.mjs   # fichiers locaux
//   GTFS_FILES="fr:a.zip de:b.zip" COUNTRIES="fr de" node scripts/build-data.mjs
//   DAYS=3 node scripts/build-data.mjs              # jours couverts à partir d'aujourd'hui
//
// Un pays dont le flux est indisponible est ignoré (avec un avertissement) : les autres
// sont quand même publiés.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'site', 'data');
const DAYS = Number(process.env.DAYS || 3);
const RAIL = (t) => t === 2 || (t >= 100 && t < 200);

// Sources par pays. `sources` est une liste d'alternatives : on prend la première qui
// fonctionne ; chaque alternative peut regrouper plusieurs flux à fusionner.
const COUNTRIES = [
  {
    id: 'fr',
    name: 'France',
    flag: '🇫🇷',
    tz: 'Europe/Paris',
    // Les tram-trains SNCF sont publiés en route_type 0.
    routeTypes: (t) => RAIL(t) || t === 0,
    typeOf: sncfType,
    sources: [
      ['https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip'],
      [
        'https://eu.ftp.opendatasoft.com/sncf/gtfs/export_gtfs_voyages.zip',
        'https://eu.ftp.opendatasoft.com/sncf/gtfs/export-intercites-gtfs-last.zip',
        'https://eu.ftp.opendatasoft.com/sncf/gtfs/export-ter-gtfs-last.zip',
      ],
    ],
  },
  {
    id: 'de',
    name: 'Allemagne',
    flag: '🇩🇪',
    tz: 'Europe/Berlin',
    // gtfs.de : grandes lignes (fv) et trains régionaux (rv), sans les transports urbains.
    sources: [[
      'https://download.gtfs.de/germany/fv_free/latest.zip',
      'https://download.gtfs.de/germany/rv_free/latest.zip',
    ]],
  },
  {
    id: 'ch',
    name: 'Suisse',
    flag: '🇨🇭',
    tz: 'Europe/Zurich',
    // Flux national complet (tous modes, très volumineux) : on ne garde que le train.
    // L'horaire annuel change mi-décembre : on essaie l'année en cours puis la suivante.
    sources: swissSources(),
  },
  {
    id: 'be',
    name: 'Belgique',
    flag: '🇧🇪',
    tz: 'Europe/Brussels',
    sources: [['https://sncb-opendata.hafas.de/gtfs/static/c21ac6758dd25af84cca5b707f3cb3de']],
  },
  {
    id: 'nl',
    name: 'Pays-Bas',
    flag: '🇳🇱',
    tz: 'Europe/Amsterdam',
    sources: [['https://gtfs.ovapi.nl/nl/gtfs-nl.zip'], ['http://gtfs.ovapi.nl/nl/gtfs-nl.zip']],
  },
  {
    id: 'es',
    name: 'Espagne',
    flag: '🇪🇸',
    tz: 'Europe/Madrid',
    // Renfe : grandes lignes / moyenne distance, puis Cercanías.
    sources: [
      [
        'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
        'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
      ],
    ],
  },
  {
    id: 'at',
    name: 'Autriche',
    flag: '🇦🇹',
    tz: 'Europe/Vienna',
    // ÖBB : le nom du fichier change avec l'horaire annuel, on le cherche sur la page du jeu de données.
    sources: [
      { page: 'https://data.oebb.at/de/datensaetze~soll-fahrplan-gtfs~', match: /href="([^"]+\.zip)"/gi, each: true },
      ...yearly((y) => [`https://static.oebb.at/open-data/soll-fahrplan-gtfs/GTFS_OP_${y}_obb.zip`]),
    ],
  },
  {
    id: 'pl',
    name: 'Pologne',
    flag: '🇵🇱',
    tz: 'Europe/Warsaw',
    // Flux maintenus par mkuran.pl (PKP Intercity, Polregio, Koleje Mazowieckie…) : on
    // récupère les noms de fichiers sur la page d'index.
    sources: [
      { page: 'https://mkuran.pl/gtfs/', match: /href="([^"]*(?:pkpic|intercity|polregio|kolej|koleje|km|skm|lka|kd)[^"]*\.zip)"/gi },
    ],
  },
  {
    id: 'dk',
    name: 'Danemark',
    flag: '🇩🇰',
    tz: 'Europe/Copenhagen',
    sources: [['https://www.rejseplanen.info/labs/GTFS.zip'], ['http://www.rejseplanen.info/labs/GTFS.zip']],
  },
  {
    id: 'no',
    name: 'Norvège',
    flag: '🇳🇴',
    tz: 'Europe/Oslo',
    sources: [['https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_norway-aggregated-gtfs.zip']],
  },
  {
    id: 'fi',
    name: 'Finlande',
    flag: '🇫🇮',
    tz: 'Europe/Helsinki',
    sources: [['https://rata.digitraffic.fi/api/v1/trains/gtfs-all.zip']],
    // Le flux contient aussi les trains de marchandises et de service.
    excludeTypes: /^(T|VET|VEV|SAA|PAI|W|TYO|V|MUV|LIV|RV|MV|KUV|PAR)$/,
    categories: { S: 'hs', AE: 'hs', IC: 'gl', PYO: 'gl' },
  },
  {
    id: 'ee',
    name: 'Estonie',
    flag: '🇪🇪',
    tz: 'Europe/Tallinn',
    sources: [
      ['https://peatus.ee/gtfs/gtfs.zip'],
      { page: 'https://peatus.ee/gtfs/', match: /href="([^"]+\.zip)"/gi, each: true },
    ],
  },
  {
    id: 'ie',
    name: 'Irlande',
    flag: '🇮🇪',
    tz: 'Europe/Dublin',
    sources: [['https://www.transportforireland.ie/transitData/Data/GTFS_Irish_Rail.zip']],
  },
  {
    id: 'lu',
    name: 'Luxembourg',
    flag: '🇱🇺',
    tz: 'Europe/Luxembourg',
    // Flux national (tous modes) publié sur data.public.lu ; les liens de ressources sont des
    // identifiants sans extension, dans l'ordre de la page (le plus récent d'abord).
    sources: [{
      page: 'https://data.public.lu/fr/datasets/horaires-et-arrets-des-transport-publics-gtfs/',
      match: /href="(https:\/\/data\.public\.lu\/(?:fr\/)?datasets\/r\/[0-9a-f-]+)"/gi,
      each: true,
      keepOrder: true,
      max: 3,
    }],
  },
  {
    id: 'cz',
    name: 'Tchéquie (Prague)',
    flag: '🇨🇿',
    tz: 'Europe/Prague',
    // Réseau PID : trains de la région de Prague (lignes S et R).
    sources: [['https://data.pid.cz/PID_GTFS.zip']],
  },
  {
    id: 'lt',
    name: 'Lituanie',
    flag: '🇱🇹',
    tz: 'Europe/Vilnius',
    sources: [['https://www.visimarsrutai.lt/gtfs/gtfs_all.zip']],
  },
  {
    id: 'us',
    name: 'États-Unis (Amtrak)',
    flag: '🇺🇸',
    tz: 'America/New_York',
    typeOf: longNameType,
    defaultCategory: 'gl',
    sources: [['https://content.amtrak.com/content/gtfs/GTFS.zip']],
  },
  {
    id: 'us-ny',
    name: 'New York (Metro-North, LIRR)',
    flag: '🇺🇸',
    tz: 'America/New_York',
    typeOf: longNameType,
    defaultCategory: 'sub',
    sources: [[
      'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip',
      'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip',
    ], [
      'http://web.mta.info/developers/data/mnr/google_transit.zip',
      'http://web.mta.info/developers/data/lirr/google_transit.zip',
    ]],
  },
  {
    id: 'us-il',
    name: 'Chicago (Metra)',
    flag: '🇺🇸',
    tz: 'America/Chicago',
    defaultCategory: 'sub',
    sources: [['https://schedules.metrarail.com/gtfs/schedule.zip']],
  },
  {
    id: 'us-ca',
    name: 'San Francisco (Caltrain)',
    flag: '🇺🇸',
    tz: 'America/Los_Angeles',
    typeOf: longNameType,
    defaultCategory: 'sub',
    sources: [['https://data.trilliumtransit.com/gtfs/caltrain-ca-us/caltrain-ca-us.zip']],
  },
  {
    id: 'ca',
    name: 'Canada (VIA Rail)',
    flag: '🇨🇦',
    tz: 'America/Toronto',
    typeOf: longNameType,
    defaultCategory: 'gl',
    sources: [['https://www.viarail.ca/sites/all/files/gtfs/viarail.zip']],
  },
  {
    id: 'ca-on',
    name: 'Toronto (GO Transit)',
    flag: '🇨🇦',
    tz: 'America/Toronto',
    defaultCategory: 'sub',
    sources: [['https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip']],
  },
  {
    id: 'au-vic',
    name: 'Australie (Victoria)',
    flag: '🇦🇺',
    tz: 'Australia/Melbourne',
    // Archive PTV : un zip par mode ; 1 = V/Line (régional), 2 = Metro Trains (banlieue).
    defaultCategory: (feed) => (feed.endsWith('#1/google_transit.zip') ? 'reg' : 'sub'),
    sources: [[
      'https://data.ptv.vic.gov.au/downloads/gtfs.zip#1/google_transit.zip',
      'https://data.ptv.vic.gov.au/downloads/gtfs.zip#2/google_transit.zip',
    ], [
      'http://data.ptv.vic.gov.au/downloads/gtfs.zip#1/google_transit.zip',
      'http://data.ptv.vic.gov.au/downloads/gtfs.zip#2/google_transit.zip',
    ]],
  },
  {
    id: 'au-qld',
    name: 'Australie (Queensland)',
    flag: '🇦🇺',
    tz: 'Australia/Brisbane',
    defaultCategory: 'sub',
    sources: [['https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip']],
  },
  {
    id: 'nz',
    name: 'Nouvelle-Zélande',
    flag: '🇳🇿',
    tz: 'Pacific/Auckland',
    defaultCategory: 'sub',
    // Auckland Transport et Metlink (Wellington).
    sources: [[
      'https://gtfs.at.govt.nz/gtfs.zip',
      'https://static.opendata.metlink.org.nz/v1/gtfs/full.zip',
    ]],
  },
];

// Type = nom long de la ligne (« Northeast Regional », « Acela »…), pour les flux sans code court.
function longNameType(stopId, route, agencyName) {
  return (route.route_long_name || route.route_short_name || agencyName || 'Train').trim();
}

// Alternatives pour un flux dont l'URL dépend de l'année d'horaire (en cours, suivante, précédente).
function yearly(urlsFor) {
  const y = new Date().getFullYear();
  return [y, y + 1, y - 1].map(urlsFor);
}

function swissSources() {
  const y = new Date().getFullYear();
  const out = [];
  for (const year of [y, y + 1, y - 1]) {
    for (const base of ['https://data.opentransportdata.swiss/dataset', 'https://data.opentransportdata.swiss/en/dataset', 'https://opentransportdata.swiss/en/dataset']) {
      out.push([`${base}/timetable-${year}-gtfs2020/permalink`]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Catégories de trains (pour les couleurs et les filtres)

const CATEGORY_RULES = [
  ['hs', /^(TGV|OUIGO$|ICE|AVE$|AVLO$|AVANT$|IRYO|LYRIA|EUROSTAR|THALYS|ECE$|FRECCIA|RJX$|EIP$|PENDOLINO|ACELA)/i],
  ['gl', /^(INTERCIT|IC$|EC$|EN$|NJ$|NIGHTJET|IR$|ICN$|ICD$|ICL$|ALVIA|EUROMED|FLX$|D$|RJ$|INTERREGIO|LD$|TRENHOTEL|EUROCITY|EIC$|TLK$|IC-?L[YT]N$|SJ$|VY$|NACHTTREIN|EUROPEAN|GOVOLTA|TRENCELTA)/i],
  ['sub', /^(S$|S-BAHN|SBAHN|RER|SN$|C$|TRANSILIEN|CERCAN|RODALIES|SPR$|SPRINTER|DART|S-TOG|PENDELTÅG|PROXIMDAD|PROXIMIDAD)/i],
];
// Types de ligne étendus (101 grande vitesse, 102 grandes lignes…) : plus fiables que le nom.
function categoryFromRouteType(t) {
  if (t === 101) return 'hs';
  if (t === 102 || t === 103 || t === 105) return 'gl';
  if (t === 106) return 'reg';
  if (t === 109) return 'sub';
  return null;
}

function categoryFromName(type) {
  const t = type.trim();
  if (/^OUIGO TRAIN CLASSIQUE/i.test(t)) return 'gl';
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return null;
}

// Ordre de priorité : réglage du pays, nom du type, type de ligne étendu, sinon régional.
const categoryOf = (country, feedName, type, routeType) =>
  country.categories?.[type] || categoryFromName(type) || categoryFromRouteType(routeType)
  || (typeof country.defaultCategory === 'function' ? country.defaultCategory(feedName) : country.defaultCategory) || 'reg';

// SNCF : le type est dans l'identifiant d'arrêt, ex. « StopPoint:OCETGV INOUI-87686006 ».
function sncfType(stopId, route, agencyName) {
  const m = /OCE(.+)-[^-]+$/.exec(stopId || '');
  let t = m ? m[1].trim() : '';
  if (!t || /^\d+$/.test(t)) t = route.route_desc || agencyName || 'Train';
  t = t.replace(/^Train /i, '');
  if (/^INTERCIT/i.test(t)) t = /nuit/i.test(t) ? 'Intercités de nuit' : 'Intercités';
  if (/^TER/i.test(t)) t = 'TER';
  return t;
}

// Cas général : préfixe alphabétique du nom court de la ligne (« ICE 23 » → ICE,
// « RE1 » → RE, « S 3 » → S), sinon description de la ligne, sinon l'opérateur.
function genericType(stopId, route, agencyName) {
  for (const s of [route.route_short_name, route.route_desc]) {
    const m = /^\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ-]*)/.exec(s || '');
    if (m && m[1].length <= 14) return m[1].length <= 4 ? m[1].toUpperCase() : m[1];
  }
  return agencyName || 'Train';
}

// ---------------------------------------------------------------------------
// Lecture des zip GTFS en flux (certains fichiers dépassent le gigaoctet décompressé)

// « url#chemin/interne.zip » désigne un zip contenu dans un autre (ex. PTV Victoria).
const outerCache = new Map();
async function download(url) {
  const [outer, inner] = url.split('#');
  let buf = outerCache.get(outer);
  if (!buf) {
    console.log(`  ↓ ${outer}`);
    const res = await fetch(outer, {
      redirect: 'follow',
      headers: { 'User-Agent': 'train-view (GTFS)' },
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!res.ok) throw new Error(`${outer} : HTTP ${res.status}`);
    buf = new Uint8Array(await res.arrayBuffer());
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error(`${outer} : ce n'est pas un fichier zip`);
    console.log(`    ${(buf.length / 1e6).toFixed(1)} Mo`);
    if (inner) outerCache.set(outer, buf);
  }
  if (!inner) return buf;
  const files = unzipSync(buf, { filter: (f) => f.name === inner || f.name.endsWith(`/${inner}`) });
  const found = Object.values(files)[0];
  if (!found) throw new Error(`${url} : fichier interne introuvable`);
  return found;
}

// Lit le fichier `name` du zip et appelle onRow(champs, entêtes) pour chaque ligne CSV.
function readCsv(zip, name, onRow) {
  let found = false;
  const csv = new CsvStream(onRow);
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (file) => {
    if (file.name.split('/').pop() !== name) return;
    found = true;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      csv.push(chunk, final);
    };
    file.start();
  };
  const STEP = 1 << 20;
  for (let i = 0; i < zip.length; i += STEP) uz.push(zip.subarray(i, i + STEP), i + STEP >= zip.length);
  return found;
}

// Analyseur CSV incrémental (RFC 4180) : reçoit des morceaux d'octets.
class CsvStream {
  constructor(onRow) {
    this.onRow = onRow;
    this.decoder = new TextDecoder('utf-8');
    this.rest = '';
    this.header = null;
  }

  push(chunk, final) {
    let text = this.rest + this.decoder.decode(chunk, { stream: !final });
    if (!this.header && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let start = 0;
    let quotes = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34) quotes++;
      else if (c === 10 && quotes % 2 === 0) {
        this.line(text.slice(start, i));
        start = i + 1;
        quotes = 0;
      }
    }
    this.rest = text.slice(start);
    if (final && this.rest) { this.line(this.rest); this.rest = ''; }
  }

  line(l) {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (!l) return;
    const fields = l.includes('"') ? splitQuoted(l) : l.split(',');
    // Certains flux (Renfe Cercanías) complètent les champs avec des espaces.
    if (l.includes(' ')) for (let i = 0; i < fields.length; i++) fields[i] = fields[i].trim();
    if (!this.header) {
      this.header = {};
      fields.forEach((h, i) => { this.header[h.trim()] = i; });
      return;
    }
    this.onRow(fields, this.header);
  }
}

function splitQuoted(l) {
  const out = [];
  let field = '';
  let q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) {
      if (c === '"') {
        if (l[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

// Lecture d'une ligne par nom de colonne.
const col = (f, h, name) => (h[name] === undefined ? '' : f[h[name]] ?? '');
const rowObj = (f, h) => {
  const o = {};
  for (const k in h) o[k] = f[h[k]] ?? '';
  return o;
};

// ---------------------------------------------------------------------------
// Dates

function dateIn(tz, offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}

function weekday(yyyymmdd) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getUTCDay()];
}

const toMinutes = (t) => {
  if (!t) return null;
  const [h, m, s] = t.trim().split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m + Math.round((s || 0) / 60);
};

// ---------------------------------------------------------------------------
// Construction d'un pays

// Trouve sur une page web les liens vers des fichiers GTFS (noms qui changent chaque année).
async function discover(source) {
  const { page, match } = source;
  console.log(`  🔎 ${page}`);
  const res = await fetch(page, { headers: { 'User-Agent': 'train-view (GTFS)' }, signal: AbortSignal.timeout(60 * 1000) });
  if (!res.ok) throw new Error(`${page} : HTTP ${res.status}`);
  const html = await res.text();
  const urls = new Set();
  for (const m of html.matchAll(match)) urls.add(new URL(m[1].replace(/&amp;/g, '&'), page).href);
  // Les noms contiennent souvent l'année : les plus récents d'abord.
  let list = source.keepOrder ? [...urls] : [...urls].sort().reverse();
  if (source.max) list = list.slice(0, source.max);
  if (!list.length) throw new Error(`${page} : aucun lien trouvé`);
  console.log(`    ${list.length} fichier(s) : ${list.map((u) => u.split('/').pop()).join(', ')}`);
  return list;
}

async function downloadAll(urls) {
  // Une alternative est retenue dès qu'au moins un de ses flux a pu être téléchargé.
  const feeds = [];
  for (const url of urls) {
    try {
      feeds.push({ name: url, zip: await download(url) });
    } catch (err) {
      console.warn(`  échec : ${err.message}`);
    }
  }
  return feeds;
}

// Produit successivement les jeux de flux à essayer pour un pays.
async function* feedAlternatives(country) {
  if (process.env.GTFS_FILES) {
    // « a.zip b.zip » (un seul pays) ou « fr:a.zip de:b.zip ».
    const files = process.env.GTFS_FILES.split(/\s+/).filter(Boolean)
      .map((f) => /^[a-z]{2}(-[a-z]+)?:/.test(f) ? f : `${country.id}:${f}`)
      .filter((f) => f.startsWith(`${country.id}:`))
      .map((f) => f.slice(country.id.length + 1));
    if (!files.length) throw new Error('aucun fichier GTFS_FILES pour ce pays');
    yield Promise.all(files.map(async (f) => ({ name: f, zip: new Uint8Array(await readFile(f)) })));
    return;
  }
  for (const source of country.sources) {
    if (Array.isArray(source)) {
      yield downloadAll(source);
      continue;
    }
    let urls;
    try {
      urls = await discover(source);
    } catch (err) {
      console.warn(`  échec : ${err.message}`);
      continue;
    }
    if (source.each) for (const url of urls) yield downloadAll([url]);
    else yield downloadAll(urls);
  }
}

async function buildCountry(country) {
  console.log(`\n== ${country.flag} ${country.name}`);
  let lastError = new Error('aucune source disponible');
  for await (const feeds of feedAlternatives(country)) {
    if (!feeds.length) continue;
    try {
      return buildFromFeeds(country, feeds);
    } catch (err) {
      console.warn(`  échec : ${err.message}`);
      lastError = err;
    }
  }
  throw lastError;
}

function buildFromFeeds(country, feeds) {
  const dates = [];
  // Les horaires GTFS sont exprimés dans le fuseau de l'opérateur (agency_timezone).
  let tz = country.tz;
  readCsv(feeds[0].zip, 'agency.txt', (f, h) => {
    const t = col(f, h, 'agency_timezone');
    if (t && tz === country.tz) {
      try { new Intl.DateTimeFormat('en', { timeZone: t }); tz = t; } catch { /* fuseau inconnu : on garde celui du pays */ }
    }
  });
  for (let d = -1; d < DAYS; d++) dates.push(dateIn(tz, d));
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const keepRoute = country.routeTypes || RAIL;
  const typeOf = country.typeOf || genericType;

  const stops = [];           // [nom, lat, lon]
  const stopKeyIndex = new Map();
  const types = [];
  const typeIndex = new Map();
  const typeCounts = [];
  const serviceKeys = new Map();
  const services = [];
  const trips = [];
  const seenTrips = new Set();

  for (const { name, zip } of feeds) {
    const agencies = new Map();
    readCsv(zip, 'agency.txt', (f, h) => agencies.set(col(f, h, 'agency_id'), col(f, h, 'agency_name')));
    const defaultAgency = agencies.size === 1 ? [...agencies.values()][0] : '';

    const routes = new Map();
    readCsv(zip, 'routes.txt', (f, h) => {
      const rt = Number(col(f, h, 'route_type'));
      if (keepRoute(rt)) routes.set(col(f, h, 'route_id'), { ...rowObj(f, h), rt });
    });
    if (!routes.size) {
      const typesSeen = {};
      readCsv(zip, 'routes.txt', (f, h) => { const t = col(f, h, 'route_type'); typesSeen[t] = (typesSeen[t] || 0) + 1; });
      console.warn(`  ${name} : aucune ligne ferroviaire (route_type présents : ${JSON.stringify(typesSeen)})`);
      continue;
    }

    // Calendriers -> jours (indices dans `dates`) où chaque service circule.
    const serviceDays = new Map();
    readCsv(zip, 'calendar.txt', (f, h) => {
      const r = rowObj(f, h);
      const days = new Set();
      for (const d of dates) {
        if (d >= r.start_date && d <= r.end_date && r[weekday(d)] === '1') days.add(dateIndex.get(d));
      }
      serviceDays.set(r.service_id, days);
    });
    readCsv(zip, 'calendar_dates.txt', (f, h) => {
      const sid = col(f, h, 'service_id');
      let days = serviceDays.get(sid);
      if (!days) serviceDays.set(sid, (days = new Set()));
      const di = dateIndex.get(col(f, h, 'date'));
      if (di === undefined) return;
      if (col(f, h, 'exception_type') === '1') days.add(di);
      else days.delete(di);
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
    readCsv(zip, 'trips.txt', (f, h) => {
      const route = routes.get(col(f, h, 'route_id'));
      if (!route) return;
      const service = serviceIndexFor(col(f, h, 'service_id'));
      if (service < 0) return;
      feedTrips.set(col(f, h, 'trip_id'), {
        route,
        service,
        shortName: col(f, h, 'trip_short_name'),
        headsign: col(f, h, 'trip_headsign'),
        stops: [],
      });
    });

    // Horaires : seulement pour les courses retenues (on lit les arrêts ensuite).
    const usedStopIds = new Set();
    readCsv(zip, 'stop_times.txt', (f, h) => {
      const t = feedTrips.get(f[h.trip_id]);
      if (!t) return;
      const stopId = f[h.stop_id];
      usedStopIds.add(stopId);
      t.stops.push([Number(f[h.stop_sequence]), stopId, f[h.arrival_time], f[h.departure_time]]);
    });

    // Arrêts : regroupés sur leur gare parente quand elle existe.
    const rawStops = new Map();
    const parentIds = new Set();
    readCsv(zip, 'stops.txt', (f, h) => {
      const id = col(f, h, 'stop_id');
      if (!usedStopIds.has(id)) return;
      const parent = col(f, h, 'parent_station');
      if (parent) parentIds.add(parent);
      rawStops.set(id, { name: col(f, h, 'stop_name'), lat: +col(f, h, 'stop_lat'), lon: +col(f, h, 'stop_lon'), parent });
    });
    if (parentIds.size) {
      readCsv(zip, 'stops.txt', (f, h) => {
        const id = col(f, h, 'stop_id');
        if (parentIds.has(id)) rawStops.set(id, { name: col(f, h, 'stop_name'), lat: +col(f, h, 'stop_lat'), lon: +col(f, h, 'stop_lon') });
      });
    }
    const stopIdx = new Map();
    const resolveStop = (id) => {
      if (stopIdx.has(id)) return stopIdx.get(id);
      const s = rawStops.get(id);
      let idx = -1;
      if (s) {
        const parent = s.parent && rawStops.get(s.parent);
        const ref = parent && Number.isFinite(parent.lat) && parent.lat ? parent : s;
        if (Number.isFinite(ref.lat) && Number.isFinite(ref.lon) && (ref.lat || ref.lon)) {
          // Une même gare peut apparaître dans plusieurs flux : fusion sur nom + coordonnées arrondies.
          const key = `${ref.name}|${ref.lat.toFixed(3)}|${ref.lon.toFixed(3)}`;
          idx = stopKeyIndex.get(key);
          if (idx === undefined) {
            idx = stops.length;
            stops.push([ref.name.replace(/^gare de /i, ''), +ref.lat.toFixed(5), +ref.lon.toFixed(5)]);
            stopKeyIndex.set(key, idx);
          }
        }
      }
      stopIdx.set(id, idx);
      return idx;
    };

    let kept = 0;
    for (const [tripId, t] of feedTrips) {
      if (t.stops.length < 2) continue;
      t.stops.sort((a, b) => a[0] - b[0]);
      const flat = [];
      let prev = -Infinity;
      let ok = true;
      for (const [, stopId, arrT, depT] of t.stops) {
        const idx = resolveStop(stopId);
        let arr = toMinutes(arrT);
        let dep = toMinutes(depT);
        if (arr === null) arr = dep;
        if (dep === null) dep = arr;
        if (idx < 0 || arr === null || arr < prev) { ok = false; break; }
        // Deux arrêts consécutifs dans la même gare (quai différent) : on les fusionne.
        if (flat.length && flat[flat.length - 3] === idx) { flat[flat.length - 1] = dep; prev = dep; continue; }
        flat.push(idx, arr, dep);
        prev = dep;
      }
      if (!ok || flat.length < 6) continue;

      const route = t.route;
      const type = typeOf(t.stops[0][1], route, agencies.get(route.agency_id) || defaultAgency);
      // Les flux SNCF classent certains autocars (« Car TER »…) comme des lignes ferroviaires.
      if (/^car\b/i.test(type) || country.excludeTypes?.test(type)) continue;
      const number = (t.shortName || route.route_short_name || t.headsign || tripId).trim();
      const shortName = (route.route_short_name || '').trim();
      const line = shortName && shortName !== number && shortName !== type ? shortName : '';

      const dedupKey = `${number}|${t.service}|${flat.join(',')}`;
      if (seenTrips.has(dedupKey)) continue;
      seenTrips.add(dedupKey);

      const cat = categoryOf(country, name, type, route.rt);
      const typeKey = `${type}|${cat}`;
      let ti = typeIndex.get(typeKey);
      if (ti === undefined) { ti = types.length; types.push([type, cat]); typeIndex.set(typeKey, ti); typeCounts.push(0); }
      typeCounts[ti]++;
      trips.push(line ? [number, ti, t.service, flat, line] : [number, ti, t.service, flat]);
      kept++;
    }
    console.log(`  ${name} : ${kept} courses retenues`);
    if (!kept) {
      // Diagnostic : on indique à quelle étape les courses ont été perdues.
      let calRange = '';
      readCsv(zip, 'calendar.txt', (f, h) => { if (!calRange) calRange = `${col(f, h, 'start_date')}–${col(f, h, 'end_date')}`; });
      let firstException = '';
      readCsv(zip, 'calendar_dates.txt', (f, h) => { if (!firstException) firstException = col(f, h, 'date'); });
      let firstTrip = '';
      readCsv(zip, 'trips.txt', (f, h) => { if (!firstTrip) firstTrip = JSON.stringify(rowObj(f, h)); });
      const withStops = [...feedTrips.values()].filter((t) => t.stops.length >= 2).length;
      console.warn(`    lignes ferroviaires : ${routes.size}, courses dans la fenêtre ${dates[0]}–${dates.at(-1)} : ${feedTrips.size}, avec horaires : ${withStops}, gares lues : ${rawStops.size}/${usedStopIds.size}`);
      console.warn(`    exemple calendar : ${calRange || '—'}, calendar_dates : ${firstException || '—'}, trip : ${firstTrip}`);
    }
  }

  if (!trips.length) throw new Error('aucune course trouvée');
  // Résumé des types trouvés, utile pour ajuster les catégories.
  const summary = types.map((t, i) => [t, typeCounts[i]]).sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`  types : ${summary.map(([[t, c], n]) => `${t} (${c}) ${n}`).join(', ')}`);
  return {
    id: country.id,
    name: country.name,
    flag: country.flag,
    generated: new Date().toISOString(),
    timezone: tz,
    dates,
    types,
    stops,
    services,
    trips,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const wanted = process.env.COUNTRIES ? process.env.COUNTRIES.split(/[\s,]+/).filter(Boolean) : null;
  const list = COUNTRIES.filter((c) => !wanted || wanted.includes(c.id));
  if (process.env.GTFS_FILES && list.length !== 1 && !/(^|\s)[a-z]{2}(-[a-z]+)?:/.test(process.env.GTFS_FILES)) {
    throw new Error('GTFS_FILES sans préfixe de pays nécessite un seul pays (ex. COUNTRIES=fr).');
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const index = { generated: new Date().toISOString(), countries: [] };
  for (const country of list) {
    try {
      const data = await buildCountry(country);
      const json = JSON.stringify(data);
      const file = `${country.id}.json`;
      await writeFile(join(OUT_DIR, file), json);
      index.countries.push({ id: country.id, name: country.name, flag: country.flag, file, trips: data.trips.length });
      console.log(`  → ${file} : ${data.trips.length} courses, ${data.stops.length} gares (${(json.length / 1e6).toFixed(1)} Mo)`);
    } catch (err) {
      console.warn(`  ⚠ ${country.name} ignoré : ${err.message}`);
    }
  }

  if (!index.countries.length) throw new Error('Aucun pays n’a pu être généré.');
  await writeFile(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`\nPays publiés : ${index.countries.map((c) => c.name).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
