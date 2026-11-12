// Spazio aereo attivo: proietta sul piano locale (nm) i dati della carta FRA e la settorizzazione,
// calcola i punti di coordinamento (COP) del settore scelto e i flussi di traffico.
import { FRA_POINTS, COASTLINE, ACC_BOUNDARIES, FRA_BOUNDARY } from './data/chart.js';
import { SECTORS, LAYERS, ACC_BOUNDARY, CENTRE } from './sectors.js';
import { AIRPORTS } from './world.js';
import {
  makeProjection, pointInPolygon, polygonArea, boundingBox, distanceToPolygon, distance,
} from './geo.js';
import { buildFlows, volumeEligibility } from './flows.js';
import { projectAreas } from './areas.js';
import {
  PROCEDURES, PROC_FIXES, chooseRunways, activeRunways, activeSids, activeStars, compact,
} from './procedures.js';

const VIEW_MARGIN_NM = 45;
const COP_BAND_NM = 6;      // un punto FRA è candidato COP se dista meno di così dal confine
const COP_SPACING_NM = 20;
const DEPARTURE_LEG_NM = 3;  // salita iniziale sull'asse pista, oltre la fine pista, prima di virare verso la SID
const FINAL_LEG_NM = 9;      // finale: l'arrivo si allinea all'asse pista a questa distanza dalla soglia

export const airspace = {
  sector: null,
  layer: null,
  floorFt: 0,
  ceilingFt: 0,
  projection: null,
  polygon: [],
  view: null,
  waypoints: [],     // punti FRA proiettati
  airports: [],      // aeroporti di scenario proiettati
  procFixes: new Map(), // fix di SID e STAR proiettati (id -> punto)
  procMap: [],       // SID e STAR delle piste in uso degli aeroporti visibili, per la mappa
  coast: [],
  accLines: [],
  fraBoundary: [],
  accBoundary: [],   // perimetro dell'ACC attivo
  sectorsXY: [],     // tutti i settori (tre strati), per disegno e nomi degli enti adiacenti
  cops: [],          // punti di coordinamento del settore
  copIds: new Set(),
  flows: [],
  areas: [],         // zone P, R, D, TSA e TRA vicine al settore (areas.js)
  fix: (id) => byId.get(id), // punto per nome: FRA, fix di procedura o aeroporto
};

let byId = new Map();

// quota più alta a cui un avvicinamento può ancora avere il traffico: la base più alta fra i settori bassi
const appTopFt = () => Math.max(...SECTORS.map((s) => s.floorFL)) * 100;

function centroidLatLon(polygon) {
  return {
    lat: polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
    lon: polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
  };
}

function selectCops(polygon) {
  const candidates = airspace.waypoints
    .map((w) => ({ w, d: distanceToPolygon(w, polygon) }))
    .filter((c) => c.d <= COP_BAND_NM)
    .sort((a, b) => (a.w.types.match(/[EX]/) ? 0 : 5) + a.d - ((b.w.types.match(/[EX]/) ? 0 : 5) + b.d));
  const chosen = [];
  for (const c of candidates) {
    if (chosen.every((o) => distance(o, c.w) >= COP_SPACING_NM)) chosen.push(c.w);
  }
  return chosen;
}

export function loadSector(sectorId) {
  const sector = SECTORS.find((s) => s.id === sectorId);
  const c = centroidLatLon(sector.polygon);
  const proj = makeProjection(c.lat, c.lon);
  const toXY = ([lat, lon]) => proj.toXY(lat, lon);

  airspace.sector = sector;
  airspace.layer = LAYERS[sector.layer];
  airspace.floorFt = sector.floorFL * 100;
  airspace.ceilingFt = sector.ceilingFL * 100;
  airspace.projection = proj;

  airspace.sectorsXY = SECTORS.map((s) => ({ ...s, polygonXY: s.polygon.map(toXY) }));
  airspace.polygon = airspace.sectorsXY.find((s) => s.id === sectorId).polygonXY;
  const bb = boundingBox(airspace.polygon);
  airspace.view = {
    xMin: bb.xMin - VIEW_MARGIN_NM,
    xMax: bb.xMax + VIEW_MARGIN_NM,
    yMin: bb.yMin - VIEW_MARGIN_NM,
    yMax: bb.yMax + VIEW_MARGIN_NM,
  };

  airspace.waypoints = FRA_POINTS.map(([id, lat, lon, types]) => ({ id, lat, lon, types, ...proj.toXY(lat, lon) }));
  airspace.airports = AIRPORTS.map((a) => ({ ...a, id: a.icao, types: '', ...proj.toXY(a.lat, a.lon) }));
  airspace.procFixes = new Map(Object.entries(PROC_FIXES)
    .map(([id, [lat, lon]]) => [id, { id, lat, lon, types: '', proc: true, ...proj.toXY(lat, lon) }]));
  // i punti FRA omonimi di un fix di procedura sono lo stesso punto: vale quello della carta FRA
  byId = new Map([...airspace.procFixes.values(), ...airspace.waypoints, ...airspace.airports].map((w) => [w.id, w]));
  // piste in uso nella sessione (vento): decidono SID e STAR dei voli
  chooseRunways();
  runwayFixes(proj);
  airspace.procMap = procedureMap(proj);

  airspace.coast = COASTLINE.map((line) => line.map(toXY));
  airspace.accLines = ACC_BOUNDARIES.map((line) => line.map(toXY));
  airspace.fraBoundary = FRA_BOUNDARY.map((line) => line.map(toXY));
  airspace.accBoundary = ACC_BOUNDARY.map(toXY);
  airspace.areas = projectAreas(proj, airspace.view);

  // punti di coordinamento: quelli pubblicati del settore, altrimenti i punti FRA sul confine
  airspace.cops = sector.cops
    ? sector.cops.map((id) => byId.get(id)).filter(Boolean)
    : selectCops(airspace.polygon);
  airspace.copIds = new Set(airspace.cops.map((w) => w.id));
  airspace.flows = buildFlows(airspace);
  // un flusso è nostro se almeno una parte dei suoi voli attraversa il settore in modo gestibile; la quota
  // effettiva la decide già la generazione, che scarta i voli (tipo e livello) che non passano: moltiplicare
  // qui il peso per quella quota la conterebbe due volte e favorirebbe i flussi sempre idonei
  for (const flow of airspace.flows) {
    flow.oursWeight = flow.crossesSector && volumeEligibility(airspace, flow) > 0 ? flow.weight : 0;
  }
  return airspace;
}

// Punti sull'asse delle piste in uso: la partenza sale diritta fino a DEPARTURE_LEG_NM oltre la fine pista e solo
// allora vira verso il primo punto della SID; l'arrivo lascia l'ultimo punto della STAR per allinearsi al
// finale a FINAL_LEG_NM dalla soglia. Senza, i voli andrebbero in linea retta fra l'aeroporto e la procedura,
// qualunque sia la pista. Ogni aeroporto riceve depFix e finalFix (punti con nome ICAO/pista).
function runwayFixes(proj) {
  for (const a of airspace.airports) {
    const p = PROCEDURES[a.icao];
    const rw = activeRunways[a.icao];
    a.depFix = null;
    a.finalFix = null;
    if (!p || !rw) continue;
    const axis = (name, fromThr, nm) => {
      const r = p.runways[name];
      if (!r) return null;
      const thr = proj.toXY(...r.thr);
      const end = proj.toXY(...r.end);
      const len = Math.hypot(end.x - thr.x, end.y - thr.y);
      if (len < 0.2) return null;
      const ux = (end.x - thr.x) / len;
      const uy = (end.y - thr.y) / len;
      const base = fromThr ? thr : end;
      const point = { id: `${a.icao}/${name}`, types: '', proc: true, runway: true, x: base.x + ux * nm, y: base.y + uy * nm };
      byId.set(point.id, point);
      return point;
    };
    a.depFix = axis(rw.dep[0], false, DEPARTURE_LEG_NM);
    a.finalFix = axis(rw.arr[0], true, -FINAL_LEG_NM);
  }
}

// SID e STAR delle piste in uso degli aeroporti visibili: spezzate già proiettate, con i nomi dei fix.
// La SID parte dalla fine della pista di decollo; la STAR arriva alla soglia della pista d'atterraggio.
function procedureMap(proj) {
  const out = [];
  for (const a of airspace.airports) {
    const p = PROCEDURES[a.icao];
    if (!p || !inView(a, 60)) continue;
    const rw = activeRunways[a.icao];
    const at = ([lat, lon]) => proj.toXY(lat, lon);
    const fix = (id) => byId.get(id);
    const depEnd = p.runways[rw.dep[0]] ? at(p.runways[rw.dep[0]].end) : a;
    const arrThr = p.runways[rw.arr[0]] ? at(p.runways[rw.arr[0]].thr) : a;
    for (const sid of activeSids(a.icao)) {
      out.push({ kind: 'sid', icao: a.icao, name: compact(sid.transition ?? sid.id), points: [depEnd, ...sid.fixes.map(fix)] });
    }
    for (const star of activeStars(a.icao)) {
      out.push({ kind: 'star', icao: a.icao, name: compact(star.id), points: [...star.fixes.map(fix), arrThr] });
    }
  }
  return out;
}

export function waypoint(id) {
  return byId.get(id);
}

export function isFraPoint(id) {
  const w = byId.get(id);
  return !!w && !w.icao && !w.runway; // non gli aeroporti né i punti sull'asse pista
}

export function insideLateral(p) {
  return pointInPolygon(p.x, p.y, airspace.polygon);
}

export function insideVolume(ac) {
  return insideLateral(ac) && ac.altitude >= airspace.floorFt && ac.altitude < airspace.ceilingFt;
}

export function inView(p, margin = 0) {
  const v = airspace.view;
  return p.x >= v.xMin - margin && p.x <= v.xMax + margin && p.y >= v.yMin - margin && p.y <= v.yMax + margin;
}

export function distanceFromSector(p) {
  return insideLateral(p) ? 0 : distanceToPolygon(p, airspace.polygon);
}

// Settore dell'ACC attivo responsabile di un punto alla quota data (null sotto il limite inferiore o fuori ACC).
export function sectorAt(p, altFt) {
  return airspace.sectorsXY.find((x) => altFt >= x.floorFL * 100 && altFt < x.ceilingFL * 100
    && pointInPolygon(p.x, p.y, x.polygonXY)) ?? null;
}

// Ente competente in un punto e a una quota: un settore dell'ACC attivo, l'avvicinamento sotto il
// limite inferiore dei settori bassi, oppure l'ACC confinante.
export function unitAt(p, altFt) {
  const s = sectorAt(p, altFt);
  if (s) return s.name;
  // sotto il limite inferiore dei settori più bassi c'è l'avvicinamento; più in alto, se nessun settore
  // copre il punto, siamo già fuori dall'ACC (per esempio sopra FL195 nella sporgenza di Verona)
  if (altFt < appTopFt() && pointInPolygon(p.x, p.y, airspace.accBoundary)) {
    const app = airspace.airports.filter((a) => a.app).sort((a, b) => distance(a, p) - distance(b, p))[0];
    return app ? app.app : CENTRE.fallbackUnit;
  }
  const { lat, lon } = airspace.projection.toLatLon(p.x, p.y);
  return CENTRE.adjacentUnit(lat, lon);
}

export function sectorSummary(sector) {
  const c = centroidLatLon(sector.polygon);
  const proj = makeProjection(c.lat, c.lon);
  const poly = sector.polygon.map(([lat, lon]) => proj.toXY(lat, lon));
  const bb = boundingBox(poly);
  const airports = AIRPORTS.filter((a) => a.app && pointInPolygon(...Object.values(proj.toXY(a.lat, a.lon)), poly));
  return {
    areaNm2: polygonArea(poly),
    widthNm: bb.xMax - bb.xMin,
    heightNm: bb.yMax - bb.yMin,
    airports: airports.map((a) => a.icao),
  };
}

export { distance };
