// Banco di prova senza interfaccia: fa girare la simulazione con un "controllore automatico"
// (hand-on appena il volo è offerto, livello d'uscita autorizzato subito, hand-off al momento giusto)
// e misura, per ogni settore, il carico medio, le offerte orarie, i minuti di competenza per volo,
// gli allarmi STCA, i conflitti programmati consegnati (plannedPerH) e quelli che senza interventi si presentano
// davvero (plannedRealPerH), gli arrivi offerti ancora in salita (climbingArrivals: deve restare 0),
// gli hand-off sbagliati o mancati e i voli che (senza vettoramenti) entrerebbero in una zona
// attiva: allarmi di prossimità (apwPerH) e violazioni (areaPerH, di cui areaStrikes contate come errori).
//
//   node tools/harness.mjs roma            tutti i settori di Roma ACC
//   node tools/harness.mjs milano ENB ESA  solo alcuni settori
//   HOURS=8 node tools/harness.mjs milano  ore di simulazione per settore (5 di default)
//
// transitMin e demand dei settori (sectors-roma.js, sectors-milano.js) sono tarati su queste misure:
// il carico medio deve avvicinarsi a quello della difficoltà (facile 5 · media 7,5 · difficile 10).
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const { setCentre, CENTRES } = await import(`${R}/sectors.js`);
const { loadSector, airspace, insideLateral, waypoint } = await import(`${R}/airspace.js`);
const { Simulation } = await import(`${R}/sim.js`);
const { distance } = await import(`${R}/geo.js`);

const DT = 2;   // passo di simulazione (s)

function nearExit(ac) {
  const fix = ac.exitFix ? waypoint(ac.exitFix) : null;
  return fix ? distance(ac, fix) < 6 : false;
}

export function measure(centreId, sectorId, hours = 5, seed = 1) {
  // il seme va fissato prima di caricare il settore: anche le piste in uso (vento) si scelgono a caso
  let rnd = (seed * 2654435761) % 4294967296;
  Math.random = () => {
    rnd = (rnd * 1664525 + 1013904223) % 4294967296;
    return rnd / 4294967296;
  };
  setCentre(centreId);
  loadSector(sectorId);
  // DIFF=facile|media|difficile per misurare un'altra difficoltà (di default quella del settore)
  const sim = new Simulation(process.env.DIFF ? { difficulty: process.env.DIFF } : {});
  sim._endGame = () => {};   // le perdite di separazione non fermano la misura
  sim.seedInitialTraffic();

  const offerTime = new Map();
  const wrong = [];
  const transits = [];
  let offers = 0;
  const apw = new Set();
  let areaHits = 0;
  let areaStrikes = 0;
  let emergencies = 0;
  let ownDescents = 0;
  let climbingArrivals = 0;   // arrivi (devono scendere nel settore) offerti mentre stanno ancora salendo
  const planned = new Map();  // voli consegnati in conflitto programmato -> bersaglio
  let plannedReal = 0;        // ...il cui conflitto, senza interventi, si è presentato davvero (allarme STCA)
  const emergencyKinds = {};
  sim.on('event', (e) => {
    if (e.type === 'apw') apw.add(`${e.ac.callsign}|${e.area.id}`);
    if (e.type === 'area-infringement') {
      areaHits++;
      if (e.strike) areaStrikes++;
    }
    if (e.type === 'emergency') {
      emergencies++;
      emergencyKinds[e.emergency.id] = (emergencyKinds[e.emergency.id] ?? 0) + 1;
    }
    if (e.type === 'emergency-descent') ownDescents++;
    if (e.type === 'offered') {
      const { ac } = e;
      const descends = ac.exitKind === 'bottom' || ac.exitKind === 'star' || ac.requestedExitFL * 100 < ac.entryFt;
      // (chi ha deviato per un temporale può dover ancora livellare al primo livello sopra: meno di 1000 ft)
      if (descends && ac.assignedAltitude > ac.altitude + 1000) climbingArrivals++;
      if (ac.plannedConflict) planned.set(ac.id, ac.plannedConflict.targetId);
      offers++;
      offerTime.set(e.ac, sim.simTime);
    }
    if (e.type === 'handoff' || e.type === 'missed') {
      const t0 = offerTime.get(e.ac);
      if (t0 != null) transits.push(sim.simTime - t0);
      if (!e.correct) wrong.push(e.type === 'missed' ? 'mancato' : `FL${e.ac.clearedFL} invece di FL${e.ac.requestedExitFL}`);
    }
  });

  const seen = new Set();
  let loadSum = 0;
  let tickMs = 0;   // tick più lento (ms) e somma, per il tempo medio
  let tickSum = 0;
  let samples = 0;
  let conflicts = 0;
  for (let t = 0; t < hours * 3600; t += DT) {
    for (const ac of sim.aircraft) {
      if (ac.control === 'offered') sim.handOn(ac);
      if (ac.control !== 'assumed') continue;
      if (ac.requestedExitFL != null && ac.clearedFL !== ac.requestedExitFL) ac.setFlightLevel(ac.requestedExitFL);
      const ready = ac.wasInside && (ac.verticalExit
        ? Math.abs(ac.altitude - ac.requestedExitFL * 100) < 1200
        : (ac.wasLateral && !insideLateral(ac)) || nearExit(ac));
      if (ready) sim.handOff(ac);
    }
    const t0 = performance.now();
    sim.tick(DT);
    tickMs = Math.max(tickMs, performance.now() - t0);
    tickSum += performance.now() - t0;
    for (const p of sim.stca) {
      const key = [p.a.callsign, p.b.callsign].sort().join('-');
      if (!seen.has(key)) {
        seen.add(key);
        conflicts++;
        if (planned.get(p.a.id) === p.b.id || planned.get(p.b.id) === p.a.id) plannedReal++;
      }
    }
    loadSum += sim.aircraft.filter((a) => a.control === 'offered' || a.control === 'assumed').length;
    samples++;
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return {
    sector: sectorId,
    demand: sim.demand,
    offersPerH: +(offers / hours).toFixed(1),
    load: +(loadSum / samples).toFixed(2),
    tickMsAvg: +(tickSum / samples).toFixed(2),
    tickMsMax: +tickMs.toFixed(1),
    transitMin: +(mean(transits) / 60).toFixed(2),
    handoffs: transits.length,
    stcaPerH: +(conflicts / hours).toFixed(1),
    plannedPerH: +(planned.size / hours).toFixed(1),
    plannedRealPerH: +(plannedReal / hours).toFixed(1),
    climbingArrivals,
    wrong: wrong.length,
    emergencies,
    emergencyKinds,
    ownDescents,
    levelReq: sim.requests.level,
    turbReq: sim.requests.turb,
    wxReq: sim.requests.deviation,
    wxOwn: sim.requests.own,
    apwPerH: +(apw.size / hours).toFixed(1),
    areaPerH: +(areaHits / hours).toFixed(1),
    areaStrikes,
  };
}

// riga di comando: solo quando il file viene eseguito direttamente
const [, , centreId, ...only] = process.argv;
if (centreId && process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const centre = CENTRES.find((c) => c.id === centreId);
  if (!centre) {
    console.error(`ACC sconosciuto: ${centreId} (${CENTRES.map((c) => c.id).join(', ')})`);
    process.exit(1);
  }
  const ids = only.length ? only : centre.sectors.map((s) => s.id);
  for (const id of ids) console.log(JSON.stringify(measure(centreId, id, Number(process.env.HOURS ?? 5))));
}
