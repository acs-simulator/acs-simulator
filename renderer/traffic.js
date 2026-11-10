// Generazione del traffico a partire dai flussi fra aeroporti: ogni volo ha tipo, livello di crociera
// richiesto e profilo verticale legato all'aeroporto di partenza e a quello di destinazione.
// Il piano stabilisce se il volo è di nostra competenza, da quale ente arriva e a quale livello,
// da quale punto deve uscire, a quale livello e verso quale ente.
import { airspace, waypoint, insideLateral, inView, unitAt, sectorAt } from './airspace.js';
import { levelsForTrack, topTransferFL, bottomTransferFL } from './sectors.js';
import {
  pickType, requestedLevels, makeProfile, profileAltitude, profileSpeed, profileTime, distanceBefore,
  sectorPassage, passageReenters, pointAlong, resolveExit, entryStart, MIN_INSIDE_NM, LEVEL_BEFORE_NM,
} from './flows.js';
import { bearing, distance, segmentIntersection } from './geo.js';

export const OFFER_LEAD_S = 90;   // il settore precedente ci passa il traffico ~1,5 min prima dell'ingresso
const EDGE_MAX_S = 1500;            // i voli da lontano compaiono al bordo del radar, al più 25 minuti prima dell'ingresso
const MIN_LEAD_S = 120;            // nessun volo compare a ridosso del confine del settore
const DEPARTURE_NM = [4, 7];       // le partenze compaiono sul radar pochi NM dopo il decollo
const EXIT_COP_SNAP_NM = 25;
const MIN_VERTICAL_FL = 20;        // uscita dall'alto o dal basso: almeno 2000 ft fra livello d'ingresso e XFL
const NEAR_PATH_NM = 3;            // flussi che passano così vicino alla traiettoria del bersaglio (stessa rotta)
const FLOW_SPREAD = 0.75;          // appiattisce i pesi dei flussi: rotte più varie, non solo le più trafficate

const rand = (min, max) => min + Math.random() * (max - min);

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function routeLengthNm(start, route) {
  let prev = start;
  let total = 0;
  for (const id of route) {
    const wp = waypoint(id);
    if (!wp) continue;
    total += distance(prev, wp);
    prev = wp;
  }
  return total;
}

function weightedFlow(flows, key = 'weight') {
  const w = (f) => f[key] ** FLOW_SPREAD;
  let r = Math.random() * flows.reduce((s, f) => s + w(f), 0);
  return flows.find((f) => (r -= w(f)) <= 0) ?? flows[flows.length - 1];
}

// Differenze fra un aereo e l'altro dello stesso tipo (peso, vento, programma della compagnia): velocità e
// ratei verticali un po' diversi. Restano sopra i ratei dei profili pianificati, che l'aereo segue sempre.
function aircraftVariation() {
  return { speed: rand(0.96, 1.04), climb: rand(0.92, 1.15), descent: rand(0.92, 1.12) };
}

// Partenza da un aeroporto visibile sul radar (anche fuori dal nostro ACC): il volo compare subito dopo il decollo.
function isLocalDeparture(flow) {
  return inView(flow.origin, 5);
}

function bandLevels(track, type) {
  const { floorFL, ceilingFL } = airspace.sector;
  return levelsForTrack(track, floorFL + 5, Math.min(ceilingFL - 5, type.maxFL));
}

function nearestLevel(levels, ft) {
  return levels.reduce((best, fl) => (Math.abs(fl * 100 - ft) < Math.abs(best * 100 - ft) ? fl : best), levels[0]);
}

function nearestPoint(candidates, p, maxNm) {
  let best = null;
  let bestD = maxNm;
  for (const c of candidates) {
    const d = distance(c.p, p);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

// Livello di crociera richiesto: i livelli più alti fra quelli plausibili sono i più scelti.
function chooseCruise(flow, type) {
  const levels = requestedLevels(flow, type);
  if (!levels.length) return null;
  let r = Math.random() * ((levels.length * (levels.length + 1)) / 2);
  for (let i = 0; i < levels.length; i++) {
    r -= i + 1;
    if (r <= 0) return levels[i];
  }
  return levels[levels.length - 1];
}

// Coordinamento con gli enti adiacenti (in tre dimensioni): ente e livello d'ingresso, uscita e livello
// d'uscita, ente successivo. passage: passaggio con l'uscita già stabilita da resolveExit.
// Uscita laterale: su un punto di coordinamento (COP), al livello di crociera. Uscita dall'alto o dal basso:
// nessun punto di rotta, il volo passa al settore superiore o inferiore mentre si avvicina al nostro limite.
// Uscita 'star': sul punto iniziale della STAR, all'avvicinamento, al livello di trasferimento.
function coordinate(flow, type, profile, passage, routeIdx) {
  const levels = bandLevels(flow.track, type);
  if (!levels.length) return null;
  const { floorFL, ceilingFL } = airspace.sector;
  const { entry, exit } = passage;

  let exitFix = null;
  let requestedFL;
  let nextUnit;
  let nextUnitCode = null;
  if (exit.kind === 'lateral') {
    const cops = [];
    for (let i = routeIdx; i < flow.points.length; i++) {
      if (airspace.copIds.has(flow.ids[i]) && Math.abs(flow.cum[i] - exit.s) < 45) cops.push({ id: flow.ids[i], p: flow.points[i] });
    }
    exitFix = nearestPoint(cops, exit.point, EXIT_COP_SNAP_NM)?.id;
    if (!exitFix) return null;
    // settore adiacente dello stesso strato o ACC confinante: il livello di crociera, oppure quello che il volo
    // ha qualche miglio prima del confine, così che passi all'ente successivo già livellato
    requestedFL = nearestLevel(levels, exit.levelFt ?? profileAltitude(profile, exit.s - LEVEL_BEFORE_NM));
    nextUnit = unitAt(pointAlong(flow, exit.s + 15), requestedFL * 100);
  } else if (exit.kind === 'star') {
    // arrivo: passato all'avvicinamento sul punto iniziale della STAR, al livello di trasferimento
    exitFix = exit.fix;
    requestedFL = Math.round(exit.alt / 100);
    nextUnit = flow.destination.app ?? unitAt(exit.point, airspace.floorFt - 500);
    nextUnitCode = 'APP';
  } else if (exit.kind === 'top') {
    // salita oltre il limite superiore: autorizzato al livello più vicino al nostro limite (FL190 dai settori
    // bassi, FL300 dai medi) e passato al settore superiore avvicinandosi a quel livello
    requestedFL = Math.min(topTransferFL(airspace.sector), type.maxFL);
    const above = sectorAt(exit.point, ceilingFL * 100 + 500);
    nextUnit = above ? above.name : unitAt(exit.point, ceilingFL * 100 + 500);
    nextUnitCode = above?.id ?? null;
  } else {
    // discesa verso il settore inferiore o, sotto i settori bassi, all'avvicinamento di destinazione:
    // autorizzato al livello più vicino al nostro limite inferiore (FL310 dagli alti, FL200 dai medi, FL110 con
    // limite FL105) e passato avvicinandosi a quel livello
    requestedFL = bottomTransferFL(airspace.sector);
    const below = sectorAt(exit.point, floorFL * 100 - 500);
    nextUnit = below ? below.name : flow.destination.app ?? unitAt(exit.point, floorFL * 100 - 500);
    nextUnitCode = below ? below.id : / APP$/.test(nextUnit) ? 'APP' : null;
  }
  // punto oltre il quale la rotta è di altri enti: il punto d'uscita, oppure il primo punto dopo il confine laterale
  let routeLimitFix = exitFix;
  for (let i = routeIdx; !routeLimitFix && i < flow.ids.length; i++) {
    if (flow.cum[i] >= passage.lateralS) routeLimitFix = flow.ids[i];
  }

  let entryFL;
  let clamp;
  let prevUnit;
  if (entry.kind === 'below') {
    // l'ente inferiore ferma la salita al livello più vicino al nostro limite: FL80 dall'avvicinamento sotto un
    // settore basso con base FL85, FL190 dai settori bassi, FL300 dai settori medi
    entryFL = Math.floor((floorFL - 5) / 10) * 10;
    clamp = 'climb';
    const under = sectorAt(entry.point, floorFL * 100 - 500);
    prevUnit = under ? under.name : flow.origin.app ?? unitAt(entry.point, floorFL * 100 - 500);
  } else if (entry.kind === 'above') {
    // il settore superiore consegna la discesa al livello più vicino al suo limite inferiore (il nostro superiore)
    entryFL = Math.ceil((ceilingFL + 5) / 10) * 10;
    clamp = 'descend';
    prevUnit = unitAt(entry.point, ceilingFL * 100 + 500);
  } else {
    entryFL = nearestLevel(levels, entry.alt);
    const later = profileAltitude(profile, entry.s + 10);
    clamp = later < entry.alt - 100 ? 'descend' : 'climb';
    prevUnit = unitAt(pointAlong(flow, Math.max(0, entry.s - 15)), entry.alt);
  }
  // volo che entra già a ridosso del limite che sta per attraversare: l'ente precedente lo passa direttamente
  // al settore superiore o inferiore, senza passare da noi
  if ((exit.kind === 'top' || exit.kind === 'bottom') && Math.abs(requestedFL - entryFL) < MIN_VERTICAL_FL) return null;

  return {
    exitFix,
    exitKind: exit.kind,
    requestedExitFL: requestedFL,
    nextUnit,
    nextUnitCode,
    routeLimitFix,
    prevUnit,
    entryFt: entryFL * 100,
    entryKind: entry.kind,
    entryFix: entry.fix ?? null,
    clamp,
    entryS: entry.s,
    exitS: exit.s,
  };
}

// Piano completo del volo lungo il flusso a partire dalla distanza sSpawn.
function planFlight(flow, type, cruiseFL, sSpawn, perf = aircraftVariation()) {
  const routeIdx = flow.cum.findIndex((c) => c > sSpawn + 0.5);
  if (routeIdx < 1) return null;
  const profile = makeProfile(flow, type, cruiseFL);
  const pos = pointAlong(flow, sSpawn);
  const alt = Math.round(profileAltitude(profile, sSpawn) / 100) * 100;
  const passage = sectorPassage(airspace, flow, profile, sSpawn);
  return {
    base: {
      flow,
      type,
      profile,
      perf,
      rfl: cruiseFL,
      speed: profileSpeed(profile, sSpawn) * perf.speed,
      x: pos.x,
      y: pos.y,
      heading: bearing(pos, flow.points[routeIdx]),
      route: flow.ids.slice(routeIdx),
      origin: flow.origin.icao,
      destination: flow.destination.icao,
      levelTrack: flow.track,
      altitude: alt,
      assignedAltitude: alt,
    },
    passage,
    routeIdx,
  };
}

// Livello a cui l'ente precedente mantiene il volo prima di passarcelo.
export function coordinatedAltitude(profileFt, clamp, entryFt) {
  return clamp === 'descend' ? Math.max(profileFt, entryFt) : Math.min(profileFt, entryFt);
}

function inboundPlan(planned, coord) {
  const { base } = planned;
  const ft = coordinatedAltitude(base.altitude, coord.clamp, coord.entryFt);
  return { ...base, ...coord, control: 'inbound', altitude: ft, assignedAltitude: ft };
}

const COORD_KEYS = [
  'exitFix', 'exitKind', 'requestedExitFL', 'nextUnit', 'nextUnitCode', 'routeLimitFix', 'prevUnit', 'entryFt', 'entryKind',
  'entryFix', 'clamp', 'entryS', 'exitS',
];

// Nuovo volo di nostra competenza. Le partenze da aeroporti visibili compaiono pochi NM dopo il decollo,
// ancora con l'avvicinamento; tutti gli altri voli entrano dal bordo del radar.
// evolvingBias: probabilità di scartare un volo che attraversa il settore senza cambiare livello,
// così che nei settori più impegnativi il traffico sia fatto soprattutto di salite e discese.
export function makeOursPlan({ evolvingBias = 0 } = {}) {
  const flows = airspace.flows.filter((f) => f.oursWeight > 0);
  if (!flows.length) return null;
  for (let attempt = 0; attempt < 25; attempt++) {
    const flow = weightedFlow(flows, 'oursWeight');
    const type = pickType(flow.distanceNm);
    const cruiseFL = chooseCruise(flow, type);
    if (cruiseFL === null) continue;
    const departure = isLocalDeparture(flow);
    const sFirst = departure ? rand(...DEPARTURE_NM) : flow.viewIn;
    const first = planFlight(flow, type, cruiseFL, sFirst);
    if (!first?.passage || first.passage.insideNm < MIN_INSIDE_NM) continue;

    const { profile } = first.base;
    if (passageReenters(airspace, flow, profile, first.passage)) continue;
    const entryInS = profileTime(profile, sFirst, first.passage.entry.s);
    if (!departure && (entryInS < MIN_LEAD_S || entryInS > EDGE_MAX_S)) continue;
    const planned = first;
    if (!inView(planned.base, 10)) continue;
    const passage = resolveExit(airspace, flow, profile, first.passage, first.base.perf, entryStart(airspace, first.passage));
    if (!passage) continue;
    const coord = coordinate(flow, type, profile, passage, planned.routeIdx);
    if (!coord) continue;
    if (coord.entryFt === coord.requestedExitFL * 100 && Math.random() < evolvingBias) continue;
    return { ...inboundPlan(planned, coord), departureFrom: departure ? flow.origin : null, entryInS };
  }
  return null;
}

// Lo stesso volo già in viaggio da qualche minuto, ancora fuori dal settore: a inizio sessione i primi voli sono
// già in avvicinamento lungo il flusso, in modo che ci vengano offerti fra offerInS secondi.
export function advancePlan(plan, offerInS) {
  const entryInS = offerInS + OFFER_LEAD_S;
  const s = distanceBefore(plan.profile, plan.entryS, entryInS);
  const planned = planFlight(plan.flow, plan.type, plan.rfl, s, plan.perf);
  const limit = plan.exitFix ?? plan.routeLimitFix;
  if (!planned || !inView(planned.base, 5) || (limit && !planned.base.route.includes(limit))) return null;
  const coord = Object.fromEntries(COORD_KEYS.map((k) => [k, plan[k]]));
  return { ...inboundPlan(planned, coord), departureFrom: null, entryInS };
}

// Traffico non di nostra competenza: parte da un aeroporto visibile o compare al bordo del radar
// e non entra mai nel volume del settore. midway: a inizio sessione è già in viaggio in un punto qualsiasi
// del flusso dentro il radar, così i settori attorno al nostro sono già popolati.
export function makeOtherPlan({ midway = false } = {}) {
  const flows = airspace.flows;
  for (let attempt = 0; attempt < 20; attempt++) {
    const flow = weightedFlow(flows);
    const type = pickType(flow.distanceNm);
    const cruiseFL = chooseCruise(flow, type);
    if (cruiseFL === null) continue;
    const departure = isLocalDeparture(flow);
    const sStart = departure ? rand(...DEPARTURE_NM) : flow.viewIn + rand(0, 4);
    const sSpawn = midway ? rand(sStart, Math.max(sStart, flow.viewOut - 25)) : sStart;
    const planned = planFlight(flow, type, cruiseFL, sSpawn);
    if (!planned || planned.passage || !inView(planned.base, midway ? 5 : 15)) continue;
    return { ...planned.base, control: 'other', departureFrom: departure && !midway ? flow.origin : null };
  }
  return null;
}

// Flussi in ordine casuale, i più trafficati tendenzialmente per primi (campionamento pesato senza ripetizione).
function weightedOrder(flows, key) {
  return flows
    .map((f) => ({ f, k: Math.random() ** (1 / f[key] ** FLOW_SPREAD) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.f);
}

// Primo punto in cui il flusso, dopo la comparsa, incontra dentro il settore la traiettoria prevista del
// bersaglio: la incrocia oppure le passa vicino, come i voli opposti o in coda sulla stessa rotta.
// path: campioni consecutivi {x, y, t, alt}; restituisce distanza lungo il flusso, istante e quota del
// bersaglio sull'incontro.
function firstEncounter(path, flow, sSpawn) {
  const legs = [];
  for (let j = 0; j < flow.points.length - 1; j++) {
    if (flow.cum[j + 1] >= sSpawn && flow.cum[j] <= flow.viewOut) legs.push(j);
  }
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    // vicinanza al flusso (stessa rotta, nello stesso verso o in quello opposto)
    if (insideLateral(a)) {
      for (const j of legs) {
        const p = flow.points[j];
        const q = flow.points[j + 1];
        const len = flow.cum[j + 1] - flow.cum[j];
        if (len <= 0) continue;
        const u = Math.max(0, Math.min(1, ((a.x - p.x) * (q.x - p.x) + (a.y - p.y) * (q.y - p.y)) / (len * len)));
        const s = flow.cum[j] + u * len;
        if (s > sSpawn && Math.hypot(p.x + (q.x - p.x) * u - a.x, p.y + (q.y - p.y) * u - a.y) < NEAR_PATH_NM) {
          return { s, t: a.t, alt: a.alt };
        }
      }
    }
    // incrocio fra due campioni consecutivi
    const b = path[i + 1];
    if (!b || b.gap) continue;
    for (const j of legs) {
      const hit = segmentIntersection(a, b, flow.points[j], flow.points[j + 1]);
      if (!hit || !insideLateral(hit)) continue;
      const s = flow.cum[j] + distance(flow.points[j], hit);
      if (s <= sSpawn) continue;
      return { s, t: a.t + (b.t - a.t) * hit.t, alt: a.alt + (b.alt - a.alt) * hit.t };
    }
  }
  return null;
}

// Coordinamento del piano e varianti vicine (±2000 ft) che portano il volo alla quota `alt` all'ingresso
// o all'uscita: livelli che l'ente precedente o quello successivo potrebbero ragionevolmente concordare.
function coordinationVariants(flow, type, cruiseFL, coord, alt) {
  const { floorFL, ceilingFL } = airspace.sector;
  const levels = levelsForTrack(flow.track, floorFL + 5, Math.min(ceilingFL - 5, type.maxFL, cruiseFL));
  const variants = [coord];
  if (!levels.length) return variants;
  const L = nearestLevel(levels, alt);
  if (coord.entryKind === 'lateral' && L * 100 !== coord.entryFt && Math.abs(L * 100 - coord.entryFt) <= 2000) {
    variants.push({ ...coord, entryFt: L * 100 });
  }
  if (coord.exitKind === 'lateral' && L !== coord.requestedExitFL && Math.abs(L - coord.requestedExitFL) <= 20) {
    variants.push({ ...coord, requestedExitFL: L });
  }
  return variants;
}

// Voli che l'ente adiacente potrebbe consegnarci incrociando la traiettoria prevista di un bersaglio.
// Per ogni flusso che la interseca dentro il settore si stima il ritardo di comparsa (delayS) che porta i
// due voli sull'incrocio insieme; il livello di crociera e il coordinamento possono avvicinarsi alla quota
// del bersaglio in quel punto. La verifica vera (con salite e discese) la fa la simulazione delle traiettorie.
// deadline: istante (performance.now) oltre il quale la ricerca si ferma.
export function* conflictCandidates(path, maxDelayS, deadline = Infinity) {
  const flows = weightedOrder(airspace.flows.filter((f) => f.oursWeight > 0), 'oursWeight');
  for (const flow of flows) {
    if (performance.now() > deadline) return;
    const type = pickType(flow.distanceNm);
    const rfls = requestedLevels(flow, type);
    if (!rfls.length) continue;
    const departure = isLocalDeparture(flow);
    const sSpawn = departure ? rand(...DEPARTURE_NM) : flow.viewIn + rand(0, 3);
    const hit = firstEncounter(path, flow, sSpawn);
    if (!hit) continue;
    // livello di crociera scelto normalmente e quello più vicino alla quota del bersaglio sull'incrocio
    for (const cruiseFL of new Set([chooseCruise(flow, type), nearestLevel(rfls, hit.alt)])) {
      const planned = planFlight(flow, type, cruiseFL, sSpawn);
      const passage = planned?.passage;
      if (!passage || passage.insideNm < MIN_INSIDE_NM || passage.entry.s > hit.s || passage.exit.s < hit.s) continue;
      const { profile } = planned.base;
      const entryInS = profileTime(profile, sSpawn, passage.entry.s);
      if (entryInS < MIN_LEAD_S || passageReenters(airspace, flow, profile, passage)) continue;
      const delayS = hit.t - profileTime(profile, sSpawn, hit.s);
      if (delayS < -120 || delayS > maxDelayS + 120) continue;
      const resolved = resolveExit(airspace, flow, profile, passage, planned.base.perf, entryStart(airspace, passage));
      if (!resolved) continue;
      const coord = coordinate(flow, type, profile, resolved, planned.routeIdx);
      if (!coord) continue;
      for (const variant of coordinationVariants(flow, type, cruiseFL, coord, hit.alt)) {
        yield {
          plan: { ...inboundPlan(planned, variant), entryInS, departureFrom: departure ? flow.origin : null },
          delayS,
        };
      }
    }
  }
}
