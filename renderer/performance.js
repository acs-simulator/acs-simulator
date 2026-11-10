// Prestazioni degli aeromobili: atmosfera standard (ISA), conversione da velocità indicata e Mach
// a velocità vera, ratei verticali che cambiano con la quota e distanze di salita e discesa.
// Servono sia al moto degli aerei sia ai profili verticali pianificati.

const A0_KT = 661.4786; // velocità del suono al livello del mare
const FT_TO_M = 0.3048;
const MAX_BANK_DEG = 25;
const MAX_TURN_RATE_DEG_S = 3;

export function isa(altFt) {
  const h = Math.max(0, altFt) * FT_TO_M;
  if (h <= 11000) {
    const theta = (288.15 - 0.0065 * h) / 288.15;
    return { theta, delta: theta ** 5.25588 };
  }
  return { theta: 216.65 / 288.15, delta: 0.223361 * Math.exp(-(h - 11000) / 6341.62) };
}

// Da FL250 in su la velocità si legge e si assegna in Mach, più in basso in nodi.
export const MACH_FROM_FT = 25000;

export function soundSpeedKt(altFt) {
  return A0_KT * Math.sqrt(isa(altFt).theta);
}

// Velocità vera corrispondente a una velocità calibrata (flusso comprimibile).
export function casToTas(cas, altFt) {
  const { theta, delta } = isa(altFt);
  const qc = (1 + 0.2 * (cas / A0_KT) ** 2) ** 3.5 - 1;
  const mach = Math.sqrt(5 * ((qc / delta + 1) ** (1 / 3.5) - 1));
  return mach * A0_KT * Math.sqrt(theta);
}

// Velocità propria (vera) secondo il programma del tipo: velocità indicata di salita, crociera o discesa,
// 250 kt sotto FL100, velocità ridotte vicino all'aeroporto, limite del Mach di crociera in quota.
export function scheduleSpeed(type, altFt, phase = 'cruise') {
  let cas = phase === 'climb' ? type.climbCas : phase === 'descent' ? type.descentCas : type.cruiseCas;
  if (altFt < 10000) cas = Math.min(cas, 250);
  if (altFt < 5000) cas = Math.min(cas, phase === 'descent' ? 210 : 220);
  return Math.min(casToTas(cas, altFt), type.mach * soundSpeedKt(altFt));
}

// Velocità che il controllore può assegnare alla quota attuale.
export function speedEnvelope(type, altFt) {
  const jet = type.engine === 'jet';
  const own = scheduleSpeed(type, altFt, 'cruise');
  const min = Math.max(casToTas(jet ? 210 : 160, altFt), own * 0.82);
  const max = Math.min(casToTas(jet ? 340 : 250, altFt), (type.mach + 0.04) * soundSpeedKt(altFt), own * 1.15);
  return { min: Math.round(min), max: Math.round(Math.max(min, max)) };
}

// Rateo di salita (ft/min): pieno a bassa quota, sempre più ridotto avvicinandosi alla tangenza.
export function climbRate(type, altFt) {
  const r = Math.min(1, Math.max(0, altFt / (type.maxFL * 100 + 1500)));
  return type.climbFpm * Math.max(0.18, 1 - 0.82 * r ** 1.4);
}

// Rateo di discesa (ft/min): più alto in quota, dove la velocità vera è maggiore.
export function descentRate(type, altFt) {
  return type.descentFpm * (0.75 + 0.35 * Math.min(1, Math.max(0, altFt) / 36000));
}

// Rateo di virata con inclinazione massima di 25°, mai oltre la virata standard (3°/s).
export function turnRate(speedKt) {
  return Math.min(MAX_TURN_RATE_DEG_S, (1091 * Math.tan((MAX_BANK_DEG * Math.PI) / 180)) / Math.max(speedKt, 120));
}

// --- distanze di salita e discesa ------------------------------------------

const STEP_FT = 250;
const PLAN_RATE = 0.85;    // i profili pianificati usano ratei ridotti: l'aereo li segue senza restare indietro
const GLIDE_FT_NM = 318;   // avvicinamento finale a 3°
const DECEL_NM = 4;        // tratto per rallentare a 250 kt passando FL100 in discesa

function buildTable(type) {
  const n = Math.ceil((type.maxFL * 100) / STEP_FT);
  const climb = new Float64Array(n + 1);   // NM dal decollo per raggiungere k*STEP_FT
  const descent = new Float64Array(n + 1); // NM dall'atterraggio a cui si incontra k*STEP_FT
  for (let k = 1; k <= n; k++) {
    const mid = (k - 0.5) * STEP_FT;
    const up = climbRate(type, mid) * PLAN_RATE;
    climb[k] = climb[k - 1] + ((STEP_FT / up) * scheduleSpeed(type, mid, 'climb')) / 60;
    let ds;
    if (mid < 3000) {
      ds = STEP_FT / GLIDE_FT_NM;
    } else {
      const down = descentRate(type, mid) * PLAN_RATE;
      ds = ((STEP_FT / down) * scheduleSpeed(type, mid, 'descent')) / 60;
    }
    if (type.engine === 'jet' && (k - 1) * STEP_FT < 10000 && k * STEP_FT >= 10000) ds += DECEL_NM;
    descent[k] = descent[k - 1] + ds;
  }
  return { climb, descent };
}

function distanceFor(table, altFt) {
  const k = Math.max(0, Math.min(table.length - 1, altFt / STEP_FT));
  const i = Math.floor(k);
  if (i >= table.length - 1) return table[table.length - 1];
  return table[i] + (table[i + 1] - table[i]) * (k - i);
}

function altitudeFor(table, nm) {
  if (nm <= 0) return 0;
  let hi = table.length - 1;
  if (nm >= table[hi]) return hi * STEP_FT;
  let lo = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= nm) lo = mid;
    else hi = mid;
  }
  return (lo + (nm - table[lo]) / (table[hi] - table[lo])) * STEP_FT;
}

const cache = new Map();

export function performanceOf(type) {
  let perf = cache.get(type.icao);
  if (!perf) {
    const { climb, descent } = buildTable(type);
    perf = {
      climbDistance: (altFt) => distanceFor(climb, altFt),     // NM dal decollo
      descentDistance: (altFt) => distanceFor(descent, altFt), // NM prima dell'atterraggio
      climbAltitude: (nm) => altitudeFor(climb, nm),
      descentAltitude: (nm) => altitudeFor(descent, nm),
    };
    cache.set(type.icao, perf);
  }
  return perf;
}
