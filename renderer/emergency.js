// Emergenze sporadiche in rotta: un volo già in contatto dichiara un'avaria sulla nostra
// frequenza e chiede assistenza; la chiamata compare fra i messaggi in alto sul radar.
// Chiamate radio e righe di stato sono in inglese, come in frequenza; i commenti restano in italiano.
// Se il volo deve dirottare, il piano cambia di conseguenza: diretto all'aeroporto scelto, nuovo livello
// d'uscita e nuovo ente successivo, come per una normale uscita dal basso verso l'avvicinamento.
// Il controllore deve autorizzare la discesa e passare il volo. Se la discesa non arriva, le avarie gravi
// scendono lo stesso: il pilota naviga come ritiene appropriato e avvisa l'ATC.
// L'avaria radio (7600) non parla: mantiene livello e velocità per 7 minuti, poi riprende il piano di volo
// e non accetta più istruzioni.

import { airspace, unitAt, sectorAt, distance } from './airspace.js';
import { bottomTransferFL } from './sectors.js';
import { angleDiff, bearing } from './geo.js';

// Quante emergenze: percentuale dei voli di nostra competenza che ne dichiarano una (scelta nel menu).
// Una per volta; la prima non prima di qualche minuto, quando il settore ha già traffico in contatto.
export const EMERGENCY_PCT_DEFAULT = 2;
export const EMERGENCY_PCT_MAX = 10;
export const EMERGENCY_FIRST_MIN_S = 480;
export const EMERGENCY_MIN_ASSUMED_S = 90;     // il volo deve essere in contatto da almeno così
export const RADIO_FAILURE_HOLD_S = 420;       // 7 minuti al livello assegnato prima di riprendere il piano

const DIVERT_MAX_NM = 260;
const DIVERT_BEHIND_NM = 45;   // penalità per un aeroporto alle spalle del volo
const DIVERT_SMALL_NM = 20;    // penalità per gli aeroporti minori

const fmtFl = (n) => `FL${String(Math.round(n)).padStart(3, '0')}`;

// weight: frequenza relativa; urgency: segnale radiotelefonico: MAYDAY per
// l'emergenza (codice 7700), PAN PAN per l'urgenza, che ha priorità ma non è un'emergenza e non cambia codice;
// ownDescentS: secondi dopo i quali il volo scende da solo se non è stato autorizzato (null: aspetta);
// perf: fattori sulle prestazioni (rateo di discesa, di salita e velocità);
// targetFL: livello chiesto dal pilota; divert: dirottamento sull'aeroporto idoneo più vicino.
export const EMERGENCY_TYPES = [
  {
    id: 'depress',
    label: 'Decompression',
    weight: 3,
    urgency: 'MAYDAY',
    squawk: '7700',
    divert: true,
    ownDescentS: 90,
    perf: { descent: 2.4, climb: 0.15, speed: 1 },
    targetFL: (ac) => Math.max(60, Math.min(100, ac.flightLevel - 20)),
    request: (ac, e) => `${e.urgency} ${e.urgency} ${e.urgency}, ${ac.spoken}, rapid decompression, `
      + `request descent ${fmtFl(e.targetFL)}, divert ${e.divert}`,
  },
  {
    id: 'engine',
    label: 'Engine failure',
    weight: 3,
    urgency: 'MAYDAY',
    squawk: '7700',
    divert: true,
    ownDescentS: 180,
    perf: { descent: 0.85, climb: 0.15, speed: 0.85 },
    targetFL: (ac) => Math.max(110, Math.min(230, ac.flightLevel - 60)),
    request: (ac, e) => `${e.urgency} ${e.urgency} ${e.urgency}, ${ac.spoken}, engine failure, unable `
      + `to maintain level, request ${fmtFl(e.targetFL)}, divert ${e.divert}`,
  },
  {
    id: 'medical',
    label: 'Medical case',
    weight: 3,
    urgency: 'PAN PAN',
    squawk: null,
    divert: true,
    ownDescentS: null,
    perf: { descent: 1.1, climb: 1, speed: 1 },
    targetFL: (ac) => Math.max(90, Math.min(140, ac.flightLevel - 40)),
    request: (ac, e) => `${e.urgency}, ${e.urgency}, ${e.urgency}, ${ac.spoken}, medical case on board, `
      + `request priority, direct ${e.divert} and descent ${fmtFl(e.targetFL)}`,
  },
  {
    id: 'fuel',
    label: 'Fuel emergency',
    weight: 2,
    urgency: 'MAYDAY',
    squawk: '7700',
    divert: true,
    ownDescentS: 240,
    perf: { descent: 1, climb: 0.3, speed: 0.92 },
    targetFL: (ac) => Math.max(90, Math.min(180, ac.flightLevel - 50)),
    request: (ac, e) => `${e.urgency} ${e.urgency} ${e.urgency} FUEL, ${ac.spoken}, below final reserve, `
      + `request direct ${e.divert}, no delay, descent ${fmtFl(e.targetFL)}`,
  },
  {
    id: 'radio',
    label: 'Radio failure',
    weight: 2,
    urgency: null,
    squawk: '7600',
    radio: false,
    divert: false,
    ownDescentS: null,
    perf: { descent: 1, climb: 1, speed: 1 },
    targetFL: (ac) => ac.clearedFL,
    request: (ac) => `${ac.callsign} no reply, squawk 7600: maintaining ${fmtFl(ac.clearedFL)} `
      + 'and assigned speed',
  },
];

function weightedType(types) {
  let r = Math.random() * types.reduce((s, t) => s + t.weight, 0);
  return types.find((t) => (r -= t.weight) <= 0) ?? types[types.length - 1];
}

// Aeroporto idoneo più vicino con un ente di avvicinamento noto: pesano la distanza, il fatto che sia
// davanti o alle spalle e la dimensione dello scalo.
export function chooseDivert(ac) {
  let best = null;
  let bestScore = Infinity;
  for (const airport of airspace.airports) {
    if (!airport.app || airport.icao === ac.origin) continue;
    const d = distance(ac, airport);
    if (d > DIVERT_MAX_NM) continue;
    const behind = Math.abs(angleDiff(bearing(ac, airport), ac.heading)) > 100;
    const score = d + (behind ? DIVERT_BEHIND_NM : 0) + (airport.weight >= 2 ? 0 : DIVERT_SMALL_NM);
    if (score < bestScore) {
      best = airport;
      bestScore = score;
    }
  }
  return best;
}

// Uscita dal basso verso l'ente competente sotto il nostro limite inferiore (settore inferiore oppure
// avvicinamento dell'aeroporto di dirottamento), al livello più vicino al nostro limite inferiore.
function bottomExit(ac, point) {
  const { floorFL } = airspace.sector;
  const below = sectorAt(point, floorFL * 100 - 500);
  const nextUnit = below ? below.name : point.app ?? unitAt(point, floorFL * 100 - 500);
  return {
    requestedExitFL: bottomTransferFL(airspace.sector),
    nextUnit,
    nextUnitCode: below ? below.id : / APP$/.test(nextUnit) ? 'APP' : null,
  };
}

// Il volo dirotta: destinazione, rotta (diretto all'aeroporto) e coordinamento con l'ente successivo.
function divertTo(ac, airport) {
  const track = bearing(ac, airport);
  const exit = bottomExit(ac, airport);
  ac.destination = airport.icao;
  ac.route = [airport.icao];
  ac.routeLimitFix = airport.icao;
  ac.levelTrack = track;
  ac.mode = 'route';
  ac.turnDirection = null;
  ac.exitFix = null;
  ac.exitKind = 'bottom';
  ac.requestedExitFL = exit.requestedExitFL;
  ac.nextUnit = exit.nextUnit;
  ac.nextUnitCode = exit.nextUnitCode;
  ac.kind = 'arrival';
  ac.xflWarned = false;
  ac.levelledAtXflSince = null;
}

// Dichiarazione dell'emergenza: adatta il volo e restituisce lo stato da mostrare al controllore.
// Restituisce null se il tipo scelto non è applicabile a questo volo (nessun aeroporto di dirottamento).
export function declareEmergency(ac, simTime, type = weightedType(EMERGENCY_TYPES)) {
  // l'avaria radio si dà solo ai voli che escono lateralmente: il volo non cambia più livello e senza radio
  // non potrebbe essere portato al livello di un'uscita dall'alto o dal basso
  if (type.id === 'radio' && ac.exitKind !== 'lateral') return null;

  const airport = type.divert ? chooseDivert(ac) : null;
  if (type.divert && !airport) return null;

  const e = {
    id: type.id,
    label: type.label,
    urgency: type.urgency,
    squawk: type.squawk,
    radio: type.radio !== false,
    perf: type.perf,
    declaredAt: simTime,
    phase: 'requested',          // 'requested' | 'cleared' | 'own' | 'handed'
    ownDescentAt: type.ownDescentS === null ? null : simTime + type.ownDescentS,
    divert: airport?.icao ?? null,
    levelAtDeclaration: ac.clearedFL,
    resumeAt: type.id === 'radio' ? simTime + RADIO_FAILURE_HOLD_S : null,
  };
  e.targetFL = Math.round(type.targetFL(ac) / 10) * 10;   // i livelli si chiedono sempre a decine
  ac.emergency = e;

  if (airport) divertTo(ac, airport);
  if (type.id === 'radio') {
    // livello concordato per telefono con l'ente successivo: quello che il volo sta mantenendo
    ac.requestedExitFL = ac.clearedFL;
    ac.speedMode = 'assigned';
  }
  e.request = type.request(ac, e);
  return e;
}

// Come si annuncia il volo: MAYDAY o PAN PAN in fonia, oppure il solo codice SSR se non parla.
export function emergencyCall(e) {
  return e.urgency ?? `SQUAWK ${e.squawk}`;
}

// Riga di riepilogo dell'emergenza per l'etichetta: breve, in inglese come le chiamate.
export function emergencyStatus(ac) {
  const e = ac.emergency;
  if (!e) return '';
  if (!e.radio) {
    return e.phase === 'resumed'
      ? `no contact, flight plan level ${fmtFl(ac.clearedFL)}`
      : `no contact, maintaining ${fmtFl(ac.clearedFL)}`;
  }
  if (e.phase === 'own') return `descending ${fmtFl(e.targetFL)} on own`;
  if (e.phase === 'cleared') return `cleared ${fmtFl(ac.clearedFL)}`;
  return `requests ${fmtFl(e.targetFL)}${e.divert ? `, divert ${e.divert}` : ''}`;
}

export { fmtFl };
