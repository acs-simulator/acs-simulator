// Fronti temporaleschi: linee di celle convettive che nascono, si spostano con il vento in quota, crescono
// e si esauriscono. Le celle hanno una sommità (i voli più alti passano sopra) e un'intensità, che decide
// quanto i piloti vogliono stargli lontani. Qui c'è solo la geometria: la previsione lungo la rotta e le
// richieste dei piloti stanno in sim.js.
// Turbolenza in aria chiara (CAT): zone che il radar non vede, in una fascia di livelli attorno alla corrente
// a getto. Si scoprono dai riporti dei piloti: da quel momento compaiono sul radar come riporto (PIREP) e tutti
// i voli che ci entrano chiedono di uscire dalla stessa fascia, sopra o sotto.
// Il vento è in convenzione meteorologica: wind.dir è la direzione da cui soffia (in quota sull'Italia di
// solito da ovest, sud-ovest o nord-ovest), e le celle si spostano verso dir + 180.

import { normalizeDeg, bearing, distance, angleDiff } from './geo.js';

// margine che i piloti vogliono dalla cella, per intensità (NM)
export const AVOID_MARGIN_NM = { 1: 6, 2: 10, 3: 14 };
// scala di intensità: azzurro, ambra, violetto (il rosso resta alle zone militari, il verde alle tracce)
export const WEATHER_COLORS = { 1: '#3fa7c4', 2: '#d8a03a', 3: '#a45ad8' };

const CELL_SPACING_NM = [18, 34];    // distanza fra due celle del fronte
const CELL_RADIUS_NM = [7, 20];      // raggio della cella al suo massimo
const CELL_LIFE_S = [2400, 5400];    // durata di una cella, dalla nascita alla dissipazione
const FRONT_TOP_FL = [270, 430];     // sommità del fronte
const WIND_KT = [18, 45];            // spostamento del fronte
const WIND_FROM_DEG = [200, 330];    // vento in quota da SW-NW

// Meteo scelto nel menu: quali fenomeni e con che intensità (0 = assente, 1 = giornata pessima).
export const WEATHER_DEFAULT = { storms: true, turbulence: true, intensity: 0.5 };

// Parametri della sessione dall'intensità: più fronti, più celle e più forti, più vicini al settore alla
// nascita; più zone di turbolenza, più larghe e più frequenti.
function weatherParams({ storms = true, turbulence = true, intensity = 0.5 } = {}) {
  const i = Math.max(0, Math.min(1, intensity));
  return {
    storms: storms && i > 0,
    turbulence: turbulence && i > 0,
    i,
    frontCells: [2 + Math.round(i), 4 + Math.round(2 * i)],   // celle per fronte
    maxCells: 4 + Math.round(6 * i),                          // celle in tutta l'area
    frontEveryS: 6600 - 3600 * i,                             // un nuovo fronte ogni 110-50 minuti
    startFrontChance: 0.25 + 0.65 * i,                        // sessioni con un fronte già in arrivo
    firstFrontS: [900 - 500 * i, 1800 - 900 * i],             // senza: il primo nasce dopo tanto
    edge: 0.42 - 0.12 * i,                                    // distanza dal settore alla nascita (frazione dell'area)
    maxTurb: 1 + Math.round(2 * i),
    turbEveryS: 7800 - 4200 * i,
    startTurbChance: 0.3 + 0.6 * i,
    turbRadius: 0.8 + 0.5 * i,
  };
}

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));

let nextId = 1;

// Posizione di una cella fra t secondi (si muove con il vento).
export function cellAt(cell, t = 0) {
  return { x: cell.x + (cell.vx * t) / 3600, y: cell.y + (cell.vy * t) / 3600 };
}

// Raggio della cella fra t secondi: cresce fino al massimo, poi si esaurisce.
export function cellRadius(cell, t = 0) {
  const age = cell.age + t;
  if (age < 0 || age > cell.life) return 0;
  const grow = Math.min(1, age / (cell.life * 0.3));
  const decay = Math.min(1, Math.max(0, (cell.life - age) / (cell.life * 0.35)));
  return cell.peakR * Math.min(grow, decay);
}

// Il punto (alla quota data) è dentro la cella fra t secondi, tenendo conto del margine.
export function cellHit(cell, p, altFt, t = 0, margin = 0) {
  if (altFt > cell.topFL * 100) return false;
  const r = cellRadius(cell, t);
  if (r <= 0) return false;
  const c = cellAt(cell, t);
  return Math.hypot(p.x - c.x, p.y - c.y) < r + margin;
}

// Quanto la cella è alta rispetto al volo: i voli sopra la sommità passano tranquilli.
export function cellAffects(cell, altFt) {
  return altFt <= cell.topFL * 100;
}

// Prua che lascia la cella a destra (side = 1) o a sinistra (side = -1) con il margine richiesto,
// vista dalla posizione attuale del volo e con la cella dove sarà fra t secondi.
export function avoidHeading(ac, cell, t, margin) {
  const c = cellAt(cell, t);
  const d = Math.max(1, Math.hypot(c.x - ac.x, c.y - ac.y));
  const r = cellRadius(cell, t) + margin;
  const half = Math.asin(Math.min(0.95, r / d)) * (180 / Math.PI);
  const toCell = bearing(ac, c);
  return (side) => normalizeDeg(toCell + side * (half + 4));
}

// Lato (-1 sinistra, 1 destra) da cui arriva il vento per un volo con questa prua: il lato sopravento, quello
// buono per aggirare una cella (grandine, incudine e turbolenza stanno sottovento).
export function upwindSide(heading, wind) {
  return angleDiff(wind.dir, heading) < 0 ? -1 : 1;
}

// Il volo ha il vento in faccia (entro 60°): a quote più basse il vento di solito cala.
export function headwind(heading, wind) {
  return Math.abs(angleDiff(wind.dir, heading)) < 60;
}

function makeCell(x, y, wind, topFL, intensity, age) {
  const rad = (((wind.dir + 180) % 360) * Math.PI) / 180;   // le celle vanno dove va il vento
  return {
    id: nextId++,
    x,
    y,
    vx: Math.sin(rad) * wind.kt,
    vy: -Math.cos(rad) * wind.kt,
    peakR: rand(...CELL_RADIUS_NM) * (0.7 + intensity * 0.2),
    topFL,
    intensity,
    age,
    life: rand(...CELL_LIFE_S),
    // forma irregolare: raggio modulato lungo l'azimut, per un contorno da eco radar
    lobes: Array.from({ length: 7 }, () => rand(0.72, 1.22)),
    spin: rand(0, 360),
  };
}

// Un fronte: celle allineate su una direttrice, perpendicolare al vento, che entrano nell'area da un lato.
function makeFront(w) {
  const { view, wind, focus, p } = w;
  const axis = normalizeDeg(wind.dir + 90 + rand(-25, 25));
  // sommità più alte nelle giornate peggiori: i settori alti non ne restano fuori
  const topFL = Math.min(450, Math.round((rand(...FRONT_TOP_FL) + 40 * p.i) / 10) * 10);
  const n = randInt(...p.frontCells);
  const width = view.xMax - view.xMin;
  const height = view.yMax - view.yMin;
  // il centro del fronte sta sopravento al settore: le celle nascono piccole e lontane e il vento le porta
  // sopra il settore; con una giornata peggiore nascono più vicine
  const rad = (wind.dir * Math.PI) / 180;                   // verso il lato da cui soffia il vento
  const centre = {
    x: focus.x + Math.sin(rad) * width * p.edge + rand(-0.12, 0.12) * width,
    y: focus.y - Math.cos(rad) * height * p.edge + rand(-0.12, 0.12) * height,
  };
  const cells = [];
  const step = rand(...CELL_SPACING_NM);
  const axisRad = (axis * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const s = (i - (n - 1) / 2) * step;
    // celle più forti nelle giornate peggiori
    const intensity = 1 + (Math.random() < 0.35 + 0.4 * p.i ? 1 : 0) + (Math.random() < 0.1 + 0.35 * p.i ? 1 : 0);
    cells.push(makeCell(
      centre.x + Math.sin(axisRad) * s + rand(-6, 6),
      centre.y - Math.cos(axisRad) * s + rand(-6, 6),
      wind,
      topFL + randInt(-3, 3) * 10,
      intensity,
      0,
    ));
  }
  return cells;
}

// --- turbolenza in aria chiara ---

const TURB_RADIUS_NM = [35, 70];
const TURB_FL = [100, 410];          // la turbolenza in aria chiara sta di solito sotto la tropopausa
const TURB_THICK_FL = [20, 40];      // spessore della fascia
const TURB_LIFE_S = [3600, 7800];

// Zona di turbolenza attorno al settore, in una fascia di livelli dentro quella del settore: è lì che serve.
function makeTurb(w) {
  const { view, wind, focus, band, p } = w;
  const width = view.xMax - view.xMin;
  const height = view.yMax - view.yMin;
  const rad = (((wind.dir + 180) % 360) * Math.PI) / 180;
  const drift = wind.kt * 0.4;       // la zona si sposta, più lenta dell'aria
  const thick = Math.round(rand(...TURB_THICK_FL) / 10) * 10;
  const lowest = Math.max(TURB_FL[0], band[0]);
  const highest = Math.max(lowest, Math.min(TURB_FL[1], band[1]) - thick);
  const lo = Math.round(rand(lowest, highest) / 10) * 10;
  return {
    id: nextId++,
    x: focus.x + rand(-0.22, 0.22) * width,
    y: focus.y + rand(-0.22, 0.22) * height,
    vx: Math.sin(rad) * drift,
    vy: -Math.cos(rad) * drift,
    r: rand(...TURB_RADIUS_NM) * p.turbRadius,
    lo,
    hi: lo + thick,
    age: 0,
    life: rand(...TURB_LIFE_S),
    reported: false,                 // nessun pilota l'ha ancora riportata: sul radar non c'è
  };
}

// Zona di turbolenza in cui si trova il punto, alla quota data (fascia estremi compresi).
export function turbAt(w, p, altFt) {
  const fl = altFt / 100;
  return w.turb.find((z) => fl >= z.lo - 5 && fl <= z.hi + 5 && Math.hypot(p.x - z.x, p.y - z.y) < z.r) ?? null;
}

// Il livello è dentro una fascia turbolenta già riportata che il volo attraverserà in quel punto.
export function reportedTurbAt(w, p, fl) {
  return w.turb.find((z) => z.reported && fl >= z.lo && fl <= z.hi && Math.hypot(p.x - z.x, p.y - z.y) < z.r + 20) ?? null;
}

// Una cella messa dove serve (modalità guidata): nasce già cresciuta, con la sommità e l'intensità chieste.
export function addCell(w, x, y, { topFL = 380, intensity = 2, grown = 1 } = {}) {
  const cell = makeCell(x, y, w.wind, topFL, intensity, 0);
  cell.age = cell.life * 0.3 * Math.max(0, Math.min(1, grown));
  w.cells.push(cell);
  return cell;
}

// Situazione meteo della sessione: vento in quota, fenomeni scelti nel menu e, a volte, un fronte già in
// avvicinamento. focus: centro del settore; band: [floorFL, ceilingFL] del settore.
export function makeWeather(view, options = {}) {
  const wind = { dir: Math.round(rand(...WIND_FROM_DEG)), kt: Math.round(rand(...WIND_KT)) };
  const focus = options.focus ?? { x: (view.xMin + view.xMax) / 2, y: (view.yMin + view.yMax) / 2 };
  const band = options.band ?? [250, 450];
  const p = weatherParams(options);
  const w = { wind, view, focus, band, p, cells: [], turb: [] };
  if (p.storms && Math.random() < p.startFrontChance) w.cells = makeFront(w).slice(0, p.maxCells);
  if (p.turbulence && Math.random() < p.startTurbChance) w.turb = [makeTurb(w)];
  // senza temporali all'inizio il primo fronte nasce dopo un po' (e arriva sul settore un quarto d'ora dopo);
  // con un fronte già in arrivo, il successivo molto più tardi
  w.nextFrontAt = !p.storms ? Infinity : w.cells.length ? rand(0.8, 1.3) * p.frontEveryS : rand(...p.firstFrontS);
  w.nextTurbAt = p.turbulence ? rand(0.5, 1.2) * p.turbEveryS : Infinity;
  return w;
}

// Avanzamento: le celle si spostano e invecchiano, quelle esaurite o uscite dall'area spariscono,
// ogni tanto arriva un nuovo fronte.
export function stepWeather(w, dt, simTime) {
  for (const cell of w.cells) {
    cell.x += (cell.vx * dt) / 3600;
    cell.y += (cell.vy * dt) / 3600;
    cell.age += dt;
  }
  const margin = 80;
  w.cells = w.cells.filter((c) => c.age < c.life
    && c.x > w.view.xMin - margin && c.x < w.view.xMax + margin
    && c.y > w.view.yMin - margin && c.y < w.view.yMax + margin);

  if (simTime >= w.nextFrontAt) {
    w.nextFrontAt = simTime + rand(0.6, 1.4) * w.p.frontEveryS;
    if (w.cells.length <= w.p.maxCells / 3) w.cells.push(...makeFront(w).slice(0, w.p.maxCells - w.cells.length));
  }

  for (const z of w.turb) {
    z.x += (z.vx * dt) / 3600;
    z.y += (z.vy * dt) / 3600;
    z.age += dt;
  }
  w.turb = w.turb.filter((z) => z.age < z.life);
  if (simTime >= w.nextTurbAt) {
    w.nextTurbAt = simTime + rand(0.6, 1.4) * w.p.turbEveryS;
    if (w.turb.length < w.p.maxTurb) w.turb.push(makeTurb(w));
  }
}

// Celle attive (con un raggio) che interessano la quota data.
export function activeCells(w, altFt = 0) {
  return w.cells.filter((c) => cellRadius(c) > 0.5 && (altFt === 0 || cellAffects(c, altFt)));
}

// Contorno della cella per il disegno: raggio modulato lungo l'azimut.
export function cellOutline(cell, scale = 1) {
  const r = cellRadius(cell) * scale;
  const c = cellAt(cell);
  const n = 28;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const lobe = cell.lobes[Math.floor((((a * 180) / Math.PI + cell.spin) / 360) * cell.lobes.length) % cell.lobes.length];
    pts.push({ x: c.x + Math.sin(a) * r * lobe, y: c.y - Math.cos(a) * r * lobe });
  }
  return pts;
}

export { distance };
