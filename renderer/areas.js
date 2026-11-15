// Zone vietate, regolamentate, pericolose e riservate all'attività militare (TSA/TRA) della carta FRA:
// proiezione sul piano del settore, orari di attivazione della sessione e verifiche geometriche.
// Una zona attiva non si attraversa: nessun volo di nostra competenza può entrare nel suo volume.
import { SPECIAL_AREAS } from './data/areas.js';
import { pointInPolygon, distanceToPolygon, boundingBox, polygonArea } from './geo.js';

export const AREA_KINDS = {
  P: 'zona vietata',
  R: 'zona regolamentata',
  D: 'zona pericolosa',
  TSA: 'area riservata temporanea',
  TRA: 'area riservata temporanea',
};

// Valori di simulazione: un volo è troppo vicino a una zona attiva se, a un livello compreso fra i suoi limiti
// (con AREA_BUFFER_FT di margine), è a meno di AREA_BUFFER_NM dal suo confine, oppure se la previsione lungo
// rotta e livello autorizzato lo porta dentro entro APW_S secondi (Area Proximity Warning).
export const AREA_BUFFER_NM = 2.5;
export const AREA_BUFFER_FT = 500;
export const APW_S = 120;
export const PREACTIVE_S = 15 * 60; // la zona in procinto di attivarsi si mostra 15 minuti prima

const AREA_VIEW_MARGIN_NM = 120;

// Zone vicine al radar del settore, proiettate: {id, kind, name, lowerFt, upperFt, lowerText, upperText,
// polygon [{x, y}], bbox, labelAt {x, y}, stack (posizione dell'etichetta fra le zone con lo stesso contorno)}.
export function projectAreas(proj, view) {
  const areas = [];
  const stacks = new Map();
  SPECIAL_AREAS.forEach((a, i) => {
    const polygon = a.polygon.map(([lat, lon]) => proj.toXY(lat, lon));
    const bbox = boundingBox(polygon);
    if (bbox.xMax < view.xMin - AREA_VIEW_MARGIN_NM || bbox.xMin > view.xMax + AREA_VIEW_MARGIN_NM
      || bbox.yMax < view.yMin - AREA_VIEW_MARGIN_NM || bbox.yMin > view.yMax + AREA_VIEW_MARGIN_NM) return;
    // zone con lo stesso contorno e blocchi di livelli diversi (per esempio R46B e R46C): etichette impilate
    const key = a.polygon.map((p) => p.join(',')).join(';');
    const stack = stacks.get(key) ?? 0;
    stacks.set(key, stack + 1);
    areas.push({
      id: `${a.name}#${i}`,
      kind: a.kind,
      name: a.name,
      lowerFt: a.lowerFt,
      upperFt: a.upperFt,
      lowerText: a.lowerText,
      upperText: a.upperText,
      polygon,
      bbox,
      areaNm2: polygonArea(polygon),
      labelAt: labelPoint(polygon, bbox),
      stack,
    });
  });
  return areas;
}

// Punto interno per l'etichetta: il baricentro se cade dentro la zona, altrimenti il punto interno più lontano
// dal confine su una griglia (zone a L o a mezzaluna).
function labelPoint(polygon, bbox) {
  const c = polygon.reduce((s, p) => ({ x: s.x + p.x / polygon.length, y: s.y + p.y / polygon.length }), { x: 0, y: 0 });
  if (pointInPolygon(c.x, c.y, polygon) && distanceToPolygon(c, polygon) > 2) return c;
  let best = c;
  let bestD = -1;
  for (let i = 1; i < 12; i++) {
    for (let j = 1; j < 12; j++) {
      const p = { x: bbox.xMin + ((bbox.xMax - bbox.xMin) * i) / 12, y: bbox.yMin + ((bbox.yMax - bbox.yMin) * j) / 12 };
      if (!pointInPolygon(p.x, p.y, polygon)) continue;
      const d = distanceToPolygon(p, polygon);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

export const fmtAreaLevel = (text) => text.replace(/^FL\s*/, 'FL').replace(/\s*ft\s*/i, 'ft ').trim();
export const areaBand = (area) => `${fmtAreaLevel(area.lowerText)}–${fmtAreaLevel(area.upperText)}`;

// La zona interessa lo strato del settore: i suoi limiti si sovrappongono ai nostri livelli (con un margine).
export function areaOverlapsBand(area, floorFt, ceilingFt, marginFt = 0) {
  return area.lowerFt < ceilingFt + marginFt && area.upperFt > floorFt - marginFt;
}

export function areaContains(area, p, altFt) {
  return altFt >= area.lowerFt && altFt <= area.upperFt
    && p.x >= area.bbox.xMin && p.x <= area.bbox.xMax && p.y >= area.bbox.yMin && p.y <= area.bbox.yMax
    && pointInPolygon(p.x, p.y, area.polygon);
}

// Troppo vicino: livello fra i limiti (con margine) e distanza dal confine sotto il minimo, oppure già dentro.
// Il margine verticale è quello minimo: un volo 500 ft sotto il limite inferiore (FL240 sotto una zona da FL245)
// o 500 ft sopra quello superiore è separato dalla zona e non fa scattare l'allarme.
export function areaTooClose(area, p, altFt) {
  if (altFt <= area.lowerFt - AREA_BUFFER_FT || altFt >= area.upperFt + AREA_BUFFER_FT) return false;
  const b = area.bbox;
  const m = AREA_BUFFER_NM;
  if (p.x < b.xMin - m || p.x > b.xMax + m || p.y < b.yMin - m || p.y > b.yMax + m) return false;
  return pointInPolygon(p.x, p.y, area.polygon) || distanceToPolygon(p, area.polygon) < m;
}

// --- orari di attivazione ---------------------------------------------------------------------------------
// Come nella realtà una zona si attiva solo quando serve: per una missione (addestramento, tiri, esercitazione)
// pubblicata nel piano giornaliero dello spazio aereo (AUP/UUP). Le missioni arrivano a caso nel tempo, ognuna
// attiva una zona, a volte con uno o due blocchi vicini dello stesso tipo (lo stesso poligono di tiro su più
// livelli, un complesso di TRA), per 30-120 minuti. Quasi tutte le zone restano quindi spente e in ogni momento
// ce ne sono poche attive; attorno al settore non più di MAX_RELEVANT_ACTIVE insieme. Orari ai 5 minuti; le zone
// vietate sono sempre attive.

const MIN = 60;
const round5 = (s) => Math.round(s / (5 * MIN)) * 5 * MIN;
const between = (lo, hi) => lo + Math.random() * (hi - lo);
const MISSIONS_PER_HOUR_RELEVANT = 0.7; // missioni nelle zone che riguardano il settore
const MISSIONS_PER_HOUR_OTHER = 1;      // missioni nel resto del radar
const MISSION_MIN = [30, 120];          // durata di una missione (minuti)
const MAX_RELEVANT_ACTIVE = 3;          // zone attive insieme attorno ai livelli del settore
const NEIGHBOUR_NM = 8;                 // blocchi vicini che la stessa missione può attivare
const PLAN_BEFORE_S = 3 * 3600;         // il piano copre da 3 ore prima dell'inizio a 8 ore dopo
const PLAN_AFTER_S = 8 * 3600;

const missionLength = () => round5((MISSION_MIN[0] + (MISSION_MIN[1] - MISSION_MIN[0]) * Math.random() ** 1.5) * MIN);
const expGap = (perHour) => (-Math.log(1 - Math.random()) / perHour) * 3600;

const overlaps = (w, s, e) => w.some(([a, b]) => a < e && b > s);

// Zone dello stesso tipo che toccano la zona (entro NEIGHBOUR_NM), comprese quelle con lo stesso contorno.
function neighbours(area, pool) {
  return pool.filter((o) => o !== area && o.kind === area.kind
    && o.bbox.xMin < area.bbox.xMax + NEIGHBOUR_NM && o.bbox.xMax > area.bbox.xMin - NEIGHBOUR_NM
    && o.bbox.yMin < area.bbox.yMax + NEIGHBOUR_NM && o.bbox.yMax > area.bbox.yMin - NEIGHBOUR_NM
    && Math.min(...o.polygon.map((p) => (pointInPolygon(p.x, p.y, area.polygon) ? 0 : distanceToPolygon(p, area.polygon)))) < NEIGHBOUR_NM);
}

// Missioni casuali su un gruppo di zone. relevantSet: le zone che contano per il tetto di contemporaneità.
function planMissions(schedule, pool, perHour, from, to, relevantSet) {
  if (!pool.length) return;
  const activeRelevantAt = (t) => [...relevantSet].filter((a) => overlaps(schedule.get(a.id), t, t + 1)).length;
  for (let t = from + expGap(perHour); t < to; t += expGap(perHour)) {
    const seed = pool[Math.floor(Math.random() * pool.length)];
    const zones = [seed];
    for (const n of neighbours(seed, pool)) if (zones.length < 3 && Math.random() < 0.4) zones.push(n);
    const s = round5(t);
    const e = s + missionLength();
    if (zones.some((z) => overlaps(schedule.get(z.id), s - 10 * MIN, e + 10 * MIN))) continue;
    // il tetto si verifica ogni 5 minuti lungo tutta la missione
    const extra = zones.filter((z) => relevantSet.has(z)).length;
    let fits = true;
    for (let k = s; k < e && fits && extra; k += 5 * MIN) fits = activeRelevantAt(k) + extra <= MAX_RELEVANT_ACTIVE;
    if (!fits) continue;
    for (const z of zones) schedule.get(z.id).push([s, e]);
  }
}

// La zona riguarda il settore: livelli sovrapposti (con 2000 ft di margine) e contorno dentro il settore o a
// meno di 40 NM dal suo confine.
export function isAreaRelevant(area, sector) {
  if (!areaOverlapsBand(area, sector.floorFt, sector.ceilingFt, 2000)) return false;
  const inside = area.polygon.some((p) => pointInPolygon(p.x, p.y, sector.polygon))
    || sector.polygon.some((p) => pointInPolygon(p.x, p.y, area.polygon));
  return inside || Math.min(...area.polygon.map((p) => distanceToPolygon(p, sector.polygon))) < 40;
}

// Fasce orarie di ogni zona per la sessione che inizia alle clockStartS (secondi UTC dalla mezzanotte).
// sector: {polygon, floorFt, ceilingFt}. Restituisce Map id -> [[inizio, fine], ...] in secondi UTC assoluti.
export function makeAreaSchedule(areas, sector, clockStartS) {
  const schedule = new Map();
  const relevant = [];
  const others = [];
  for (const a of areas) {
    if (a.kind === 'P') {
      schedule.set(a.id, [[-Infinity, Infinity]]);
      continue;
    }
    schedule.set(a.id, []);
    (isAreaRelevant(a, sector) ? relevant : others).push(a);
  }
  const relevantSet = new Set(relevant);
  const from = clockStartS - PLAN_BEFORE_S;
  const to = clockStartS + PLAN_AFTER_S;
  // una missione in corso all'inizio e una che comincia nei primi 25 minuti: la partita non parte a vuoto
  if (relevant.length) {
    const shuffled = [...relevant].sort(() => Math.random() - 0.5);
    const now = shuffled[0];
    schedule.get(now.id).push([round5(clockStartS - between(10, 50) * MIN), round5(clockStartS + between(25, 80) * MIN)]);
    const next = shuffled.find((a) => a !== now && !neighbours(now, [a]).length) ?? shuffled[1];
    if (next) {
      const st = round5(clockStartS + between(8, 25) * MIN);
      schedule.get(next.id).push([st, st + missionLength()]);
    }
  }
  planMissions(schedule, relevant, MISSIONS_PER_HOUR_RELEVANT, from, to, relevantSet);
  planMissions(schedule, others, MISSIONS_PER_HOUR_OTHER, from, to, relevantSet);
  for (const w of schedule.values()) w.sort((p, q) => p[0] - q[0]);
  return schedule;
}

export function isActiveAt(schedule, area, clockS) {
  const windows = schedule.get(area.id);
  return !!windows && windows.some(([s, e]) => clockS >= s && clockS < e);
}

// Fascia in corso o prossima dopo clockS: [inizio, fine] oppure null.
export function currentOrNextWindow(schedule, area, clockS) {
  const windows = schedule.get(area.id) ?? [];
  return windows.find(([, e]) => e > clockS) ?? null;
}

// Ora UTC hh:mm (secondi dalla mezzanotte, anche oltre le 24 o negativi).
export function fmtClock(s, withSeconds = false) {
  const day = ((Math.floor(s) % 86400) + 86400) % 86400;
  const h = String(Math.floor(day / 3600)).padStart(2, '0');
  const m = String(Math.floor((day % 3600) / 60)).padStart(2, '0');
  return withSeconds ? `${h}:${m}:${String(day % 60).padStart(2, '0')}` : `${h}:${m}`;
}
