import { waypoint, insideVolume, insideLateral, inView, airspace, distanceFromSector } from './airspace.js';
import { generateCallsign } from './callsigns.js';
import { DIFFICULTY, sectorDemand } from './sectors.js';
import { normalizeDeg, angleDiff, bearing, distance, distanceToSegment } from './geo.js';
import { profileAltitude, profilePhase, profileTime } from './flows.js';
import {
  makeOursPlan, makeOtherPlan, advancePlan, conflictCandidates, shuffle, routeLengthNm, coordinatedAltitude,
  OFFER_LEAD_S,
} from './traffic.js';
import { climbRate, descentRate, scheduleSpeed, speedEnvelope, turnRate, soundSpeedKt } from './performance.js';
import {
  makeAreaSchedule, isActiveAt, areaContains, areaTooClose, isAreaRelevant, areaBand, currentOrNextWindow, APW_S,
} from './areas.js';
import {
  declareEmergency, EMERGENCY_PCT_DEFAULT, EMERGENCY_FIRST_MIN_S, EMERGENCY_MIN_ASSUMED_S, fmtFl,
} from './emergency.js';
import {
  makeWeather, stepWeather, WEATHER_DEFAULT, cellHit, cellAffects, cellRadius, cellAt, avoidHeading, AVOID_MARGIN_NM,
  upwindSide, headwind, turbAt, reportedTurbAt,
} from './weather.js';
import {
  chooseLevelRequest, chooseTurbulenceRequest, levelReplyText, levelGiveUpText, deviationText, deviationUnableText,
  deviationOwnText, resumeText, resumeOwnText,
  LEVEL_FIRST_S, LEVEL_MEAN_S, LEVEL_MIN_ASSUMED_S, LEVEL_MIN_LEFT_S, REQUEST_TIMEOUT_S, MAX_PENDING,
  DEVIATION_HORIZON_S, DEVIATION_OWN_S, RESUME_OWN_S,
} from './requests.js';

const ACCEL_KT_S = 1.5;          // variazione di velocità vera
const WAYPOINT_CAPTURE_NM = 2;
const MAX_TURN_LEAD_NM = 12;     // anticipo massimo della virata sui punti sorvolati
// Scia radar: una posizione ogni HISTORY_S secondi (il giro di un radar di rotta), a intervalli fissi di tempo:
// la distanza fra i punti mostra la velocità. Se ne tengono al massimo MAX_HISTORY.
export const HISTORY_S = 12;
const MAX_HISTORY = 10;

export const SEP_HORIZONTAL_NM = 5;
export const SEP_VERTICAL_FT = 1000;
export const CONFLICT_LOOKAHEAD_S = 300; // 5 minuti
export const MAX_STRIKES = 3;
export const STCA_S = 60;          // allarme automatico: perdita di separazione prevista entro 1 minuto

const MISSED_HANDOFF_GRACE_S = 30; // tolleranza fuori dal settore prima di considerare l'hand-off mancato
const ENTRY_TOLERANCE_NM = 3;      // un volo è entrato nel settore solo da poco prima del punto d'ingresso pianificato
const EXCURSION_TOLERANCE_NM = 3; // uscita pianificata ancora davanti di almeno così: l'uscita laterale è temporanea
const EXIT_POINT_TOLERANCE_NM = 8; // scostamento laterale massimo dal punto d'uscita quando si lascia il settore
const XFL_LEVEL_WARN_S = 30;       // uscita dall'alto o dal basso: volo livellato all'XFL e ancora in contatto
const TRANSFER_BELOW_FT = 2000;    // l'ente inferiore porta subito il volo almeno così sotto il nostro limite
const IN_TRAIL_S = 150;            // separazione temporale minima fra due voli sullo stesso flusso
const SPAWN_SPACING_NM = 15;
const DEPARTURE_INTERVAL_S = 110;  // intervallo minimo fra due partenze dallo stesso aeroporto
const MAX_CONFLICT_DELAY_S = 600;  // un volo in conflitto può essere fatto comparire fino a 10 minuti dopo
const PREDICT_STEP_S = 10;         // passo delle previsioni lungo rotte e profili
const PREDICT_MAX_S = 1200;        // orizzonte massimo della verifica alla comparsa

// programmazione del traffico nostro
const PLAN_AHEAD_S = 1500;         // le offerte si programmano 25 minuti prima: copre il volo dal bordo del radar
const PLAN_EVERY_S = 5;
const GAP_SHAPE = 2;               // regolarità degli intervalli fra offerte (distribuzione gamma; 1 = Poisson)
const GAP_RANGE = [0.15, 2.2];     // intervallo fra due offerte, in multipli di quello medio: niente buchi lunghi
const BUNCH_S = [15, 75];          // offerte ravvicinate: due voli passati quasi insieme
const LATE_SLOT_S = 300;           // slot ormai vicino: si accetta il volo che arriva prima, anche se un po' in ritardo
const SPAWN_RETRY_S = 10;          // traffico vicino al punto di comparsa: il volo arriva qualche secondo dopo
const SPAWN_MAX_WAIT_S = 120;

// conflitti programmati
const CONFLICT_STEP_S = 5;         // passo delle traiettorie simulate
const CONFLICT_HORIZON_S = 1800;
const CONFLICT_SCAN_S = 120;       // ricerca del ritardo di comparsa attorno alla stima geometrica
const CONFLICT_BUDGET_MS = 9;      // tempo di calcolo massimo per tentativo: nessuno scatto del radar
const CONFLICT_RETRY_S = 10;
const CONFLICT_CATCHUP_S = 600;    // conflitti in ritardo recuperati al più per questo tempo: niente raffiche
const MOVED_FT = 900;              // un volo ha cambiato livello dall'offerta: il conflitto nasce da salita o discesa

// Zone attive (areas.js): previsione lungo rotta e livello autorizzato per i voli di nostra competenza, dal loro
// ingresso nel settore fino all'hand-off, rifatta ogni AREA_CHECK_EVERY_S secondi.
const AREA_PREDICT_S = 900;
const AREA_PREDICT_STEP_S = 5;      // abbastanza fine da non saltare lo spigolo di una zona piccola
const AREA_CHECK_EVERY_S = 4;
const AREA_GRACE_S = 120;          // un volo offerto da meno di così che entra in una zona non è un nostro errore
const SEED_FIRST_OFFER_S = 20;     // il primo volo iniziale ci viene offerto dopo pochi secondi
const SEED_ASSUMED_SHARE = 0.35;   // voli iniziali già in contatto all'avvio, appena fuori dal confine
const SEED_ASSUMED_MAX_S = 45;     // ...a non più di così dall'offerta: entrano entro un paio di minuti
const SEED_ASSUMED_MIN_STAY_S = 420; // ...e restano nel settore almeno sette minuti
const SEED_OTHER_SHARE = 0.75;     // traffico di contesto già in volo all'avvio, in frazione del massimo
const STREAM_START_SHARE = 0.7;    // offerte normali dopo questa frazione del tempo medio di passaggio
const WARMUP_SOON_S = 150;         // nei primi minuti: voli che ci verranno offerti a breve, contati come già presenti
// Carico costante: ogni pochi secondi si prevede quanti voli saranno offerti o in contatto fra qualche minuto
// (quelli già nostri ancora nel settore, quelli in arrivo e quelli programmati), fino a 25 minuti avanti, quanto
// serve a un volo per arrivare dal bordo del radar. Sotto il carico della difficoltà si programma un volo per
// quell'istante; sopra, l'ente precedente trattiene il volo che stava per comparire. Così il settore resta
// carico qualunque sia il ritmo con cui il controllore passa i voli.
const BALANCE_HORIZONS_S = [180, 360, 600, 900, 1200, 1500];
const BALANCE_HIGH = 1;            // sopra load + così non si fa comparire il volo programmato
const BALANCE_HOLD_MAX_S = 900;    // si trattengono solo voli da offrire entro un quarto d'ora
const BALANCE_GAIN = 1 / 480;      // correzione dell'obiettivo: un volo di scarto per otto minuti la sposta di 1
const BALANCE_BIAS = [-3, 5];      // limiti della correzione
const HANDOFF_LEAD_WEIGHT = 0.2;   // media mobile dell'anticipo con cui il controllore passa i voli
const CLEARANCE_DELAY_S = 90;      // tempo tipico prima che il controllore autorizzi la salita o la discesa
const CLOCK_START_S = [6.5 * 3600, 15 * 3600]; // la sessione inizia in una fascia diurna (UTC), con attività militare

// Emergenze (emergency.js): una per volta, su un volo in contatto da qualche minuto e dentro il settore.
const EMERGENCY_RETRY_S = 60;      // nessun volo adatto: si riprova fra un minuto
const LEVEL_RETRY_S = 900;         // un equipaggio non richiede un altro livello prima di un quarto d'ora
const MESSAGE_LIFE_S = 55;         // durata dei messaggi non permanenti nel riquadro radio
const CLEARED_MARGIN_FT = 1500;    // discesa autorizzata: livello almeno così sotto quello della dichiarazione
const DIVERT_FT_NM = 320;          // dopo l'hand-off il volo dirottato scende verso l'aeroporto (circa 3°)

// Temporali (weather.js) e richieste dei piloti (requests.js)
const WX_CHECK_EVERY_S = 4;        // ogni quanto si rifà la previsione della rotta contro le celle
const WX_STEP_S = 20;              // passo della previsione
const WX_OTHER_HORIZON_S = 420;    // il traffico non nostro evita le celle da solo, senza chiedere
const WX_CORE_SCALE = 0.45;        // si chiede la deviazione solo se la rotta entra nel cuore della cella
const WX_CLEAR_SCALE = 0.8;        // la richiesta cade da sola solo se la rotta passa ben fuori (isteresi)
const WX_ACCEPT_SCALE = 0.7;       // un'istruzione va bene al pilota se lo tiene almeno così lontano dalle celle
const WX_REJOIN_SCALE = 0.9;       // per rientrare in rotta il diretto deve essere davvero libero
const WX_REJOIN_HORIZON_S = 720;   // e per tutto il tratto fino al punto (celle che crescono comprese)
const WX_URGENT_S = 90;            // cella così vicina che il pilota devia prima di chiedere
const WX_REPORT_CHANGE_DEG = 15;   // correzioni della deviazione autonoma che il pilota comunica
const WX_PLAN_MARGIN = 1.1;        // la prua chiesta tiene tutto il margine voluto, con un po' di scorta
const WX_PLAN_BEYOND_S = 240;      // la prua chiesta deve restare libera fin oltre la cella
const WX_MIN_TURN = 10;            // deviazioni più piccole non si chiedono
const WX_MAX_TURN = 60;
const WX_DOWNWIND_COST = 10;       // gradi di virata in più che si accettano per restare sopravento
const WX_AWAY_COST = 5;            // e per deviare dal lato verso cui prosegue la rotta
const WX_EXIT_SLACK_S = 45;        // celle oltre l'uscita dal settore: le chiederà all'ente successivo
const WX_RECHECK_S = 90;           // ogni tanto si controlla che la deviazione basti ancora
const WX_MIN_ANSWER_S = 45;        // tempo minimo lasciato al controllore prima che il pilota devii da solo
const WX_PASSED_DEG = 95;          // cella ormai al traverso o alle spalle: il volo può rientrare
const WX_REJOIN_S = 240;           // orizzonte con cui si controlla la prua durante la deviazione
const WX_REJOIN_AFTER_S = 90;      // dopo aver virato si aspetta almeno così prima di chiedere di rientrare
const WX_REJOIN_EVERY_S = 30;      // ogni quanto il pilota guarda se il diretto è libero
const WX_REJOIN_MIN_NM = 15;       // punto di rientro non troppo vicino
const WX_REJOIN_MAX_TURN = 100;    // né alle spalle
const WX_REJOIN_LAST_TURN = 130;
const WX_SAME_CELL_S = 480;        // non si richiede subito un'altra deviazione per la stessa cella
const WX_SAME_CELL_NEAR_S = 240;   // salvo che sia ormai a meno di quattro minuti

// Turbolenza in aria chiara (weather.js)
const TURB_FIRST_S = 480;          // nei primi minuti di sessione nessuno la riporta
const TURB_CALL_FIRST_S = 50;      // il primo che la incontra chiama dopo un po'
const TURB_CALL_KNOWN_S = 15;      // chi sa già dove è chiama subito
const TURB_RETRY_S = 300;          // senza risposta, richiede dopo cinque minuti se è ancora lì
const TURB_MAX_PENDING = 3;

let nextId = 1;

const NOMINAL_PERF = { speed: 1, climb: 1, descent: 1 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Campione di una distribuzione gamma di forma intera k e media 1.
function gammaUnit(k) {
  let sum = 0;
  for (let i = 0; i < k; i++) sum -= Math.log(1 - Math.random());
  return sum / k;
}

function weightedKey(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
  return (entries.find(([, w]) => (r -= w) <= 0) ?? entries[entries.length - 1])[0];
}

function velocityVector(ac) {
  const nmPerSec = ac.speed / 3600;
  const rad = (ac.heading * Math.PI) / 180;
  return { x: Math.sin(rad) * nmPerSec, y: -Math.cos(rad) * nmPerSec };
}

// Quota prevista fra t secondi verso la quota assegnata (poi livellato).
export function predictAltitude(ac, t) {
  const diff = ac.assignedAltitude - ac.altitude;
  if (Math.abs(diff) < 1) return ac.altitude;
  const rate = ac.effectiveRateFtS ? ac.effectiveRateFtS(diff > 0) : diff > 0 ? ac.climbFtS : ac.descentFtS;
  const timeToLevel = Math.abs(diff) / rate;
  const effT = Math.min(Math.max(t, 0), timeToLevel);
  return ac.altitude + rate * Math.sign(diff) * effT;
}

// Intervallo di tempo [start,end] entro l'orizzonte in cui la distanza orizzontale
// prevista (prua/velocità correnti, nessuna virata futura) scende sotto SEP_HORIZONTAL_NM.
function horizontalConflictWindow(a, b, horizon) {
  const va = velocityVector(a);
  const vb = velocityVector(b);
  const dpx = a.x - b.x;
  const dpy = a.y - b.y;
  const dvx = va.x - vb.x;
  const dvy = va.y - vb.y;

  const A = dvx * dvx + dvy * dvy;
  const B = 2 * (dpx * dvx + dpy * dvy);
  const C = dpx * dpx + dpy * dpy - SEP_HORIZONTAL_NM * SEP_HORIZONTAL_NM;

  if (A < 1e-9) {
    return C < 0 ? [0, horizon] : null;
  }

  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-B - sqrtDisc) / (2 * A);
  const t2 = (-B + sqrtDisc) / (2 * A);

  const start = Math.max(t1, 0);
  const end = Math.min(t2, horizon);
  if (start > end) return null;
  return [start, end];
}

function pairConflictTime(a, b, horizon) {
  const window = horizontalConflictWindow(a, b, horizon);
  if (!window) return null;
  const [start, end] = window;
  for (let s = 0; s <= 5; s++) {
    const t = start + ((end - start) * s) / 5;
    if (Math.abs(predictAltitude(a, t) - predictAltitude(b, t)) < SEP_VERTICAL_FT) return t;
  }
  return null;
}

// Rileva le coppie di aerei che, proseguendo sulla rotta/velocità attuale,
// perderanno la separazione (5nm / 1000ft) entro l'orizzonte temporale dato.
export function predictConflicts(aircraftList, horizon = CONFLICT_LOOKAHEAD_S) {
  const results = [];
  for (let i = 0; i < aircraftList.length; i++) {
    for (let j = i + 1; j < aircraftList.length; j++) {
      const t = pairConflictTime(aircraftList[i], aircraftList[j], horizon);
      if (t !== null) results.push({ a: aircraftList[i], b: aircraftList[j], timeToConflict: Math.max(0, t) });
    }
  }
  return results;
}

// Stati di controllo:
//   other       non di nostra competenza (giallo)
//   inbound     in arrivo, ancora con l'ente precedente (giallo)
//   offered     passato a noi dall'ente precedente, in attesa di hand-on (magenta)
//   assumed     in contatto con noi
//   transferred hand-off effettuato, non più in contatto (giallo)
// rateo assegnato: in salita fino a 1,3 volte quello normale del tipo (il pilota riduce la velocità), in discesa
// fino a 1,5 volte (aerofreni)
const CLIMB_RATE_MAX = 1.3;
const DESCENT_RATE_MAX = 1.5;
export const OURS = new Set(['inbound', 'offered', 'assumed']);

function kindOf(plan) {
  if (plan.exitKind === 'bottom' || plan.exitKind === 'star') return 'arrival';
  if (plan.entryKind === 'below' || plan.exitKind === 'top') return 'departure';
  const s = plan.flow.total - routeLengthNm(plan, plan.route);
  const now = profileAltitude(plan.profile, s);
  const later = profileAltitude(plan.profile, s + 60);
  if (later > now + 1000) return 'departure';
  if (later < now - 1000) return 'arrival';
  return 'overflight';
}

export class Aircraft {
  constructor(plan) {
    this.id = nextId++;
    this.callsign = plan.callsign;
    this.spoken = plan.spoken;
    this.x = plan.x;
    this.y = plan.y;
    this.heading = plan.heading;
    this.speed = plan.speed;
    this.altitude = plan.altitude;

    this.flow = plan.flow;
    this.type = plan.type;
    this.perf = plan.perf ?? NOMINAL_PERF; // differenze rispetto alle prestazioni medie del tipo
    this.profile = plan.profile;
    this.rfl = plan.rfl ?? null; // livello di crociera richiesto nel piano di volo
    this.origin = plan.origin;
    this.destination = plan.destination;
    this.levelTrack = plan.levelTrack; // rotta su cui si applica la semicircolare
    this.control = plan.control;
    this.kind = kindOf(plan);

    // coordinamento con gli enti adiacenti (solo voli di nostra competenza)
    this.entryKind = plan.entryKind ?? null;
    this.entryFt = plan.entryFt ?? null;
    this.entryS = plan.entryS ?? null;
    this.exitS = plan.exitS ?? null;   // uscita pianificata lungo il flusso (per prevedere il carico)
    this.entryFix = plan.entryFix ?? null; // punto finale della SID su cui l'avvicinamento ci consegna la partenza
    this.clamp = plan.clamp ?? null;
    this.exitFix = plan.exitFix ?? null;
    this.exitKind = plan.exitKind ?? null;
    this.requestedExitFL = plan.requestedExitFL ?? null;
    this.nextUnit = plan.nextUnit ?? null;
    this.nextUnitCode = plan.nextUnitCode ?? null; // sigla breve dell'ente successivo (uscite dall'alto e dal basso)
    this.routeLimitFix = plan.routeLimitFix ?? null; // oltre questo punto la rotta è di altri enti
    this.prevUnit = plan.prevUnit ?? null;

    this.mode = 'route'; // 'route' | 'heading'
    this.assignedHeading = plan.heading;
    this.turnDirection = null; // 'left' | 'right' | null (lato più breve)
    this.lastInstruction = null;
    this.assignedSpeed = plan.speed;
    this.speedMode = 'own'; // 'own': programma di velocità del tipo | 'assigned': velocità assegnata
    this.assignedMach = null; // Mach assegnato in quota (la velocità assegnata ne deriva)
    this.assignedAltitude = plan.assignedAltitude ?? plan.altitude;
    // dati letti da bordo per la label: rateo verticale (ft/min) e livello selezionato dal pilota (SLB), che
    // segue il livello autorizzato dopo il tempo di collazione e impostazione
    this.verticalFpm = 0;
    this.assignedRateFpm = null; // rateo di salita o discesa assegnato dal controllore (null: quello del tipo)
    this.slbFL = Math.round(this.assignedAltitude / 1000) * 10;
    this._slbWait = 0;

    this.route = [...plan.route]; // punti rimanenti fino all'aeroporto di destinazione
    // un volo che compare è già in volo: la scia parte indietro lungo la prua attuale
    this.trail = [];
    const back = (this.speed / 3600) * HISTORY_S;
    const rad0 = (this.heading * Math.PI) / 180;
    for (let k = MAX_HISTORY; k >= 1; k--) {
      this.trail.push({ x: this.x - Math.sin(rad0) * back * k, y: this.y + Math.cos(rad0) * back * k });
    }
    this._trailTimer = 0;
    this.conflict = false;
    this.stca = false;
    this.selected = false;
    this.apw = null;          // zona attiva troppo vicina (allarme di prossimità): traccia e zona rosse
    this.areaConflict = null; // prima zona attiva prevista lungo rotta e livello: {area, t, x, y, altFt}
    this.areaStrikes = new Set(); // zone già violate (un solo errore per zona)
    this.offeredAt = null;
    this.assumedAt = null;
    this.emergency = null;   // avaria dichiarata in contatto (emergency.js)
    this.request = null;     // richiesta del pilota in attesa di risposta (requests.js)
    this.levelAskedAt = null; // ultima richiesta di livello: non si insiste subito dopo un rifiuto
    this.instrSeq = 0;       // contatore delle istruzioni di rotta e di livello: il pilota sa se gli hai risposto
    this.altExitFL = null;   // livello d'uscita pianificato, ancora valido dopo una revisione chiesta dal pilota
    this.wxDeviated = false; // ha deviato per il maltempo: il punto d'uscita si coordina a voce
    this.turbIn = null;      // zona di turbolenza in cui si trova: {id, since}
    this.wxAvoid = null;     // cella che il traffico non nostro sta aggirando da solo
    this.wxDone = null;      // ultima cella superata: non se ne richiede subito un'altra deviazione
    this.showVector = false; // vettore velocità, acceso con un doppio clic sul nominativo della label
    this.tagOffset = { x: 30, y: -30 }; // posizione del tag rispetto alla traccia (px): trascinandolo o ruotandolo
    this.tagAngle = 45; // una delle otto posizioni a linea guida fissa (gradi da nord), null se il tag è stato trascinato

    this.wasAssumed = plan.control === 'assumed';
    this.wasInside = false;
    // già dentro il settore alla comparsa, ma solo se ha raggiunto il punto d'ingresso pianificato
    this.wasLateral = insideLateral(this) && (this.entryS === null || this.alongTrackNm() >= this.entryS - ENTRY_TOLERANCE_NM);
    this.outsideSince = null;
    this.transferredAt = null;
    this.exitChecked = false;
    this.levelledAtXflSince = null;
    this.xflWarned = false;
  }

  get flightLevel() {
    return Math.round(this.altitude / 100);
  }

  get clearedFL() {
    return Math.round(this.assignedAltitude / 100);
  }

  // ratei verticali (ft/s) alla quota attuale; in emergenza cambiano (discesa rapida, salita impossibile)
  get climbFtS() {
    return (climbRate(this.type, this.altitude) * this.perf.climb * (this.emergency?.perf.climb ?? 1)) / 60;
  }

  get descentFtS() {
    return (descentRate(this.type, this.altitude) * this.perf.descent * (this.emergency?.perf.descent ?? 1)) / 60;
  }

  // Rateo effettivo (ft/s) verso il livello autorizzato: quello del tipo, oppure quello assegnato dal
  // controllore, entro i limiti CLIMB_RATE_MAX e DESCENT_RATE_MAX.
  effectiveRateFtS(climbing) {
    const own = climbing ? this.climbFtS : this.descentFtS;
    if (!this.assignedRateFpm) return own;
    return Math.min(this.assignedRateFpm / 60, own * (climbing ? CLIMB_RATE_MAX : DESCENT_RATE_MAX));
  }

  get verticalPhase() {
    const diff = this.assignedAltitude - this.altitude;
    return diff > 50 ? 'climb' : diff < -50 ? 'descent' : 'cruise';
  }

  // Avaria radio in contatto: il volo non riceve più istruzioni, resta solo l'hand-off.
  get noRadio() {
    return this.control === 'assumed' && this.emergency?.radio === false;
  }

  // Livello giusto per l'hand-off: quello d'uscita richiesto oppure, dopo una revisione chiesta dal pilota,
  // anche quello pianificato all'inizio.
  get exitLevelOk() {
    return this.requestedExitFL !== null
      && (this.clearedFL === this.requestedExitFL || (this.altExitFL !== null && this.clearedFL === this.altExitFL));
  }

  // Uscita dall'alto o dal basso: il volo lascia il settore passando il limite verticale, non su un punto.
  get verticalExit() {
    return this.exitKind === 'top' || this.exitKind === 'bottom';
  }

  // Ultimo punto della rotta modificabile: il punto d'uscita oppure, per le uscite verticali, il primo punto
  // dopo il confine laterale del settore.
  get exitIndex() {
    const limit = this.exitFix ?? this.routeLimitFix;
    const idx = limit ? this.route.indexOf(limit) : -1;
    return idx >= 0 ? idx : this.route.length - 1;
  }

  remainingRouteNm() {
    return routeLengthNm(this, this.route);
  }

  // Distanza percorsa lungo il flusso pianificato (serve per il profilo verticale).
  alongTrackNm() {
    return this.flow.total - this.remainingRouteNm();
  }

  // Copia senza effetti sul traffico reale, usata per prevedere la traiettoria.
  ghost() {
    const g = Object.assign(Object.create(Aircraft.prototype), this);
    g.route = [...this.route];
    g.trail = [];
    return g;
  }

  // direction: 'left' | 'right' impone il lato della virata anche se non è il più breve.
  setHeading(deg, direction = null) {
    if (this.noRadio) return;
    this.instrSeq++;
    this.mode = 'heading';
    this.assignedHeading = normalizeDeg(deg);
    this.turnDirection = direction;
  }

  turnBy(deltaDeg) {
    this.setHeading(this.heading + deltaDeg, deltaDeg >= 0 ? 'right' : 'left');
  }

  resumeOwnNavigation() {
    if (this.noRadio) return;
    this.instrSeq++;
    this.mode = 'route';
    this.turnDirection = null;
  }

  // Diretto a un punto già in rotta, al più fino al punto d'uscita (che non si può saltare).
  directToRouteIndex(index) {
    if (this.noRadio || index < 0 || index > this.exitIndex) return false;
    this.instrSeq++;
    this.route.splice(0, index);
    this.mode = 'route';
    this.turnDirection = null;
    return true;
  }

  // Diretto a un punto qualsiasi e poi al punto d'uscita richiesto: l'uscita non cambia mai.
  directTo(waypointId) {
    if (this.noRadio || !waypoint(waypointId)) return false;
    const idx = this.route.indexOf(waypointId);
    if (idx >= 0) return this.directToRouteIndex(idx);
    this.instrSeq++;
    this.route = [waypointId, ...this.route.slice(this.exitIndex)];
    this.mode = 'route';
    this.turnDirection = null;
    return true;
  }

  // Inserimento consentito solo prima del punto d'uscita.
  insertWaypoint(waypointId, position) {
    if (this.noRadio || !waypoint(waypointId)) return false;
    const pos = Math.max(0, Math.min(position, this.exitIndex));
    this.instrSeq++;
    this.route.splice(pos, 0, waypointId);
    return true;
  }

  // Il punto d'uscita e i punti successivi (di competenza di altri enti) non si rimuovono.
  removeWaypointAt(position) {
    if (this.noRadio || position < 0 || position >= this.exitIndex) return false;
    this.instrSeq++;
    this.route.splice(position, 1);
    return true;
  }

  // Velocità vera assegnata, limitata alle prestazioni del tipo alla quota attuale. Restituisce quella applicata.
  setSpeed(kt) {
    if (this.noRadio) return this.assignedSpeed;
    const { min, max } = speedEnvelope(this.type, this.altitude);
    this.speedMode = 'assigned';
    this.assignedMach = null;
    this.assignedSpeed = Math.round(Math.max(min, Math.min(max, kt)));
    return this.assignedSpeed;
  }

  // Mach assegnato (in quota): il volo lo mantiene anche cambiando livello, quindi la velocità vera segue la
  // temperatura. Restituisce il Mach applicato, limitato alle prestazioni del tipo alla quota attuale.
  setMach(mach) {
    if (this.noRadio) return null;
    const applied = this.setSpeed(mach * soundSpeedKt(this.altitude)) / soundSpeedKt(this.altitude);
    this.assignedMach = Math.round(applied * 100) / 100;
    return this.assignedMach;
  }

  resumeOwnSpeed() {
    if (this.noRadio) return;
    this.speedMode = 'own';
    this.assignedMach = null;
  }

  setFlightLevel(fl) {
    if (this.noRadio) return;
    this.instrSeq++;
    this.assignedAltitude = Math.max(50, Math.min(Math.max(this.type.maxFL, 250), fl)) * 100;
    this._slbWait = 3 + Math.random() * 4; // il pilota collaziona e poi imposta il nuovo livello
    this.assignedRateFpm = null; // una nuova autorizzazione di livello annulla il rateo assegnato
  }

  // Rateo di salita o discesa (ft/min) fino al livello autorizzato. Restituisce quello che il volo riesce a tenere.
  setVerticalRate(fpm) {
    if (this.noRadio) return null;
    this.instrSeq++;
    this.assignedRateFpm = fpm;
    return Math.round((this.effectiveRateFtS(this.assignedAltitude > this.altitude) * 60) / 100) * 100;
  }

  // Punto sorvolato: virata anticipata verso la tratta successiva (fly-by) oppure punto ormai
  // irraggiungibile senza girarci attorno, perché troppo vicino e di lato.
  _passedWaypoint(wp, rate) {
    const d = distance(this, wp);
    if (d < WAYPOINT_CAPTURE_NM) return true;
    const radius = this.speed / 3600 / ((rate * Math.PI) / 180);
    const next = this.route.length > 1 ? waypoint(this.route[1]) : null;
    if (next) {
      const turn = Math.abs(angleDiff(bearing(wp, next), bearing(this, wp)));
      const lead = Math.min(MAX_TURN_LEAD_NM, radius * Math.tan((turn * Math.PI) / 360));
      if (d < lead) return true;
    }
    return d < radius * 1.2 && Math.abs(angleDiff(bearing(this, wp), this.heading)) > 60;
  }

  _targetHeading() {
    if (this.mode === 'heading') return this.assignedHeading;
    if (this.route.length > 0) {
      const wp = waypoint(this.route[0]);
      if (wp) return bearing(this, wp);
    }
    return this.heading;
  }

  update(dt) {
    const rate = turnRate(this.speed);
    const targetHeading = this._targetHeading();
    let diff = angleDiff(targetHeading, this.heading);
    const maxTurn = rate * dt;
    if (this.mode === 'heading' && this.turnDirection) {
      if (Math.abs(diff) <= maxTurn) this.turnDirection = null;
      else if (this.turnDirection === 'right' && diff < 0) diff += 360;
      else if (this.turnDirection === 'left' && diff > 0) diff -= 360;
    }
    this.heading = normalizeDeg(this.heading + Math.max(-maxTurn, Math.min(maxTurn, diff)));

    if (this.speedMode === 'own') {
      this.assignedSpeed = scheduleSpeed(this.type, this.altitude, this.verticalPhase)
        * this.perf.speed * (this.emergency?.perf.speed ?? 1);
    } else if (this.assignedMach) {
      this.assignedSpeed = this.assignedMach * soundSpeedKt(this.altitude);
    }
    const speedDiff = this.assignedSpeed - this.speed;
    const maxAccel = ACCEL_KT_S * dt;
    this.speed += Math.max(-maxAccel, Math.min(maxAccel, speedDiff));

    const altDiff = this.assignedAltitude - this.altitude;
    const maxVert = this.effectiveRateFtS(altDiff > 0) * dt;
    const climb = Math.max(-maxVert, Math.min(maxVert, altDiff));
    this.altitude += climb;
    if (this.assignedRateFpm && Math.abs(this.assignedAltitude - this.altitude) < 1) this.assignedRateFpm = null;
    if (dt > 0) this.verticalFpm = (climb / dt) * 60;
    if (this._slbWait > 0) this._slbWait -= dt;
    else this.slbFL = Math.round(this.assignedAltitude / 1000) * 10;

    const nmPerSec = this.speed / 3600;
    const rad = (this.heading * Math.PI) / 180;
    this.x += Math.sin(rad) * nmPerSec * dt;
    this.y -= Math.cos(rad) * nmPerSec * dt;

    if (this.mode === 'route' && this.route.length > 0) {
      const wp = waypoint(this.route[0]);
      if (!wp || this._passedWaypoint(wp, rate)) this.route.shift();
    }

    this._trailTimer += dt;
    if (this._trailTimer >= HISTORY_S) {
      this._trailTimer -= HISTORY_S;
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > MAX_HISTORY) this.trail.shift();
    }
  }
}

// Il settore considera "nostri" per la separazione i traffici passati o in contatto,
// e quelli appena trasferiti finché restano nel nostro volume.
// Copia fuori dal settore lateralmente ma su una rientranza del confine, con l'uscita pianificata ancora davanti
// (la stessa regola di _updateControl): il volo resta nostro.
function ghostExcursion(g) {
  return g.mode === 'route' && g.exitS !== null && (g._along ?? g.alongTrackNm()) < g.exitS - EXCURSION_TOLERANCE_NM;
}

// Livello a cui l'ente precedente tiene il volo finché non ce lo passa (profilo fermato al livello coordinato).
function inboundAltitude(ac) {
  const profileFt = Math.round(profileAltitude(ac.profile, ac._along ?? ac.alongTrackNm()) / 100) * 100;
  return coordinatedAltitude(profileFt, ac.clamp, ac.entryFt);
}

// Livello del volo dopo il trasferimento. Uscita dall'alto: il settore superiore continua subito la salita
// verso il livello di crociera richiesto. Uscita dal basso: l'ente inferiore continua subito la discesa sotto il
// nostro limite e poi lungo il profilo. Uscita laterale: il livello coordinato resta finché il volo è nel nostro
// settore, poi l'ente successivo riprende il profilo senza invertire salite o discese.
function transferredAltitude(ac, profileFt, phase) {
  // volo dirottato per un'emergenza: l'ente successivo lo porta giù verso l'aeroporto scelto, non più
  // lungo il profilo del piano di volo originale
  if (ac.emergency?.divert) {
    const dest = waypoint(ac.destination);
    const glide = dest ? Math.max(1000, distance(ac, dest) * DIVERT_FT_NM) : profileFt;
    return Math.min(ac.assignedAltitude, glide);
  }
  if (ac.exitKind === 'top') {
    return phase === 'descent' ? Math.min(ac.assignedAltitude, profileFt) : Math.max(ac.assignedAltitude, ac.profile.cruiseFt);
  }
  if (ac.exitKind === 'bottom') return Math.min(ac.assignedAltitude, profileFt, airspace.floorFt - TRANSFER_BELOW_FT);
  // passato all'avvicinamento sul punto iniziale della STAR: scende lungo la STAR secondo il profilo
  if (ac.exitKind === 'star') return Math.min(ac.assignedAltitude, profileFt);
  if (insideLateral(ac)) return ac.assignedAltitude;
  if (phase === 'climb') return Math.max(ac.assignedAltitude, profileFt);
  if (phase === 'descent') return Math.min(ac.assignedAltitude, profileFt);
  return profileFt;
}

// Avanzamento di una copia per le previsioni: gli enti non di competenza seguono il profilo pianificato,
// quello precedente trattiene il volo al livello coordinato, i voli in contatto mantengono l'autorizzazione.
function stepGhost(g, dt) {
  // distanza lungo il piano aggiornata in modo incrementale (più rapido che ricalcolarla dalla rotta)
  g._along = g._along === undefined ? g.alongTrackNm() : g._along + (g.speed * dt) / 3600;
  const nearBand = g.altitude >= airspace.floorFt - 3000 && g.altitude < airspace.ceilingFt + 3000;
  // uscita dall'alto o dal basso: il controllore passa il volo all'ente successivo quando arriva all'XFL
  if (g.xflMode && g.control === 'assumed' && g.verticalExit && Math.abs(g.altitude - g.requestedExitFL * 100) < 300) {
    g.control = 'transferred';
  }
  // uscita sul punto iniziale della STAR: passato all'avvicinamento quando ci arriva
  if (g.control === 'assumed' && g.exitKind === 'star' && !g.route.includes(g.exitFix)) g.control = 'transferred';
  if (g.xflMode && (g.control === 'assumed' || (OURS.has(g.control) && nearBand && insideLateral(g)))) {
    // ipotesi per i conflitti al livello d'uscita: il controllore autorizza il volo all'XFL appena lo assume
    g.assignedAltitude = g.requestedExitFL * 100;
  } else if (g.control === 'inbound' || g.control === 'offered') {
    g.assignedAltitude = inboundAltitude(g);
  } else if (g.control === 'other') {
    g.assignedAltitude = Math.round(profileAltitude(g.profile, g._along) / 100) * 100;
  } else if (g.control === 'transferred' && g.mode === 'route') {
    const profileFt = Math.round(profileAltitude(g.profile, g._along) / 100) * 100;
    g.assignedAltitude = transferredAltitude(g, profileFt, profilePhase(g.profile, g._along));
  }
  g.update(dt);
}

// Traiettoria di una copia campionata ogni CONFLICT_STEP_S secondi: x, y e quota per ogni campione.
function sampleTrajectory(ghost, durationS) {
  const n = Math.floor(durationS / CONFLICT_STEP_S) + 1;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (i > 0) stepGhost(ghost, CONFLICT_STEP_S);
    out[i * 3] = ghost.x;
    out[i * 3 + 1] = ghost.y;
    out[i * 3 + 2] = ghost.altitude;
  }
  return out;
}

// Tratti della traiettoria dentro il settore (più un campione prima e dopo), ogni 20 s, per gli incroci.
function pathInside(track) {
  const every = 4;
  const n = track.length / 3;
  const path = [];
  let prevIdx = -Infinity;
  for (let i = 0; i < n; i += every) {
    const p = { x: track[i * 3], y: track[i * 3 + 1] };
    const near = [i - every, i, i + every].some((k) => k >= 0 && k < n && insideLateral({ x: track[k * 3], y: track[k * 3 + 1] }));
    if (!near) continue;
    path.push({ ...p, t: i * CONFLICT_STEP_S, alt: track[i * 3 + 2], gap: i - prevIdx > every });
    prevIdx = i;
  }
  return path;
}

// Ritardo di comparsa (vicino alla stima geometrica) con cui il volo pianificato perde la separazione con la
// traiettoria del bersaglio dentro il settore, dopo un tempo di reazione compreso in reactionS dall'ultima offerta.
function scanConflict(plan, track, delayS, { xflI, targetOffer, refFt, reactionS }) {
  const [lo, hi] = reactionS;
  const offerIn = plan.entryInS - OFFER_LEAD_S;
  const ghost = new Aircraft(plan);
  ghost.xflMode = xflI;
  const own = sampleTrajectory(ghost, offerIn + hi + 60);
  const nT = track.length / 3;
  const nI = own.length / 3;
  const k0 = Math.max(0, Math.round((delayS - CONFLICT_SCAN_S) / CONFLICT_STEP_S));
  const k1 = Math.min(MAX_CONFLICT_DELAY_S, delayS + CONFLICT_SCAN_S) / CONFLICT_STEP_S;
  for (let k = k0; k <= k1; k++) {
    let i = 0;
    for (; i < nI && i + k < nT; i++) {
      const a = (i + k) * 3;
      const b = i * 3;
      if (Math.abs(track[a + 2] - own[b + 2]) < SEP_VERTICAL_FT
        && Math.hypot(track[a] - own[b], track[a + 1] - own[b + 1]) < SEP_HORIZONTAL_NM) break;
    }
    if (i >= nI || i + k >= nT) continue;
    const j = (i + k) * 3;
    const reaction = (i + k) * CONFLICT_STEP_S - Math.max(k * CONFLICT_STEP_S + offerIn, targetOffer);
    if (reaction < lo || reaction > hi) continue;
    const alt = track[j + 2];
    if (alt < airspace.floorFt - SEP_VERTICAL_FT || alt >= airspace.ceilingFt + SEP_VERTICAL_FT) continue;
    if (!insideLateral({ x: track[j], y: track[j + 1] })) continue;
    const targetMoved = Math.abs(alt - refFt) >= MOVED_FT;
    const intruderMoved = Math.abs(own[i * 3 + 2] - plan.entryFt) >= MOVED_FT;
    const kind = targetMoved && intruderMoved ? 'both' : targetMoved ? 'target' : intruderMoved ? 'intruder' : 'level';
    return { delayS: k * CONFLICT_STEP_S, kind };
  }
  return null;
}

export function isConcerned(ac) {
  return ac.control === 'offered' || ac.control === 'assumed' || (ac.control === 'transferred' && insideVolume(ac));
}

export class Simulation {
  // settings: scelte del menu. difficulty: 'facile' | 'media' | 'difficile' (volume di traffico e velocità con
  // cui il settore si riempie); weather: { storms, turbulence, intensity 0-1 }; emergencyPct: percentuale dei
  // voli nostri che dichiarano un'emergenza. Senza, i valori tipici del settore.
  constructor(settings = {}) {
    const key = settings.difficulty ?? airspace.sector.difficulty;
    this.settings = {
      difficulty: key,
      weather: { ...WEATHER_DEFAULT, ...settings.weather },
      emergencyPct: settings.emergencyPct ?? EMERGENCY_PCT_DEFAULT,
    };
    this.aircraft = [];
    this.simTime = 0;
    this.sector = airspace.sector;
    this.difficulty = DIFFICULTY[key];
    this.demand = sectorDemand(airspace.sector, key);   // offerte orarie di nostra competenza, a regime
    this.maxOther = Math.min(24, Math.round(8 + this.demand * 0.22)); // traffico dei settori attorno al nostro
    // onde di traffico: la domanda oscilla lentamente fra fasi di picco e fasi più calme
    this._wavePeriod = 1200 + Math.random() * 1500;
    // l'onda parte dalla domanda media: il settore è a regime fin dall'inizio, né in un picco né in una fase calma
    this._wavePhase = Math.random() < 0.5 ? 0 : Math.PI;
    this._otherTimer = 15 + Math.random() * 30;
    this._planTimer = 0;
    this._nextOfferAt = 0;
    // i conflitti programmati cominciano quando al settore arriva il flusso normale (vedi seedInitialTraffic)
    this._conflictAt = Infinity;
    this._warmupUntil = 0;
    this._handoffLeadS = 60;   // anticipo medio dell'hand-off rispetto all'uscita dal settore, appreso in partita
    this._loadBias = 0;        // correzione dell'obiettivo di carico sul carico vero (vedi _balanceTick)
    this._balanceAt = null;
    this._conflictRetryAt = 0;
    this.timeMultiplier = 1;
    this.paused = false;
    // modalita' guidata (tutorial): il traffico non viene generato da solo, lo decide la lezione.
    // Resta tutto il resto: profili, coordinamento, allarmi, zone e meteo.
    this.scripted = !!settings.scripted;

    this.strikes = [];       // errori di coordinamento: {callsign, reason}
    this.stats = { handedOff: 0, assumed: 0 };
    this.gameOver = null;    // {reason, detail}
    this.stca = [];          // coppie in allarme: {a, b, timeToConflict}
    this._stcaKeys = new Set();
    this.schedule = [];         // voli nostri programmati: {plan, spawnAt, offerAt, waitS}
    this.pendingConflicts = []; // voli in conflitto programmati: {plan, spawnAt, offerAt}
    this.listeners = { event: [], gameover: [] };

    // messaggi radio mostrati in alto sul radar: le richieste delle emergenze restano finché il volo è nostro
    this.messages = [];
    this._msgId = 0;
    this.emergencies = 0;
    // intervallo medio fra due emergenze: la percentuale scelta dei voli che ci vengono offerti ogni ora
    const perHour = (this.settings.emergencyPct / 100) * this.demand;
    this._emergencyMeanS = perHour > 0 ? 3600 / perHour : Infinity;
    this._emergencyAt = perHour > 0
      ? Math.max(EMERGENCY_FIRST_MIN_S, this._emergencyMeanS * (0.25 + Math.random() * 0.35))
      : Infinity;

    // meteo scelto nel menu e richieste dei piloti
    this.weather = makeWeather(airspace.view, {
      ...this.settings.weather,
      band: [airspace.sector.floorFL, airspace.sector.ceilingFL],
    });
    this.requests = { level: 0, turb: 0, deviation: 0, own: 0 };
    this._levelAt = LEVEL_FIRST_S[0] + Math.random() * (LEVEL_FIRST_S[1] - LEVEL_FIRST_S[0]);
    this._wxTimer = 0;

    // orologio UTC della sessione e piano di attivazione delle zone
    this.clockStartS = Math.round((CLOCK_START_S[0] + Math.random() * (CLOCK_START_S[1] - CLOCK_START_S[0])) / 60) * 60;
    const sectorInfo = { polygon: airspace.polygon, floorFt: airspace.floorFt, ceilingFt: airspace.ceilingFt };
    this.areaSchedule = makeAreaSchedule(airspace.areas, sectorInfo, this.clockStartS);
    this.relevantAreas = new Set(airspace.areas.filter((a) => isAreaRelevant(a, sectorInfo)).map((a) => a.id));
    for (const a of airspace.areas) {
      a.active = isActiveAt(this.areaSchedule, a, this.clockStartS);
      a.alarm = false;
    }
    this._areaTimer = 0;
    this._apwKeys = new Set();
    this._areaBudget = 1; // voli pianificati attraverso una zona attiva che si possono ancora far comparire
  }

  // Ora UTC corrente (secondi dalla mezzanotte, senza riportarla a 0 dopo le 24).
  get clockS() {
    return this.clockStartS + this.simTime;
  }

  on(type, fn) {
    this.listeners[type].push(fn);
  }

  _emit(type, payload) {
    for (const fn of this.listeners[type]) fn(payload);
  }

  _wave(t) {
    return 1 + this.difficulty.waveAmp * Math.sin((2 * Math.PI * t) / this._wavePeriod + this._wavePhase);
  }

  // Intervallo medio fra due offerte all'istante t.
  _meanGap(t) {
    return 3600 / (this.demand * this._wave(t));
  }

  // Traffico di contesto: arrivi casuali modulati dall'onda di traffico.
  _nextDelay(perHour) {
    const mean = 3600 / (perHour * this._wave(this.simTime));
    return Math.max(12, mean * gammaUnit(2));
  }

  // Spaziatura alla comparsa e nessuna perdita di separazione prevista entro horizonS secondi, simulando
  // tutti gli aerei lungo le loro rotte e i loro profili (senza interventi del controllore). Due ipotesi:
  // nessuno cambia livello, oppure ogni volo nostro viene autorizzato subito al suo livello d'uscita. Così
  // anche i conflitti che nascono da salite e discese lasciano almeno il tempo minimo di reazione.
  _isClear(ac, horizonS, ignoreId = null) {
    const horizon = Math.min(PREDICT_MAX_S, horizonS);
    const near = [];
    for (const other of this.aircraft) {
      if (other.id === ignoreId) continue;
      const h = distance(ac, other);
      if (h < SPAWN_SPACING_NM && Math.abs(ac.altitude - other.altitude) < 3000) return false;
      if (h < ((ac.speed + other.speed) * horizon) / 3600 + SEP_HORIZONTAL_NM) near.push(other);
    }
    if (!near.length) return true;
    return this._clearPath(ac, near, horizon, false) && this._clearPath(ac, near, horizon, true);
  }

  _clearPath(ac, near, horizon, xfl) {
    const g = ac.ghost();
    g.xflMode = xfl;
    const others = near.map((o) => Object.assign(o.ghost(), { xflMode: xfl }));
    for (let t = PREDICT_STEP_S; t <= horizon; t += PREDICT_STEP_S) {
      stepGhost(g, PREDICT_STEP_S);
      for (const o of others) {
        stepGhost(o, PREDICT_STEP_S);
        // margine orizzontale per il passo di campionamento
        if (Math.abs(g.altitude - o.altitude) < SEP_VERTICAL_FT && distance(g, o) < SEP_HORIZONTAL_NM + 2) return false;
      }
    }
    return true;
  }

  // Orizzonte di verifica per un volo nostro: fino a qualche minuto dopo che ci viene offerto.
  _oursHorizon(plan) {
    return Math.max(0, (plan.entryInS ?? 0) - OFFER_LEAD_S) + this.difficulty.reactionS[0];
  }

  _commit(ac, plan = null) {
    const active = new Set(this.aircraft.map((a) => a.callsign));
    let cs;
    do cs = generateCallsign(ac.origin, ac.destination); while (active.has(cs.callsign));
    ac.callsign = cs.callsign;
    ac.spoken = cs.spoken;
    ac.flow.lastSpawn = this.simTime;
    if (plan?.departureFrom) plan.departureFrom.lastDeparture = this.simTime;
    this.aircraft.push(ac);
    return ac;
  }

  // Spaziatura sul flusso e, per le partenze, fra decolli successivi dallo stesso aeroporto.
  _slotFree(plan) {
    if (this.simTime - plan.flow.lastSpawn < IN_TRAIL_S) return false;
    const airport = plan.departureFrom;
    return !airport || this.simTime - (airport.lastDeparture ?? -Infinity) >= DEPARTURE_INTERVAL_S;
  }

  // La stessa spaziatura verificata in anticipo, anche rispetto ai voli già programmati.
  _scheduleFree(plan, spawnAt) {
    if (spawnAt - plan.flow.lastSpawn < IN_TRAIL_S) return false;
    const airport = plan.departureFrom;
    if (airport && spawnAt - (airport.lastDeparture ?? -Infinity) < DEPARTURE_INTERVAL_S) return false;
    return [...this.schedule, ...this.pendingConflicts].every((e) => {
      const dt = Math.abs(e.spawnAt - spawnAt);
      if (e.plan.flow === plan.flow && dt < IN_TRAIL_S) return false;
      return !(airport && e.plan.departureFrom === airport && dt < DEPARTURE_INTERVAL_S);
    });
  }

  // Comparsa immediata di un volo nostro se la spaziatura lo consente e non ha conflitti troppo ravvicinati.
  _trySpawnOurs(plan, ignoreId = null) {
    if (!this._slotFree(plan)) return null;
    const ac = new Aircraft(plan);
    if (!this._isClear(ac, this._oursHorizon(plan), ignoreId)) return null;
    if (!this._areaAllowed(ac, plan, true)) {
      plan.areaBlocked = true; // la rotta non cambia aspettando: il posto va a un altro volo
      return null;
    }
    return this._commit(ac, plan);
  }

  // --- programmazione del traffico nostro --------------------------------------
  // La domanda del settore è definita all'offerta, quando l'ente precedente ci passa il volo: le offerte
  // seguono intervalli regolari attorno alla media, modulata dall'onda di traffico. Ogni volo sceglie flusso,
  // tipo e livello con le probabilità normali; la comparsa al bordo del radar (o il decollo) viene ritardata
  // quanto serve perché l'offerta cada nel suo slot. Così non ci sono lunghi tempi morti e il mix dei flussi
  // resta quello reale, senza favorire i voli più vicini o più lontani.

  // starting: prima programmazione della sessione, quando nessun volo è ancora in viaggio.
  _planTraffic(starting = false) {
    for (let guard = 0; guard < 80 && this._nextOfferAt <= this.simTime + PLAN_AHEAD_S; guard++) {
      if (!this._fillSlot(this._nextOfferAt, starting) && !starting) {
        // nessun volo adatto: si riprova al prossimo giro, senza accumulare slot arretrati
        this._nextOfferAt = Math.max(this._nextOfferAt, this.simTime + 30);
        return;
      }
      this._nextOfferAt += this._offerGap(this._nextOfferAt);
    }
  }

  // Intervallo fino all'offerta successiva: irregolare attorno alla media e a volte molto breve, quando
  // l'ente precedente ci passa due voli quasi insieme. La media resta quella della domanda.
  _offerGap(t) {
    const mean = this._meanGap(t);
    const { bunching } = this.difficulty;
    const bunchMean = (BUNCH_S[0] + BUNCH_S[1]) / 2;
    if (Math.random() < bunching) return BUNCH_S[0] + Math.random() * (BUNCH_S[1] - BUNCH_S[0]);
    const rest = Math.max(mean * 0.5, (mean - bunching * bunchMean) / (1 - bunching));
    return rest * clamp(gammaUnit(GAP_SHAPE), ...GAP_RANGE);
  }

  // Un volo la cui offerta cade all'istante offerAt. A inizio sessione (starting) un volo che dal bordo del radar
  // non farebbe in tempo compare già in viaggio lungo il suo flusso, ancora fuori dal settore e non in contatto:
  // così anche i settori con passaggi lunghi cominciano a riempirsi subito, con i tempi della rampa.
  _fillSlot(offerAt, starting = false) {
    const slotIn = offerAt - this.simTime;
    let late = null;
    // i voli scartati perché pianificati attraverso una zona attiva non contano fra i tentativi: il posto va a un
    // flusso che la evita, come fanno le compagnie con il piano delle zone
    let areaRejects = 0;
    let overBudget = null; // primo volo scartato solo per il budget: se non c'è altro, arriva lo stesso
    const early = [];      // a inizio sessione: voli che dal bordo del radar non farebbero in tempo
    for (let attempt = 0; attempt < 12 + Math.min(areaRejects, 30); attempt++) {
      const plan = makeOursPlan({ evolvingBias: this.difficulty.evolvingBias });
      if (!plan) continue;
      const offerIn = plan.entryInS - OFFER_LEAD_S;
      if (offerIn <= slotIn) {
        const spawnAt = offerAt - offerIn;
        if (!this._scheduleFree(plan, spawnAt)) continue;
        if (!this._areaAllowed(new Aircraft(plan), plan, true, spawnAt - this.simTime)) {
          areaRejects++;
          if (this._areaReject === 'budget' && !overBudget) overBudget = { plan, spawnAt };
          continue;
        }
        this.schedule.push({ plan, spawnAt, offerAt, waitS: 0 });
        return true;
      }
      if (starting) {
        if (early.length < 4) early.push(plan);
      } else if (slotIn < LATE_SLOT_S && (!late || offerIn < late.entryInS - OFFER_LEAD_S)
        && this._scheduleFree(plan, this.simTime)) {
        late = plan;
      }
    }
    // solo se nessun volo arriva in tempo dal bordo del radar: uno già in viaggio lungo il flusso
    for (const plan of early) {
      const advanced = advancePlan(plan, Math.max(0, slotIn));
      if (advanced && this._trySpawnOurs(advanced)) return true;
    }
    if (late && !this._areaAllowed(new Aircraft(late), late, true)) late = null;
    // nessun flusso libero dalle zone attive: il traffico arriva comunque e va vettorato attorno
    if (!late && overBudget && this._areaBudget > -2
      && this._areaAllowed(new Aircraft(overBudget.plan), overBudget.plan, true, overBudget.spawnAt - this.simTime, true)) {
      this.schedule.push({ plan: overBudget.plan, spawnAt: overBudget.spawnAt, offerAt, waitS: 0 });
      return true;
    }
    if (!late) return false;
    this.schedule.push({ plan: late, spawnAt: this.simTime, offerAt: this.simTime + late.entryInS - OFFER_LEAD_S, waitS: 0 });
    return true;
  }

  _spawnScheduled() {
    if (!this.schedule.some((e) => e.spawnAt <= this.simTime)) return;
    const keep = [];
    const lost = [];
    const balancing = this.simTime >= this._warmupUntil;
    for (const e of this.schedule) {
      const offerIn = e.offerAt - this.simTime;
      if (e.spawnAt > this.simTime) keep.push(e);
      // settore già carico per quando il volo ci verrebbe offerto: l'ente precedente lo trattiene
      else if (balancing && offerIn <= BALANCE_HOLD_MAX_S
        && this._predictLoad(offerIn) - 1 > this.difficulty.load + this._loadBias + BALANCE_HIGH) continue;
      else if (this._trySpawnOurs(e.plan)) continue;
      else if (e.waitS < SPAWN_MAX_WAIT_S && !e.plan.areaBlocked) keep.push({ ...e, spawnAt: e.spawnAt + SPAWN_RETRY_S, waitS: e.waitS + SPAWN_RETRY_S });
      else lost.push(e);
    }
    this.schedule = keep;
    // il volo non è potuto comparire: al suo posto un altro volo con un'offerta il più vicino possibile
    for (const e of lost) this._fillSlot(Math.max(e.offerAt, this.simTime + 60));
  }

  // --- conflitti programmati ---------------------------------------------------
  // Un volo che l'ente adiacente ci consegna in conflitto con un traffico nostro. I tipi dipendono dalla
  // difficoltà: level (entrambi livellati allo stesso livello), target (il nostro traffico sale o scende al
  // livello d'uscita e incontra il nuovo volo), intruder (il nuovo volo sale o scende verso il suo livello
  // d'uscita attraverso il nostro traffico), both (salita contro discesa). Le salite e le discese seguono
  // l'autorizzazione più ovvia, quella al livello d'uscita: il conflitto va visto prima di darla.

  _conflictTick() {
    const { conflictsPerHour, maxPendingConflicts } = this.difficulty;
    if (this.simTime < this._conflictAt || this.simTime < this._conflictRetryAt
      || this.pendingConflicts.length >= maxPendingConflicts) return;
    const pending = this._planConflict();
    if (!pending) {
      // si riprova presto; l'appuntamento del conflitto successivo non slitta
      this._conflictRetryAt = this.simTime + CONFLICT_RETRY_S;
      return;
    }
    this.pendingConflicts.push(pending);
    this._dropScheduledNear(pending.offerAt);
    const due = Math.max(this._conflictAt, this.simTime - CONFLICT_CATCHUP_S);
    this._conflictAt = due + (3600 / conflictsPerHour) * clamp(gammaUnit(2), 0.35, 2.2);
  }

  // Il volo in conflitto prende il posto del volo programmato con l'offerta più vicina: la domanda resta quella.
  _dropScheduledNear(offerAt) {
    let best = -1;
    let bestD = this._meanGap(offerAt);
    this.schedule.forEach((e, i) => {
      const d = Math.abs(e.offerAt - offerAt);
      if (e.spawnAt > this.simTime && d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best >= 0) this.schedule.splice(best, 1);
  }

  _planConflict() {
    const { reactionS, conflictMix } = this.difficulty;
    const wanted = weightedKey(conflictMix);
    const deadline = performance.now() + CONFLICT_BUDGET_MS;
    const busy = new Set(this.pendingConflicts.map((p) => p.plan.conflictTargetId));
    const targets = shuffle(this.aircraft.filter((a) => a.requestedExitFL !== null && a.mode === 'route' && !busy.has(a.id)
      && (a.control === 'assumed' || a.control === 'offered' || a.control === 'inbound'))).slice(0, 4);
    let fallback = null;

    for (const target of targets) {
      const targetOffer = target.control === 'inbound'
        ? Math.max(0, profileTime(target.profile, target.alongTrackNm(), target.entryS) - OFFER_LEAD_S)
        : 0;
      const refFt = target.control === 'assumed' ? target.altitude : target.entryFt;
      const modes = Math.abs(target.requestedExitFL * 100 - refFt) >= MOVED_FT ? shuffle([true, false]) : [false];
      for (const xfl of modes) {
        if (performance.now() > deadline) return fallback;
        const tg = target.ghost();
        tg.xflMode = xfl;
        const track = sampleTrajectory(tg, CONFLICT_HORIZON_S);
        const path = pathInside(track);
        if (path.length < 2) continue;
        for (const { plan, delayS } of conflictCandidates(path, MAX_CONFLICT_DELAY_S, deadline)) {
          if (performance.now() > deadline) return fallback;
          const intruderModes = plan.entryFt !== plan.requestedExitFL * 100 ? shuffle([true, false]) : [false];
          for (const xflI of intruderModes) {
            if (performance.now() > deadline) return fallback;
            const option = scanConflict(plan, track, delayS, { xflI, targetOffer, refFt, reactionS });
            if (!option) continue;
            const spawnAt = this.simTime + option.delayS;
            if (!this._scheduleFree(plan, spawnAt)) continue;
            const pending = {
              plan: {
                ...plan, conflictTargetId: target.id, conflictXfl: xfl, conflictXflIntruder: xflI,
                conflictKind: option.kind, spawnDelayS: option.delayS,
              },
              spawnAt,
              offerAt: spawnAt + plan.entryInS - OFFER_LEAD_S,
            };
            if (option.kind === wanted) return pending;
            if (conflictMix[option.kind] > 0) fallback ??= pending;
          }
        }
      }
    }
    return fallback;
  }

  // Due soli aerei simulati a passi di 5 s, con i vincoli di livello dell'ente precedente:
  // verifica che il conflitto programmato avvenga davvero.
  _plannedConflictTime(ac, target, horizon) {
    const a = ac.ghost();
    const b = target.ghost();
    for (let t = 5; t <= horizon; t += 5) {
      stepGhost(a, 5);
      stepGhost(b, 5);
      if (distance(a, b) < SEP_HORIZONTAL_NM && Math.abs(a.altitude - b.altitude) < SEP_VERTICAL_FT) return t;
    }
    return null;
  }

  // Tempo fra l'ultima delle due offerte (volo in conflitto e bersaglio) e la perdita di separazione,
  // se il conflitto programmato avviene davvero e rispetta la difficoltà; delayS: fra quanto il volo comparirà.
  _conflictReaction(plan, target, delayS) {
    const tg = target.ghost();
    tg.xflMode = !!plan.conflictXfl;
    for (let t = 0; t < delayS; t += 5) stepGhost(tg, Math.min(5, delayS - t));
    const ac = new Aircraft(plan);
    ac.xflMode = !!plan.conflictXflIntruder;
    const t = this._plannedConflictTime(ac, tg, 1800);
    if (t === null) return null;
    const intruderOffer = delayS + plan.entryInS - OFFER_LEAD_S;
    const targetOffer = target.control === 'inbound'
      ? profileTime(target.profile, target.alongTrackNm(), target.entryS) - OFFER_LEAD_S
      : 0;
    const reaction = delayS + t - Math.max(intruderOffer, targetOffer);
    const [lo, hi] = this.difficulty.reactionS;
    return reaction >= lo - 60 && reaction <= hi + 120 ? reaction : null;
  }

  _spawnPendingConflicts() {
    if (!this.pendingConflicts.some((p) => this.simTime >= p.spawnAt)) return;
    const due = this.pendingConflicts.filter((p) => this.simTime >= p.spawnAt);
    this.pendingConflicts = this.pendingConflicts.filter((p) => this.simTime < p.spawnAt);
    for (const { plan, offerAt } of due) {
      const target = this.aircraft.find((a) => a.id === plan.conflictTargetId && OURS.has(a.control));
      if (target && this._slotFree(plan) && this._conflictReaction(plan, target, 0) !== null) {
        const ac = new Aircraft(plan);
        if (this._isClear(ac, this._oursHorizon(plan), target.id) && this._areaAllowed(ac, plan, true)) {
          ac.plannedConflict = { targetId: target.id, kind: plan.conflictKind };
          this._commit(ac, plan);
          continue;
        }
      }
      // il bersaglio ha già cambiato rotta o livello: il volo arriva come traffico normale, o ne arriva un altro
      if (!this._trySpawnOurs(plan)) this._fillSlot(Math.max(offerAt, this.simTime + 60));
    }
  }

  spawnOther(midway = false) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const plan = makeOtherPlan({ midway });
      if (!plan || !this._slotFree(plan)) continue;
      const ac = new Aircraft(plan);
      if (this._isClear(ac, 300) && this._areaAllowed(ac, plan, false)) return this._commit(ac, plan);
    }
    return null;
  }

  // Inizio sessione: il nostro settore è vuoto, quelli attorno no. Il traffico di contesto è già in volo su tutto
  // il radar fuori dal settore; tanti voli nostri quanti ne prevede la difficoltà sono appena fuori dal confine:
  // alcuni già in contatto (verdi), gli altri ci vengono offerti a poca distanza l'uno dall'altro entro
  // difficulty.fillS secondi. Da lì le offerte seguono la domanda normale: gli altri voli compaiono al bordo del radar o
  // decollano man mano.
  seedInitialTraffic() {
    const { load, fillS, evolvingBias } = this.difficulty;
    const others = Math.round(this.maxOther * SEED_OTHER_SHARE);
    for (let i = 0, placed = 0; i < others * 4 && placed < others; i++) {
      if (this.spawnOther(true)) placed++;
    }
    const count = Math.max(2, Math.round(load));
    // alcuni sono già in contatto (hand-on fatto dall'ente precedente): verdi, a pochi NM dal confine
    const assumed = Math.max(1, Math.round(count * SEED_ASSUMED_SHARE));
    // nessuno dei voli iniziali è pianificato attraverso una zona attiva: a inizio sessione il controllore sta
    // ancora prendendo le misure del settore
    const areaBudget = this._areaBudget;
    this._areaBudget = 0;
    for (let i = 0; i < count; i++) {
      const offerIn = i < assumed
        ? Math.random() * SEED_ASSUMED_MAX_S
        : SEED_FIRST_OFFER_S + ((i - assumed + Math.random() * 0.8) / (count - assumed)) * (fillS - SEED_FIRST_OFFER_S);
      for (let attempt = 0; attempt < 30; attempt++) {
        const plan = makeOursPlan({ evolvingBias });
        // quelli già in contatto entrano di lato, al livello coordinato dentro la fascia del settore: nessuna
        // salita o discesa da dare subito perché entrino
        if (i < assumed && attempt < 25 && plan?.entryKind !== 'lateral') continue;
        const near = plan && advancePlan(plan, offerIn);
        const ac = near && this._trySpawnOurs(near);
        if (!ac) continue;
        // un passaggio breve resta giallo: il controllore non deve trovarsi da passare subito un volo mai visto
        if (i < assumed && this._timeToExit(ac) >= SEED_ASSUMED_MIN_STAY_S) {
          ac.control = 'offered';
          ac.offeredAt = this.simTime;
          this.handOn(ac);
        }
        break;
      }
    }
    this._areaBudget = areaBudget;
    // le offerte normali cominciano quando i voli iniziali cominciano a uscire (dopo il tempo medio di passaggio):
    // prendono il loro posto e il carico resta quello di regime, senza cali né picchi
    const transitS = airspace.sector.transitMin * 60;
    const handover = Math.max(fillS, transitS * STREAM_START_SHARE);
    this._nextOfferAt = this.simTime + handover + Math.random() * this._meanGap(handover);
    this._warmupUntil = this.simTime + handover + transitS;
    this._conflictAt = this.simTime + handover + 60 + Math.random() * 120;
    this._planTraffic(true);
  }

  // Primi minuti: finché il flusso normale non è a regime, il carico non deve calare anche se qualche volo
  // iniziale esce prima del tempo medio di passaggio. Se i voli offerti e in contatto, più quelli che ci
  // verranno offerti a breve, sono meno del carico della difficoltà, ne arriva un altro appena fuori dal settore.
  _warmupTick() {
    if (this.simTime > this._warmupUntil) return;
    const soonS = WARMUP_SOON_S;
    const now = this.aircraft.filter((a) => a.control === 'offered' || a.control === 'assumed').length;
    const inbound = this.aircraft.filter((a) => a.control === 'inbound' && a.entryS !== null
      && ((a.entryS - a.alongTrackNm()) / Math.max(a.speed, 1)) * 3600 - OFFER_LEAD_S < soonS).length;
    const scheduled = [...this.schedule, ...this.pendingConflicts].filter((e) => e.offerAt - this.simTime < soonS).length;
    if (now + inbound + scheduled >= Math.round(this.difficulty.load)) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      const plan = makeOursPlan({ evolvingBias: this.difficulty.evolvingBias });
      const near = plan && advancePlan(plan, 45 + Math.random() * 60);
      if (near && this._trySpawnOurs(near)) return;
    }
  }

  // Voli offerti o in contatto fra h secondi, secondo la situazione di adesso: quelli nostri che non avranno
  // ancora lasciato il settore, quelli in arrivo o programmati che saranno già stati offerti e non ancora usciti.
  _predictLoad(h) {
    // chi passa i voli presto li tiene in contatto meno a lungo: se ne tiene conto con l'anticipo medio osservato
    const lead = this._handoffLeadS;
    const transitS = Math.max(120, airspace.sector.transitMin * 60 - lead);
    // un volo non ancora offerto: in contatto dall'offerta fino all'uscita pianificata (meno l'anticipo medio,
    // per le uscite laterali)
    const stays = (offerIn, plan) => {
      if (offerIn >= h) return false;
      let contact = transitS;
      if (plan?.profile && plan.entryS != null && plan.exitS != null) {
        contact = OFFER_LEAD_S + profileTime(plan.profile, plan.entryS, plan.exitS)
          - (plan.exitKind === 'lateral' ? lead : 0);
      }
      return offerIn + Math.max(60, contact) > h;
    };
    let n = 0;
    for (const a of this.aircraft) {
      if (a.control === 'offered' || a.control === 'assumed') {
        if (this._leaveIn(a, lead, transitS) > h) n++;
      } else if (a.control === 'inbound' && a.entryS !== null) {
        if (stays(((a.entryS - a.alongTrackNm()) / Math.max(a.speed, 1)) * 3600 - OFFER_LEAD_S, a)) n++;
      }
    }
    for (const e of this.schedule) if (stays(e.offerAt - this.simTime, e.plan)) n++;
    for (const e of this.pendingConflicts) if (stays(e.offerAt - this.simTime, e.plan)) n++;
    return n;
  }

  // Fra quanto il volo nostro lascerà la frequenza. Uscita laterale: al punto d'uscita, meno l'anticipo medio
  // con cui il controllore passa i voli. Uscita dall'alto o dal basso: quando raggiunge il livello d'uscita, se
  // è già autorizzato; altrimenti non si sa, metà del passaggio medio. Su prua: metà del passaggio medio.
  _leaveIn(ac, lead, transitS) {
    if (ac.mode !== 'route') return transitS * 0.75;
    const toExit = this._timeToExit(ac);
    if (!Number.isFinite(toExit)) return 0; // oltre il punto d'uscita: sta per essere passato
    if (!ac.verticalExit) return toExit - lead;
    // salita o discesa fino al livello d'uscita, più il tempo per autorizzarla se non è ancora stata data
    const ft = Math.abs(ac.altitude - ac.requestedExitFL * 100);
    const rate = ac.altitude < ac.requestedExitFL * 100 ? ac.climbFtS : ac.descentFtS;
    const wait = ac.clearedFL === ac.requestedExitFL ? 0 : CLEARANCE_DELAY_S;
    return Math.min(toExit, wait + ft / Math.max(rate, 1));
  }

  // Carico costante durante tutta la sessione, qualunque sia il ritmo con cui il controllore passa i voli: se fra
  // qualche minuto i voli nostri saranno meno del carico della difficoltà, ne arriva uno in più per quell'istante
  // (dal bordo del radar o in decollo, come gli altri).
  _balanceTick() {
    if (this.simTime < this._warmupUntil) return; // all'avvio ci pensa _warmupTick
    // correzione lenta sul carico vero: se per qualche minuto i voli in contatto restano sotto (o sopra) quelli
    // della difficoltà, la previsione ha un errore sistematico (dipende da come gioca il controllore) e si alza
    // (o abbassa) l'obiettivo interno finché il carico torna quello giusto
    const actual = this.aircraft.filter((a) => a.control === 'offered' || a.control === 'assumed').length;
    const dt = this.simTime - (this._balanceAt ?? this.simTime);
    this._balanceAt = this.simTime;
    this._loadBias = clamp(this._loadBias + BALANCE_GAIN * (this.difficulty.load - actual) * dt, ...BALANCE_BIAS);
    const target = this.difficulty.load + this._loadBias;
    for (const h of BALANCE_HORIZONS_S) {
      // se nessun volo fa in tempo per quell'istante, si prova con il successivo
      if (this._predictLoad(h) < target && this._fillSlot(this.simTime + h)) return;
    }
  }

  // --- azioni del controllore ------------------------------------------------

  handOn(ac) {
    if (this.gameOver || ac.control !== 'offered') return false;
    ac.control = 'assumed';
    ac.wasAssumed = true;
    ac.assumedAt = this.simTime;
    ac.assignedAltitude = ac.entryFt ?? ac.assignedAltitude; // livello coordinato dall'ente precedente
    this.stats.assumed++;
    ac.lastInstruction = 'Hand-on: in contatto';
    this._emit('event', { type: 'handon', ac });
    return true;
  }

  handOff(ac, { missed = false } = {}) {
    if (this.gameOver || ac.control !== 'assumed') return null;
    const correct = !missed && ac.exitLevelOk;
    // quanto prima del confine il controllore passa i voli: serve a prevedere il carico (_predictLoad)
    const lead = !missed && !ac.verticalExit && ac.mode === 'route' ? this._timeToExit(ac) : NaN;
    if (Number.isFinite(lead)) this._handoffLeadS += HANDOFF_LEAD_WEIGHT * (clamp(lead, 0, 900) - this._handoffLeadS);
    ac.control = 'transferred';
    ac.transferredAt = this.simTime;
    ac.lastInstruction = `Hand-off a ${ac.nextUnit}`;

    if (correct) {
      this.stats.handedOff++;
    } else if (ac.emergency) {
      // volo in emergenza: il trasferimento si coordina a voce con l'ente successivo, il livello
      // è quello imposto dall'avaria e non conta come errore. Il messaggio lo scrive
      // _updateEmergency, che chiude l'emergenza con una sola riga
    } else {
      this._strike(ac, missed
        ? 'hand-off mancato: uscito dal settore ancora in contatto'
        : `FL${ac.clearedFL} invece di FL${ac.requestedExitFL} richiesto`);
    }
    this._emit('event', { type: missed ? 'missed' : 'handoff', ac, correct, emergency: !!ac.emergency });
    return correct;
  }

  // --- messaggi radio ed emergenze ---------------------------------------------

  // sticky: il messaggio resta finché non viene tolto (richiesta di un volo in emergenza ancora in contatto).
  _message(ac, text, kind = 'info', sticky = false) {
    const msg = { id: ++this._msgId, acId: ac?.id ?? null, callsign: ac?.callsign ?? '', text, kind, at: this.simTime, sticky };
    this.messages.push(msg);
    this._emit('event', { type: 'radio', ac, msg });
    return msg;
  }

  _dropMessage(msg) {
    if (msg) this.messages = this.messages.filter((m) => m !== msg);
  }

  // Un volo in contatto da qualche minuto, dentro il settore e non ancora in emergenza.
  _emergencyCandidates() {
    return this.aircraft.filter((ac) => ac.control === 'assumed' && !ac.emergency && insideLateral(ac)
      && ac.assumedAt !== null && this.simTime - ac.assumedAt >= EMERGENCY_MIN_ASSUMED_S);
  }

  _emergencyTick() {
    if (this.simTime < this._emergencyAt) return;
    if (this.aircraft.some((ac) => ac.emergency && OURS.has(ac.control))) {
      this._emergencyAt = this.simTime + EMERGENCY_RETRY_S;
      return;
    }
    for (const ac of shuffle(this._emergencyCandidates()).slice(0, 4)) {
      if (!this.declareEmergencyOn(ac)) continue;
      this._emergencyAt = this.simTime + this._emergencyMeanS * clamp(gammaUnit(2), 0.4, 2);
      return;
    }
    this._emergencyAt = this.simTime + EMERGENCY_RETRY_S;
  }

  // Avaria dichiarata da un volo in contatto: la chiama _emergencyTick e, nella modalità guidata, la lezione
  // che vuole un'emergenza precisa (type: una voce di EMERGENCY_TYPES).
  declareEmergencyOn(ac, type = null) {
    const e = type ? declareEmergency(ac, this.simTime, type) : declareEmergency(ac, this.simTime);
    if (!e) return null;
    this.emergencies++;
    e.message = this._message(ac, e.request, e.urgency === 'MAYDAY' ? 'mayday' : e.radio ? 'pan' : 'warn', true);
    this._emit('event', { type: 'emergency', ac, emergency: e });
    return e;
  }

  // Seguito dell'emergenza: discesa autorizzata, discesa iniziata dal pilota se l'autorizzazione non arriva,
  // avaria radio che riprende il piano di volo dopo 7 minuti, fine dell'emergenza all'hand-off.
  _updateEmergency(ac) {
    const e = ac.emergency;
    if (!e) return;
    if (ac.control !== 'assumed') {
      if (e.phase !== 'handed') {
        e.phase = 'handed';
        this._dropMessage(e.message);
        if (ac.control === 'transferred') {
          this._message(ac, `${ac.callsign} transferred to ${ac.nextUnit}, ${fmtFl(ac.clearedFL)}, `
            + 'by phone', 'info');
        }
      }
      return;
    }

    if (!e.radio) {
      // livello e velocità assegnati per 7 minuti, poi il livello del piano di volo
      if (e.resumeAt !== null && this.simTime >= e.resumeAt) {
        e.resumeAt = null;
        e.phase = 'resumed';
        const fl = Math.max(50, Math.min(ac.rfl ?? ac.clearedFL, ac.type.maxFL));
        ac.assignedAltitude = fl * 100;
        ac.requestedExitFL = fl;   // livello concordato per telefono con l'ente successivo
        ac.speedMode = 'own';      // senza radio il volo riprende la propria velocità da solo
        ac.assignedMach = null;
        this._dropMessage(e.message);
        e.message = this._message(ac, `${ac.callsign} 7600: resuming ${fmtFl(fl)}, coordinated with `
          + `${ac.nextUnit}`, 'warn', true);
      }
      return;
    }

    // il controllore ha autorizzato la discesa (verso il livello chiesto o verso il livello d'uscita)
    if (e.phase === 'requested'
      && (ac.clearedFL <= e.targetFL || ac.assignedAltitude <= e.levelAtDeclaration * 100 - CLEARED_MARGIN_FT)) {
      e.phase = 'cleared';
      this._dropMessage(e.message);
      e.message = this._message(ac, `${ac.callsign} descending ${fmtFl(ac.clearedFL)}`
        + `${e.divert ? `, divert ${e.divert}` : ''}`, e.urgency === 'MAYDAY' ? 'mayday' : 'pan', true);
      return;
    }

    // nessuna autorizzazione: l'avaria grave scende comunque
    if (e.phase === 'requested' && e.ownDescentAt !== null && this.simTime >= e.ownDescentAt) {
      e.phase = 'own';
      ac.assignedAltitude = e.targetFL * 100;
      this._dropMessage(e.message);
      e.message = this._message(ac, `${ac.callsign} descending ${fmtFl(e.targetFL)} without clearance`,
        'mayday', true);
      this._emit('event', { type: 'emergency-descent', ac, emergency: e });
    }
  }

  // --- temporali e richieste dei piloti -----------------------------------------

  // Prima cella attiva che il volo incontrerebbe proseguendo così, tenendo conto di dove sarà la cella in
  // quel momento. marginScale: 1 = il margine che il pilota vuole, meno di 1 = solo il cuore della cella.
  // route: previsione sulla rotta del piano anche se il volo sta seguendo una prua (serve per il rientro).
  // heading: previsione su una prua diversa da quella attuale (per scegliere la deviazione).
  // altitude: previsione a un altro livello (per non chiedere un livello che porta dentro un temporale).
  _weatherAhead(ac, horizonS, { marginScale = 1, route = false, heading = null, altitude = null } = {}) {
    // scrematura: si simula la rotta solo per le celle che il volo può davvero raggiungere nell'orizzonte
    const reach = (ac.speed / 3600) * horizonS;
    // la quota più bassa che il volo raggiungerà: chi scende verso una cella la incontra anche se ora è sopra
    const low = Math.min(ac.altitude, altitude ?? ac.assignedAltitude);
    const cells = this.weather.cells.filter((c) => {
      if (cellRadius(c) <= 0.5 || !cellAffects(c, low)) return false;
      const mid = cellAt(c, horizonS / 2);
      return Math.hypot(ac.x - mid.x, ac.y - mid.y) <= reach + cellRadius(c) + AVOID_MARGIN_NM[c.intensity] + 8;
    });
    if (!cells.length) return null;
    const g = ac.ghost();
    if (route) {
      g.mode = 'route';
      g.turnDirection = null;
    } else if (heading !== null) {
      g.mode = 'heading';
      g.assignedHeading = heading;
      g.turnDirection = null;
    }
    if (altitude !== null) g.assignedAltitude = altitude;
    // dentro l'eco è sempre un problema; nella fascia di margine attorno solo se ci si sta avvicinando alla
    // cella: un volo che se ne allontana, anche se ancora vicino, è già sulla strada giusta
    const prev = new Map();
    for (let t = 0; t <= horizonS; t += WX_STEP_S) {
      if (t > 0) stepGhost(g, WX_STEP_S);
      for (const cell of cells) {
        if (!cellAffects(cell, g.altitude)) continue;
        const r = cellRadius(cell, t);
        if (r <= 0) continue;
        const c = cellAt(cell, t);
        const d = Math.hypot(g.x - c.x, g.y - c.y);
        const closing = prev.has(cell) && d < prev.get(cell);
        prev.set(cell, d);
        if (d < r || (closing && d < r + AVOID_MARGIN_NM[cell.intensity] * marginScale)) return { cell, t };
      }
    }
    return null;
  }

  // Secondi prima che il volo lasci il settore lungo la rotta (fino al punto d'uscita). Su prua: sconosciuto.
  _timeToExit(ac) {
    const fix = ac.exitFix ?? ac.routeLimitFix;
    const idx = fix ? ac.route.indexOf(fix) : -1;
    if (ac.mode !== 'route' || idx < 0) return Infinity;
    return (routeLengthNm(ac, ac.route.slice(0, idx + 1)) / Math.max(ac.speed, 1)) * 3600;
  }

  // Prua di deviazione come la sceglie un equipaggio guardando il radar meteo di bordo: la virata più piccola,
  // a passi di 5°, che tiene fuori da tutte le celle del fronte con il margine voluto (anche infilando un varco
  // fra due celle), preferendo il lato sopravento (grandine e turbolenza stanno sottovento) e quello verso cui
  // prosegue la rotta. Se nessuna prua entro WX_MAX_TURN è libera, la tangente alla cella dal lato più corto.
  // altitude: livello a cui il volo sarà (per il traffico ancora dell'ente precedente, quello coordinato).
  _deviationOption(ac, hit, altitude = null) {
    // già dentro l'eco: la via d'uscita più breve, senza invertire la rotta (entro 60° dalla direzione che
    // allontana dal centro della cella, la più vicina alla prua attuale)
    const inside = this.weather.cells.find((c) => cellAffects(c, ac.altitude) && cellRadius(c) > 0.5
      && distance(ac, cellAt(c)) < cellRadius(c));
    if (inside) {
      const away = bearing(cellAt(inside), ac);
      const heading = normalizeDeg(Math.round((away + clamp(angleDiff(ac.heading, away), -60, 60)) / 5) * 5);
      return { side: angleDiff(heading, ac.heading) < 0 ? -1 : 1, heading, turn: Math.abs(angleDiff(heading, ac.heading)) };
    }
    const horizon = Math.min(DEVIATION_HORIZON_S, hit.t + WX_PLAN_BEYOND_S);
    const upwind = upwindSide(ac.heading, this.weather.wind);
    const exit = ac.route.length ? waypoint(ac.route[Math.min(ac.exitIndex, ac.route.length - 1)]) : null;
    const toRoute = exit ? Math.sign(angleDiff(bearing(ac, exit), ac.heading)) : 0;
    let best = null;
    let fallback = null;   // se nessuna prua è libera: quella che tiene fuori più a lungo
    for (let turn = WX_MIN_TURN; turn <= WX_MAX_TURN; turn += 5) {
      if (best && best.cost <= turn) break;   // una virata più ampia non può costare meno
      for (const side of [-1, 1]) {
        const cost = turn + (side === upwind ? 0 : WX_DOWNWIND_COST) + (toRoute && side !== toRoute ? WX_AWAY_COST : 0);
        if (best && cost >= best.cost) continue;
        const heading = normalizeDeg(Math.round((ac.heading + side * turn) / 5) * 5);
        const blocked = this._weatherAhead(ac, horizon, { marginScale: WX_PLAN_MARGIN, heading, altitude });
        if (!blocked) best = { side, heading, cost };
        else if (!best && (!fallback || blocked.t > fallback.t || (blocked.t === fallback.t && cost < fallback.cost))) {
          fallback = { side, heading, cost, t: blocked.t };
        }
      }
    }
    best ??= fallback;
    return { side: best.side, heading: best.heading, turn: Math.abs(angleDiff(best.heading, ac.heading)) };
  }

  // Richiesta di deviazione (nuova, oppure di nuovo in attesa perché la prua data non basta più).
  // unable: il controllore ha dato un'istruzione che porta ancora nel temporale.
  _askDeviation(ac, hit, existing = null, { unable = false } = {}) {
    const req = existing ?? { kind: 'deviation' };
    // cella a meno di un minuto e mezzo: non c'è tempo per chiedere, il pilota devia e avvisa
    if (hit.t < WX_URGENT_S && !existing) {
      Object.assign(req, this._deviationOption(ac, hit), { cell: hit.cell, askedAt: this.simTime, phase: 'own' });
      ac.request = req;
      this._deviateOwn(ac, req);
      return;
    }
    Object.assign(req, this._deviationOption(ac, hit), {
      cell: hit.cell, eta: hit.t, distNm: (hit.t * ac.speed) / 3600,
      askedAt: this.simTime, phase: 'pending', seq: ac.instrSeq,
      ownAt: this.simTime + Math.max(WX_MIN_ANSWER_S, hit.t - DEVIATION_OWN_S),
    });
    this._dropMessage(req.message);
    req.message = this._message(ac, unable ? deviationUnableText(ac, req) : deviationText(ac, req), 'request', true);
    if (!existing) {
      ac.request = req;
      this.requests.deviation++;
      this._emit('event', { type: 'request', ac, request: req });
    }
  }

  // Il pilota devia sotto la propria responsabilità e avvisa: il controllore deve solo prenderne atto e
  // risistemare il traffico attorno.
  _deviateOwn(ac, req) {
    req.phase = 'own';
    this.requests.own++;
    ac.wxDeviated = true;
    ac.setHeading(req.heading, req.side < 0 ? 'left' : 'right');
    req.seq = ac.instrSeq;
    this._dropMessage(req.message);
    req.message = null;
    this._message(ac, deviationOwnText(ac, req), 'warn');
    this._emit('event', { type: 'deviation', ac, request: req });
  }

  // Punto della rotta su cui il volo può rientrare senza passare dal temporale: il primo davanti al volo, non
  // troppo vicino, raggiungibile in linea retta con il margine voluto. È così che si rientra davvero.
  _rejoinPoint(ac) {
    const last = Math.min(ac.exitIndex, ac.route.length - 1);
    for (let i = 0; i <= last; i++) {
      const wp = waypoint(ac.route[i]);
      if (!wp) continue;
      const d = distance(ac, wp);
      const hdg = bearing(ac, wp);
      const turn = Math.abs(angleDiff(hdg, ac.heading));
      // niente punti alle spalle o così vicini da doverci girare attorno; il punto d'uscita solo se non è dietro
      if (turn > (i === last ? WX_REJOIN_LAST_TURN : WX_REJOIN_MAX_TURN) || (i < last && d < WX_REJOIN_MIN_NM)) continue;
      const horizon = Math.max(60, Math.min(WX_REJOIN_HORIZON_S, (d / Math.max(ac.speed, 1)) * 3600));
      if (!this._weatherAhead(ac, horizon, { marginScale: WX_REJOIN_SCALE, heading: hdg })) {
        return { fix: ac.route[i], index: i };
      }
    }
    return null;
  }

  // La cella della deviazione è stata superata: dissolta, sopra di noi, oppure ormai al traverso.
  _weatherPassed(ac, cell) {
    if (cellRadius(cell) < 0.5 || !cellAffects(cell, ac.altitude)) return true;
    return Math.abs(angleDiff(bearing(ac, cellAt(cell)), ac.heading)) > WX_PASSED_DEG;
  }

  // Livelli che un equipaggio non chiederebbe mai: dentro una fascia turbolenta già riportata lì attorno,
  // oppure sotto la sommità di un temporale che ha sulla rotta.
  _levelAvoid(ac, fl) {
    if (reportedTurbAt(this.weather, ac, fl)) return true;
    if (!this.weather.cells.length || fl * 100 >= ac.altitude) return false;
    return !!this._weatherAhead(ac, DEVIATION_HORIZON_S, { marginScale: WX_CORE_SCALE, altitude: fl * 100 });
  }

  // Un volo di nostra competenza, livellato e ancora nel settore per un po'. Chi esce lateralmente chiede un
  // altro livello di crociera; chi esce dall'alto o dal basso chiede di salire o scendere verso l'uscita.
  // Gli arrivi già sul livello della STAR non chiedono niente.
  _levelCandidate(ac) {
    return ac.control === 'assumed' && !ac.emergency && !ac.request && ac.exitKind !== 'star'
      && ac.verticalPhase === 'cruise' && insideLateral(ac)
      && ac.assumedAt !== null && this.simTime - ac.assumedAt >= LEVEL_MIN_ASSUMED_S
      && this._timeToExit(ac) > LEVEL_MIN_LEFT_S;
  }

  _openLevelRequest(ac, choice, zone = null) {
    const req = {
      kind: 'level', fl: choice.fl, reason: choice.reason, zone, fromFL: ac.clearedFL,
      askedAt: this.simTime, phase: 'pending',
    };
    ac.request = req;
    ac.levelAskedAt = this.simTime;
    if (zone) this.requests.turb++;
    else this.requests.level++;
    req.message = this._message(ac, choice.text, 'request', true);
    this._emit('event', { type: 'request', ac, request: req });
  }

  // Richiesta di routine di un altro livello di crociera (piano di volo, peso, vento in faccia).
  _levelTick() {
    if (this.simTime < this._levelAt) return;
    const pending = this.aircraft.filter((a) => a.request?.phase === 'pending').length;
    if (pending >= MAX_PENDING) {
      this._levelAt = this.simTime + 60;
      return;
    }
    const candidates = shuffle(this.aircraft.filter((ac) => ac.mode === 'route' && this._levelCandidate(ac)
      && (ac.levelAskedAt === null || this.simTime - ac.levelAskedAt >= LEVEL_RETRY_S)));
    const { wind } = this.weather;
    for (const ac of candidates.slice(0, 5)) {
      const choice = chooseLevelRequest(ac, airspace.sector, {
        headwind: wind.kt >= 30 && headwind(ac.heading, wind),
        avoid: (fl) => this._levelAvoid(ac, fl),
        toDestNm: ac.remainingRouteNm(),
      });
      if (!choice) continue;
      this._openLevelRequest(ac, choice);
      this._levelAt = this.simTime + LEVEL_MEAN_S * clamp(gammaUnit(2), 0.4, 2);
      return;
    }
    this._levelAt = this.simTime + 60;
  }

  // Turbolenza: chi entra nella fascia di una zona chiede di uscirne. Il primo a trovarla ci mette un po' a
  // chiamare (e da lì la zona compare sul radar come riporto); chi arriva dopo sa già cosa aspettarsi.
  _turbulenceCheck(ac) {
    const zone = turbAt(this.weather, ac, ac.altitude);
    if (!zone || !this._levelCandidate(ac)) {
      if (!zone) ac.turbIn = null;
      return;
    }
    if (ac.turbIn?.id !== zone.id) ac.turbIn = { id: zone.id, since: this.simTime };
    if (this.simTime < TURB_FIRST_S) return;
    if (this.simTime - ac.turbIn.since < (zone.reported ? TURB_CALL_KNOWN_S : TURB_CALL_FIRST_S)) return;
    if (ac.levelAskedAt !== null && this.simTime - ac.levelAskedAt < TURB_RETRY_S) return;
    if (this.aircraft.filter((a) => a.request?.phase === 'pending').length >= TURB_MAX_PENDING) return;
    const choice = chooseTurbulenceRequest(ac, airspace.sector, zone, {
      avoid: (fl) => this._levelAvoid(ac, fl), toDestNm: ac.remainingRouteNm(),
    });
    if (!choice) return;
    if (!zone.reported) {
      zone.reported = true;
      zone.reportedBy = ac.callsign;
      zone.reportedAt = this.simTime;
    }
    this._openLevelRequest(ac, choice, zone);
  }

  // Livello autorizzato in risposta alla richiesta del pilota: per un volo che esce lateralmente il livello
  // d'uscita si rivede con il settore successivo, e l'hand-off vale sia al nuovo livello sia a
  // quello pianificato.
  _grantLevel(ac, req) {
    this._close(ac, req, levelReplyText(ac, req));
    if (ac.exitKind !== 'lateral' || ac.requestedExitFL === null || ac.clearedFL === ac.requestedExitFL) return;
    if (ac.clearedFL === ac.altExitFL) {
      // di nuovo al livello pianificato: vale il coordinamento iniziale
      ac.requestedExitFL = ac.altExitFL;
      ac.altExitFL = null;
      return;
    }
    ac.altExitFL ??= ac.requestedExitFL;
    ac.requestedExitFL = ac.clearedFL;
    this._emit('event', { type: 'xfl-revised', ac });
  }

  // Risposta del pilota a un'istruzione data mentre la deviazione è in attesa.
  _readback(ac) {
    if (ac.mode === 'heading') return `${ac.callsign} heading ${String(Math.round(ac.assignedHeading)).padStart(3, '0')}`;
    if (ac.verticalPhase !== 'cruise') {
      return `${ac.callsign} ${ac.verticalPhase === 'climb' ? 'climbing' : 'descending'} ${fmtFl(ac.clearedFL)}`;
    }
    return `${ac.callsign} direct ${ac.route[0]}`;
  }

  // Seguito di una richiesta: autorizzata, scaduta, oppure il pilota fa da sé (solo per il maltempo).
  _updateRequest(ac) {
    const req = ac.request;
    if (!req) return;
    if (ac.control !== 'assumed') {
      this._dropMessage(req.message);
      ac.request = null;
      return;
    }

    // livello: qualunque livello dato in risposta chiude la richiesta (il pilota esegue; se non basta, richiederà)
    if (req.kind === 'level') {
      if (ac.clearedFL !== req.fromFL) this._grantLevel(ac, req);
      else if (this.simTime - req.askedAt > REQUEST_TIMEOUT_S) this._close(ac, req, levelGiveUpText(ac, req));
      return;
    }

    if (req.kind === 'resume') {
      if (ac.instrSeq !== req.seq) {
        // il controllore ha risposto: diretto, rientro in rotta oppure un'altra prua
        this._close(ac, req, ac.mode === 'route' ? `${ac.callsign} direct ${ac.route[0]}` : this._readback(ac));
      } else if (this.simTime - req.askedAt > RESUME_OWN_S) {
        req.phase = 'own';
        ac.directTo(req.fix);
        this._close(ac, req, resumeOwnText(ac, req));
      }
      return;
    }
    if (req.kind !== 'deviation') return;

    if (req.phase === 'pending') {
      const answered = ac.instrSeq !== req.seq;
      if (answered) {
        // il controllore ha dato una prua, un diretto o un livello: va bene se è quella chiesta o se tiene
        // comunque il volo fuori dal temporale
        const asked = ac.mode === 'heading' && Math.abs(angleDiff(ac.assignedHeading, req.heading)) <= 5;
        const hit = asked ? null : this._weatherAhead(ac, DEVIATION_HORIZON_S, { marginScale: WX_ACCEPT_SCALE });
        if (hit) {
          this._askDeviation(ac, hit, req, { unable: true });
          return;
        }
        req.phase = 'granted';
        req.askedAt = this.simTime;
        ac.wxDeviated = true;
        this._dropMessage(req.message);
        req.message = null;
        this._message(ac, this._readback(ac), 'info');
        return;
      }
      // nessuna risposta, ma il motivo è venuto meno: la cella si è spostata o dissolta (con isteresi: la rotta
      // deve passarle ben più lontano di quanto bastava per chiedere)
      const still = this._weatherAhead(ac, DEVIATION_HORIZON_S, { marginScale: WX_CLEAR_SCALE });
      if (!still) {
        ac.wxDone = { cellId: req.cell.id, at: this.simTime };
        this._close(ac, req, `${ac.callsign} deviation no longer required`);
        return;
      }
      // senza autorizzazione il pilota devia da solo poco prima di entrarci, con la prua
      // ricalcolata su dove sono le celle adesso
      if (this.simTime >= req.ownAt) {
        Object.assign(req, this._deviationOption(ac, still), { cell: still.cell, phase: 'own', askedAt: this.simTime });
        this._deviateOwn(ac, req);
      }
      return;
    }

    // deviazione in corso. Un'istruzione nuova che riporta nel temporale: il pilota non la accetta.
    if (ac.instrSeq !== req.seq) {
      req.seq = ac.instrSeq;
      const hit = this._weatherAhead(ac, WX_REJOIN_S, { marginScale: WX_ACCEPT_SCALE });
      if (hit) {
        this._askDeviation(ac, hit, req, { unable: true });
        return;
      }
    }
    // su una prua il pilota chiede di rientrare appena un diretto a un punto più avanti è libero dal maltempo,
    // senza aspettare di avere la cella al traverso; su un diretto la deviazione finisce a cella superata
    if (ac.mode === 'route') {
      if (this._weatherPassed(ac, req.cell)) {
        ac.wxDone = { cellId: req.cell.id, at: this.simTime };
        this._close(ac, req, `${ac.callsign} clear of weather`);
        return;
      }
    } else if (this.simTime - req.askedAt >= WX_REJOIN_AFTER_S && this.simTime >= (req.rejoinAt ?? 0)) {
      req.rejoinAt = this.simTime + WX_REJOIN_EVERY_S;
      const rejoin = this._rejoinPoint(ac);
      if (rejoin) {
        ac.wxDone = { cellId: req.cell.id, at: this.simTime };
        this._close(ac, req, null);
        this._askResume(ac, rejoin);
        return;
      }
    }
    // la cella si è mossa e la prua non basta più: correzione (da solo se sta già deviando da solo)
    if (this.simTime - req.askedAt > WX_RECHECK_S) {
      req.askedAt = this.simTime;
      const hit = this._weatherAhead(ac, WX_REJOIN_S, { marginScale: WX_CORE_SCALE });
      if (!hit) return;
      if (req.phase === 'own') {
        const option = this._deviationOption(ac, hit);
        const change = Math.abs(angleDiff(option.heading, ac.assignedHeading));
        if (change < 5) return;
        Object.assign(req, option, { cell: hit.cell });
        ac.setHeading(req.heading, req.side < 0 ? 'left' : 'right');
        req.seq = ac.instrSeq;
        // il pilota avvisa solo delle correzioni che contano
        if (change >= WX_REPORT_CHANGE_DEG) this._message(ac, deviationOwnText(ac, req), 'warn');
      } else {
        this._askDeviation(ac, hit, req);
      }
    }
  }

  _askResume(ac, rejoin) {
    const req = { kind: 'resume', ...rejoin, askedAt: this.simTime, phase: 'pending', seq: ac.instrSeq };
    ac.request = req;
    req.message = this._message(ac, resumeText(ac, req), 'request', true);
    this._emit('event', { type: 'request', ac, request: req });
  }

  // Chiude la richiesta: toglie la riga fissa e, se serve, lascia un messaggio breve.
  _close(ac, req, text) {
    this._dropMessage(req.message);
    ac.request = null;
    if (text) this._message(ac, text, 'info');
  }

  // Il traffico non di nostra competenza gira attorno ai temporali da solo, senza chiedere niente:
  // devia quando la rotta ci passa dentro e rientra solo quando la rotta è di nuovo libera.
  _avoidWeather(ac) {
    // il volo ancora dell'ente precedente scende o sale verso il livello coordinato con noi: la previsione va
    // fatta a quel livello, altrimenti un volo che scende sulla sommità di una cella non la vedrebbe
    const altitude = (ac.control === 'offered' || ac.control === 'inbound') && ac.entryFt != null ? ac.entryFt : null;
    if (ac.wxAvoid) {
      if (this.simTime - ac.wxAvoid.since >= WX_REJOIN_AFTER_S) {
        const rejoin = this._rejoinPoint(ac);
        if (rejoin) {
          ac.wxAvoid = null;
          ac.directTo(rejoin.fix);
          return;
        }
      }
      const hit = this._weatherAhead(ac, WX_REJOIN_S, { marginScale: WX_CORE_SCALE, altitude });
      if (hit) {
        const option = this._deviationOption(ac, hit, altitude);
        ac.setHeading(option.heading, option.side < 0 ? 'left' : 'right');
      }
      return;
    }
    const hit = this._weatherAhead(ac, WX_OTHER_HORIZON_S, { marginScale: WX_CORE_SCALE, altitude });
    if (!hit) return;
    const option = this._deviationOption(ac, hit, altitude);
    ac.setHeading(option.heading, option.side < 0 ? 'left' : 'right');
    ac.wxAvoid = { cell: hit.cell, since: this.simTime };
  }

  // Volo che ci arriva mentre sta già aggirando un temporale con l'ente precedente: al primo contatto lo dice,
  // e da lì la deviazione prosegue come una nostra (rientro in rotta chiesto a noi).
  _inheritDeviation(ac) {
    const { cell } = ac.wxAvoid;
    ac.wxAvoid = null;
    if (ac.request || ac.emergency || ac.mode !== 'heading') return;
    const side = angleDiff(ac.assignedHeading, bearing(ac, cellAt(cell))) > 0 ? 1 : -1;
    ac.request = {
      kind: 'deviation', phase: 'own', cell, side, heading: ac.assignedHeading, turn: 0,
      askedAt: this.simTime, seq: ac.instrSeq,
    };
    ac.wxDeviated = true;
    this._message(ac, `${ac.callsign} ${fmtFl(ac.flightLevel)}, deviating due weather, heading `
      + `${String(Math.round(ac.assignedHeading)).padStart(3, '0')}`, 'info');
  }

  _updateWeather(dt) {
    stepWeather(this.weather, dt, this.simTime);
    this._levelTick();
    for (const ac of this.aircraft) this._updateRequest(ac);

    this._wxTimer -= dt;
    if (this._wxTimer > 0) return;
    this._wxTimer = WX_CHECK_EVERY_S;
    for (const ac of this.aircraft) {
      if (ac.control === 'assumed') {
        if (ac.wxAvoid) this._inheritDeviation(ac);
        if (ac.request || ac.emergency) continue;
        if (this.weather.turb.length) this._turbulenceCheck(ac);
        if (ac.request || !this.weather.cells.length) continue;
        // si chiede solo se la rotta entra davvero nella cella, non se la sfiora, e solo se ci arriva prima di
        // lasciare il settore: altrimenti lo chiederà all'ente successivo
        const hit = this._weatherAhead(ac, DEVIATION_HORIZON_S, { marginScale: WX_CORE_SCALE });
        if (!hit || hit.t > this._timeToExit(ac) + WX_EXIT_SLACK_S) continue;
        // la stessa cella appena lasciata non fa richiedere subito, a meno che non sia ormai vicina
        if (ac.wxDone?.cellId === hit.cell.id && this.simTime - ac.wxDone.at < WX_SAME_CELL_S && hit.t > WX_SAME_CELL_NEAR_S) continue;
        this._askDeviation(ac, hit);
      } else if (ac.control !== 'assumed' && ac.control !== 'transferred' && this.weather.cells.length) {
        this._avoidWeather(ac);
      }
    }
  }

  _strike(ac, reason) {
    this.strikes.push({ callsign: ac.callsign, reason });
    if (this.strikes.length >= MAX_STRIKES) this._endGame('handoff', { strikes: this.strikes });
  }

  _endGame(reason, detail) {
    if (this.gameOver) return;
    this.gameOver = { reason, detail, time: this.simTime, stats: { ...this.stats } };
    this._emit('gameover', this.gameOver);
  }

  // --- avanzamento -----------------------------------------------------------

  _updateControl(ac) {
    const inside = insideVolume(ac);
    const lateral = insideLateral(ac);
    const s = ac.alongTrackNm();
    // l'ingresso conta dal punto d'ingresso pianificato: un volo che taglia un angolo del settore prima di
    // entrarci davvero non è ancora "entrato" (e uscendone non manca l'hand-off)
    const reached = ac.entryS === null || s >= ac.entryS - ENTRY_TOLERANCE_NM;
    if (inside && reached) ac.wasInside = true;

    // uscita temporanea da una rientranza del confine, con l'uscita pianificata ancora davanti: il volo resta
    // nostro (flows.js, excursionEnd) e non conta né come uscita né come hand-off mancato
    const excursion = !lateral && ac.mode === 'route' && ac.exitS !== null && s < ac.exitS - EXCURSION_TOLERANCE_NM;

    // controllo del punto d'uscita quando un volo che è stato nostro lascia lateralmente il settore
    if (ac.wasAssumed && !ac.exitChecked && ac.wasLateral && !lateral && !excursion && ac.exitKind === 'lateral') {
      ac.exitChecked = true;
      const fix = waypoint(ac.exitFix);
      const withinBand = ac.altitude >= airspace.floorFt - 1000 && ac.altitude < airspace.ceilingFt + 1000;
      // scostamento del punto d'uscita dalla traiettoria con cui il volo attraversa il confine
      const rad = (ac.heading * Math.PI) / 180;
      const reach = 40;
      const back = { x: ac.x - Math.sin(rad) * reach, y: ac.y + Math.cos(rad) * reach };
      const ahead = { x: ac.x + Math.sin(rad) * reach, y: ac.y - Math.cos(rad) * reach };
      const off = fix ? distanceToSegment(fix, back, ahead) : 0;
      // un volo che ha deviato per un temporale esce dove può: si coordina a voce, non è un errore
      if (withinBand && off > EXIT_POINT_TOLERANCE_NM && !ac.wxDeviated && !ac.emergency) {
        this._strike(ac, `uscito a ${Math.round(off)} NM da ${ac.exitFix}, punto d'uscita richiesto`);
        this._emit('event', { type: 'offpoint', ac, off });
      }
    }

    const profileFt = Math.round(profileAltitude(ac.profile, s) / 100) * 100;

    if (ac.control === 'other') {
      ac.assignedAltitude = profileFt;
    } else if (ac.control === 'inbound' || ac.control === 'offered') {
      // l'ente precedente mantiene il volo sul livello coordinato
      ac.assignedAltitude = coordinatedAltitude(profileFt, ac.clamp, ac.entryFt);
      if (ac.control === 'inbound' && (inside || ((ac.entryS - s) / ac.speed) * 3600 <= OFFER_LEAD_S)) {
        ac.control = 'offered';
        ac.offeredAt = this.simTime;
        this._emit('event', { type: 'offered', ac });
      }
    } else if (ac.control === 'assumed') {
      ac.assumedAt ??= this.simTime;
      // arrivo con uscita 'star': oltre il punto iniziale della STAR il volo è già dell'avvicinamento
      const pastStar = ac.exitKind === 'star' && ac.mode === 'route' && !ac.route.includes(ac.exitFix);
      if (((!inside && ac.wasInside) || (!lateral && ac.wasLateral) || pastStar) && !excursion) {
        ac.outsideSince = ac.outsideSince ?? this.simTime;
        if (this.simTime - ac.outsideSince >= MISSED_HANDOFF_GRACE_S) this.handOff(ac, { missed: true });
      } else {
        ac.outsideSince = null;
      }
      // uscita dall'alto o dal basso: il volo va passato mentre si avvicina all'XFL, non dopo che si è livellato
      if (ac.verticalExit && ac.control === 'assumed' && !ac.xflWarned
        && Math.abs(ac.altitude - ac.requestedExitFL * 100) < 50 && ac.clearedFL === ac.requestedExitFL) {
        ac.levelledAtXflSince ??= this.simTime;
        if (this.simTime - ac.levelledAtXflSince >= XFL_LEVEL_WARN_S) {
          ac.xflWarned = true;
          this._emit('event', { type: 'xfl-level', ac });
        }
      } else {
        ac.levelledAtXflSince = null;
      }
    } else if (ac.control === 'transferred') {
      // l'ente successivo riporta il volo sul suo profilo, sulla rotta e sulla velocità propria
      const elapsed = this.simTime - ac.transferredAt;
      if (elapsed > 20) ac.assignedAltitude = transferredAltitude(ac, profileFt, profilePhase(ac.profile, s));
      if (elapsed > 40 && ac.mode === 'heading') ac.resumeOwnNavigation();
      if (elapsed > 40) ac.resumeOwnSpeed();
    }

    if (lateral && reached) ac.wasLateral = true;
  }

  // Short Term Conflict Alert: coppie con almeno un volo di nostra competenza che, proseguendo
  // con prua, velocità e livello autorizzato attuali, perdono la separazione entro STCA_S secondi.
  _updateStca() {
    const pairs = [];
    for (const ac of this.aircraft) ac.stca = false;
    const relevant = (ac) => OURS.has(ac.control) || isConcerned(ac);
    for (let i = 0; i < this.aircraft.length; i++) {
      for (let j = i + 1; j < this.aircraft.length; j++) {
        const a = this.aircraft[i];
        const b = this.aircraft[j];
        if (!relevant(a) && !relevant(b)) continue;
        const t = pairConflictTime(a, b, STCA_S);
        if (t === null) continue;
        a.stca = true;
        b.stca = true;
        pairs.push({ a, b, timeToConflict: t });
      }
    }
    const keys = new Set(pairs.map((p) => `${Math.min(p.a.id, p.b.id)}-${Math.max(p.a.id, p.b.id)}`));
    for (const p of pairs) {
      const key = `${Math.min(p.a.id, p.b.id)}-${Math.max(p.a.id, p.b.id)}`;
      if (!this._stcaKeys.has(key)) this._emit('event', { type: 'stca', a: p.a, b: p.b, t: p.timeToConflict });
    }
    this._stcaKeys = keys;
    this.stca = pairs;
  }

  // Prima zona attiva in cui il volo entrerebbe proseguendo con rotta (o prua) e livello autorizzato, finché resta
  // di nostra competenza: dal suo ingresso nel settore (o da subito, se è già in contatto e ci è già entrato)
  // finché non esce lateralmente, salvo le uscite temporanee da una rientranza del confine con l'uscita
  // pianificata ancora davanti. Sono le stesse regole con cui un ingresso in zona conta come errore
  // (_updateAreas): ciò che non viene previsto non deve poter costare un errore, e viceversa. Conta l'orario:
  // una zona che si attiva prima del passaggio è attiva.
  // anywhere: per il traffico non nostro, qualunque zona lungo il percorso (senza limitarsi al settore);
  // xfl: ipotesi che il controllore autorizzi subito il volo al livello d'uscita; delayS: il volo comparirà fra
  // delayS secondi; handoffAtXfl: il volo che esce dall'alto o dal basso si considera passato appena arriva al
  // livello d'uscita (le tre opzioni servono alla programmazione del traffico). Senza handoffAtXfl il volo resta
  // nostro finché non lo si passa davvero: autorizzato all'XFL e non ancora passato, se la zona è su quel livello
  // ci entra, e l'allarme lo deve dire.
  _predictArea(ac, candidates, { horizonS = AREA_PREDICT_S, anywhere = false, xfl = false, delayS = 0, handoffAtXfl = false } = {}) {
    if (!candidates.length) return null;
    const g = ac.ghost();
    g.xflMode = xfl;
    let seenInside = anywhere || insideLateral(g) || (g.control === 'assumed' && g.wasLateral);
    const hit = (t) => {
      for (const area of candidates) {
        if (areaContains(area, g, g.altitude) && isActiveAt(this.areaSchedule, area, this.clockS + delayS + t)) {
          return { area, t, x: g.x, y: g.y, altFt: g.altitude };
        }
      }
      return null;
    };
    if (seenInside) {
      const now = hit(0);
      if (now) return now;
    }
    for (let t = AREA_PREDICT_STEP_S; t <= horizonS; t += AREA_PREDICT_STEP_S) {
      stepGhost(g, AREA_PREDICT_STEP_S);
      if (anywhere || insideLateral(g)) seenInside = true;
      else if (seenInside && distanceFromSector(g) > EXCURSION_TOLERANCE_NM && !ghostExcursion(g)) return null;
      if (!seenInside) continue;
      const found = hit(t);
      if (found) return found;
      if (handoffAtXfl && g.verticalExit && g.clearedFL === g.requestedExitFL
        && Math.abs(g.altitude - g.requestedExitFL * 100) < 300) return null;
    }
    return null;
  }

  _areaCandidates(horizonS, delayS = 0) {
    const clock = this.clockS + delayS;
    return airspace.areas.filter((a) => (this.areaSchedule.get(a.id) ?? []).some(([s, e]) => s < clock + horizonS && e > clock));
  }

  // I voli si pianificano attorno alle zone che saranno attive al loro passaggio (piano AUP): solo alcuni, dosati
  // dalla difficoltà (areaConflictsPerHour), ci arrivano diretti dentro una zona e vanno vettorati o fatti
  // salire o scendere. Mai quando fra l'offerta e l'ingresso nella zona non resta il tempo minimo di reazione.
  // Il traffico non nostro non attraversa mai zone attive.
  // Le due ipotesi di livello dei voli nostri sono quelle della verifica dei conflitti alla comparsa: livello
  // coordinato mantenuto, oppure salita o discesa subito al livello d'uscita.
  // force: si accetta anche oltre il budget (mai senza tempo di reazione). Dopo un rifiuto, _areaReject dice se
  // è dipeso solo dal budget.
  _areaAllowed(ac, plan, ours, delayS = 0, force = false) {
    this._areaReject = null;
    if (plan?.areaChecked) return true;
    const offerIn = Math.max(0, (plan?.entryInS ?? 0) - OFFER_LEAD_S);
    const horizonS = ours ? Math.min(2400, offerIn + OFFER_LEAD_S + AREA_PREDICT_S) : 1200;
    const candidates = this._areaCandidates(horizonS, delayS);
    const opts = { horizonS, anywhere: !ours, delayS, handoffAtXfl: true };
    // prima del nostro confine il volo è dell'ente precedente, che non lo fa mai entrare in una zona attiva
    if (ours && this._predictArea(ac, candidates, { horizonS: offerIn + OFFER_LEAD_S, anywhere: true, delayS })) {
      this._areaReject = 'before';
      return false;
    }
    const hits = [this._predictArea(ac, candidates, opts)];
    if (ours) hits.push(this._predictArea(ac, candidates, { ...opts, xfl: true }));
    const hit = hits.filter(Boolean).sort((a, b) => a.t - b.t)[0];
    if (plan) plan.areaChecked = true;
    if (!hit) return true;
    if (!ours || hit.t - offerIn < this.difficulty.reactionS[0] || (this._areaBudget < 1 && !force)) {
      if (plan) plan.areaChecked = false;
      this._areaReject = ours && hit.t - offerIn >= this.difficulty.reactionS[0] ? 'budget' : 'unfair';
      return false;
    }
    this._areaBudget = Math.max(-2, this._areaBudget - 1);
    return true;
  }

  // Zone attive: stato del momento, allarme di prossimità (APW) e violazioni dei voli di nostra competenza.
  _updateAreas(dt) {
    const clock = this.clockS;
    for (const area of airspace.areas) {
      const active = isActiveAt(this.areaSchedule, area, clock);
      if (active !== area.active && this.relevantAreas.has(area.id)) {
        const w = currentOrNextWindow(this.areaSchedule, area, clock);
        this._emit('event', { type: active ? 'area-on' : 'area-off', area, until: active && w ? w[1] : null });
      }
      area.active = active;
      area.alarm = false;
    }

    // la previsione si rifà ogni AREA_CHECK_EVERY_S secondi e subito dopo ogni istruzione al volo: cambiato
    // livello o prua, l'allarme deve seguire la nuova autorizzazione, non quella vecchia
    this._areaTimer -= dt;
    const due = this._areaTimer <= 0;
    if (due) this._areaTimer = AREA_CHECK_EVERY_S;
    let candidates = null;
    const areasAhead = () => (candidates ??= airspace.areas.filter((a) => (this.areaSchedule.get(a.id) ?? [])
      .some(([s, e]) => s < clock + AREA_PREDICT_S && e > clock)));

    const apwKeys = new Set();
    for (const ac of this.aircraft) {
      const ours = ac.control === 'assumed' || ac.control === 'offered';
      if (!ours) {
        ac.apw = null;
        ac.areaConflict = null;
        continue;
      }
      ac.offeredAt ??= this.simTime;
      if (due || ac._areaSeq !== ac.instrSeq || ac._areaControl !== ac.control) {
        ac.areaConflict = this._predictArea(ac, areasAhead());
        ac._areaSeq = ac.instrSeq;
        ac._areaControl = ac.control;
      }

      // conta dall'ingresso nel settore: prima il volo è ancora sulla rotta scelta dall'ente precedente
      const ourSide = insideLateral(ac) || (ac.control === 'assumed' && ac.wasLateral);
      let inside = null;
      let close = null;
      if (ourSide) {
        for (const area of airspace.areas) {
          if (!area.active) continue;
          if (areaContains(area, ac, ac.altitude)) {
            inside = area;
            close = area;
            break;
          }
          if (!close && areaTooClose(area, ac, ac.altitude)) close = area;
        }
      }
      if (!close && ac.areaConflict && ac.areaConflict.t <= APW_S) close = ac.areaConflict.area;
      ac.apw = close;
      if (close) {
        close.alarm = true;
        const key = `${ac.id}|${close.id}`;
        apwKeys.add(key);
        if (!this._apwKeys.has(key) && !inside) {
          this._emit('event', { type: 'apw', ac, area: close, t: ac.areaConflict?.area === close ? ac.areaConflict.t : 0 });
        }
      }

      if (inside && !ac.areaStrikes.has(inside.id)) {
        ac.areaStrikes.add(inside.id);
        // un volo in emergenza ha la priorità su ogni altro traffico e sulle zone riservate;
        // un pilota che devia da solo per un temporale decide lui la prua: non è un errore del controllore
        const ownWx = ac.request?.kind === 'deviation' && ac.request.phase === 'own';
        const fair = this.simTime - ac.offeredAt >= AREA_GRACE_S && !ac.emergency && !ownWx;
        if (fair) this._strike(ac, `entrato nella zona attiva ${inside.name} (${areaBand(inside)}) a FL${ac.flightLevel}`);
        this._emit('event', { type: 'area-infringement', ac, area: inside, strike: fair });
      }
    }
    this._apwKeys = apwKeys;
  }

  tick(dtRealSeconds) {
    if (this.paused || this.gameOver) return;
    const dt = dtRealSeconds * this.timeMultiplier;
    this.simTime += dt;

    this._planTimer -= dt;
    if (this._planTimer <= 0 && !this.scripted) {
      this._planTimer = PLAN_EVERY_S;
      // dopo l'avvio il traffico non segue più un ritmo fisso: lo regola _balanceTick sul carico previsto
      if (this.simTime < this._warmupUntil) this._planTraffic();
      this._conflictTick();
      this._warmupTick();
      this._balanceTick();
    }
    this._areaBudget = Math.min(2, this._areaBudget + (dt * this.difficulty.areaConflictsPerHour) / 3600);
    this._spawnPendingConflicts();
    this._spawnScheduled();
    this._otherTimer -= dt;
    if (this._otherTimer <= 0 && !this.scripted) {
      const others = this.aircraft.filter((a) => a.control === 'other').length;
      const spawned = others < this.maxOther && this.spawnOther();
      this._otherTimer = spawned ? this._nextDelay(this.demand * 0.8 + 6) : 8 + Math.random() * 8;
    }

    for (const ac of this.aircraft) {
      ac.update(dt);
      this._updateControl(ac);
      this._updateEmergency(ac);
    }
    this._emergencyTick();

    for (const ac of this.aircraft) ac.conflict = false;
    for (let i = 0; i < this.aircraft.length; i++) {
      for (let j = i + 1; j < this.aircraft.length; j++) {
        const a = this.aircraft[i];
        const b = this.aircraft[j];
        if (distance(a, b) < SEP_HORIZONTAL_NM && Math.abs(a.altitude - b.altitude) < SEP_VERTICAL_FT) {
          a.conflict = true;
          b.conflict = true;
          if (isConcerned(a) || isConcerned(b)) this._endGame('separation', { a, b });
        }
      }
    }

    this._updateStca();
    this._updateAreas(dt);
    this._updateWeather(dt);

    this.aircraft = this.aircraft.filter((ac) => {
      const dest = waypoint(ac.destination);
      if (!OURS.has(ac.control) && dest && distance(ac, dest) < 8 && ac.altitude < 12000) return false;
      // volo dirottato per un'emergenza: l'ente successivo lo porta all'atterraggio, sparisce dal nostro radar
      if (!OURS.has(ac.control) && ac.emergency?.divert && dest && distance(ac, dest) < 10) return false;
      if (OURS.has(ac.control)) return inView(ac, 150);
      return inView(ac, 40);
    });

    // i messaggi scadono, tranne quelli permanenti; spariscono con il volo a cui si riferiscono
    const present = new Set(this.aircraft.map((ac) => ac.id));
    this.messages = this.messages.filter((m) => (m.sticky || this.simTime - m.at < MESSAGE_LIFE_S)
      && (m.acId === null || present.has(m.acId)));
  }
}
