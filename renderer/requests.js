// Richieste dei piloti sulla frequenza: cambi di livello di crociera e deviazioni
// per evitare i temporali. Arrivano come messaggi in alto sul radar e restano lì finché il
// controllore risponde: si autorizza dando il livello, la prua o il diretto chiesti.
// Chiamate radio e righe di stato sono in inglese, come in frequenza; i commenti restano in italiano.
// Se la deviazione dal maltempo non arriva in tempo il pilota devia lo stesso, avvisando: è quello che
// succede davvero, e da lì in poi il traffico attorno va risistemato.

import { levelsForTrack } from './sectors.js';

export const LEVEL_FIRST_S = [300, 600];     // prima richiesta di livello della sessione: dopo 5-10 minuti
export const LEVEL_MEAN_S = 600;             // intervallo medio fra due richieste di livello
export const LEVEL_MIN_ASSUMED_S = 60;
export const LEVEL_MIN_LEFT_S = 300;         // tempo minimo che il volo deve restare nel settore
export const REQUEST_TIMEOUT_S = 210;        // dopo tanto il pilota lascia perdere e mantiene
export const MAX_PENDING = 2;                // richieste in attesa contemporanee

export const DEVIATION_HORIZON_S = 420;      // si chiede la deviazione 5-7 minuti prima (40-50 NM)
export const DEVIATION_OWN_S = 180;          // senza autorizzazione il pilota devia da solo così prima
export const RESUME_OWN_S = 210;

const fmtFl = (n) => `FL${String(Math.round(n)).padStart(3, '0')}`;
const fmtHdg = (n) => String(Math.round(n)).padStart(3, '0');

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Livelli di crociera che il volo può chiedere: dentro la fascia del settore, corretti per la semicircolare
// della sua rotta, non oltre la tangenza del tipo e non in una fascia turbolenta già riportata o dentro un
// temporale sulla rotta (ctx.avoid).
function usableLevels(ac, sector, ctx) {
  return levelsForTrack(ac.levelTrack, sector.floorFL + 5, Math.min(sector.ceilingFL - 5, ac.type.maxFL))
    .filter((fl) => fl !== ac.clearedFL && !ctx.avoid?.(fl));
}

// Una salita ha senso solo se, arrivati al nuovo livello, restano almeno CRUISE_AFTER_CLIMB_NM di crociera
// prima di dover cominciare la discesa verso la destinazione: nessun equipaggio chiede di salire per poi
// scendere subito dopo. ctx.toDestNm: miglia che mancano all'atterraggio lungo la rotta.
export const CRUISE_AFTER_CLIMB_NM = 80;

function worthClimbing(ac, fl, ctx) {
  if (ctx.toDestNm === undefined || !ac.profile?.perf) return true;
  const perf = ac.profile.perf;
  const climbNm = Math.max(0, perf.climbDistance(fl * 100) - perf.climbDistance(ac.altitude));
  return ctx.toDestNm - climbNm - perf.descentDistance(fl * 100) >= CRUISE_AFTER_CLIMB_NM;
}

// Turbolenza: si chiede il livello più vicino fuori dalla fascia, sopra o sotto; a pari distanza sopra, se il
// volo ci arriva (più leggero consuma meno), altrimenti sotto.
export function chooseTurbulenceRequest(ac, sector, zone, ctx = {}) {
  const out = usableLevels(ac, sector, ctx)
    .filter((fl) => (fl < zone.lo || fl > zone.hi) && (fl < ac.clearedFL || worthClimbing(ac, fl, ctx)));
  if (!out.length) return null;
  const fl = out.sort((a, b) => Math.abs(a - ac.clearedFL) - Math.abs(b - ac.clearedFL)
    || (b > ac.clearedFL) - (a > ac.clearedFL))[0];
  if (Math.abs(fl - ac.clearedFL) > 60) return null;
  const verb = fl > ac.clearedFL ? 'climb' : 'descent';
  return { fl, reason: 'turbulence', text: `${ac.spoken}, moderate turbulence, request ${verb} ${fmtFl(fl)}` };
}

// Richiesta di routine: tornare al livello del piano di volo, salire perché l'aereo si è alleggerito, oppure
// scendere se il vento in faccia è forte (ctx.headwind). Mai la turbolenza "a caso": quella arriva solo dalle
// zone vere, con chooseTurbulenceRequest. Mai una salita a poca distanza dalla destinazione.
export function chooseLevelRequest(ac, sector, ctx = {}) {
  // chi deve uscire dall'alto o dal basso chiede di andarci: salire per il carburante, scendere perché è
  // pronto per la discesa. Il livello è quello d'uscita, già coordinato: nessuna revisione
  if (ac.verticalExit) {
    const fl = ac.requestedExitFL;
    if (fl === null || fl === ac.clearedFL || ctx.avoid?.(fl)) return null;
    return fl > ac.clearedFL
      ? { fl, reason: 'for fuel', text: `${ac.spoken}, request climb ${fmtFl(fl)}, for fuel` }
      : { fl, reason: 'ready for descent', text: `${ac.spoken}, ready for descent, request ${fmtFl(fl)}` };
  }
  const levels = usableLevels(ac, sector, ctx)
    .filter((fl) => Math.abs(fl - ac.clearedFL) <= 40 && (fl < ac.clearedFL || worthClimbing(ac, fl, ctx)));
  if (!levels.length) return null;
  const up = levels.filter((fl) => fl > ac.clearedFL);
  const down = levels.filter((fl) => fl < ac.clearedFL);
  const wantsRfl = ac.rfl !== null && ac.rfl > ac.clearedFL && up.includes(ac.rfl);
  let fl;
  let reason;
  if (wantsRfl && Math.random() < 0.8) {
    fl = ac.rfl;
    reason = 'flight plan level';
  } else if (ctx.headwind && down.length && Math.random() < 0.6) {
    fl = down[down.length - 1];
    reason = 'less headwind lower';
  } else if (up.length && ac.clearedFL < ac.type.maxFL - 20) {
    fl = up[0];
    reason = pick(['for fuel', 'lighter now']);
  } else {
    return null;
  }
  const verb = fl > ac.clearedFL ? 'climb' : 'descent';
  return { fl, reason, text: `${ac.spoken}, request ${verb} ${fmtFl(fl)}, ${reason}` };
}

export function levelReplyText(ac, req) {
  return `${ac.callsign} leaving ${fmtFl(req.fromFL)} for ${fmtFl(ac.clearedFL)}`;
}

export function levelGiveUpText(ac) {
  return `${ac.callsign} no reply, maintaining ${fmtFl(ac.clearedFL)}`;
}

export function deviationText(ac, req) {
  const where = req.side < 0 ? 'left' : 'right';
  const miles = Math.max(10, Math.round(req.distNm / 10) * 10);
  return `${ac.spoken}, weather ${miles} miles ahead, request ${where} heading ${fmtHdg(req.heading)}`;
}

// Il controllore ha dato una prua (o un diretto, o un livello) che porta ancora nel temporale.
export function deviationUnableText(ac, req) {
  const where = req.side < 0 ? 'left' : 'right';
  return `${ac.spoken}, unable due weather, request ${where} heading ${fmtHdg(req.heading)}`;
}

export function deviationOwnText(ac, req) {
  const where = req.side < 0 ? 'left' : 'right';
  return `${ac.callsign} deviating ${where}, heading ${fmtHdg(req.heading)}`;
}

export function resumeText(ac, req) {
  return `${ac.spoken}, clear of weather, request direct ${req.fix}`;
}

export function resumeOwnText(ac, req) {
  return `${ac.callsign} back on track, direct ${req.fix}`;
}

// Riga di stato della richiesta per l'etichetta: breve, il motivo lo dice la chiamata radio.
export function requestStatus(ac) {
  const r = ac.request;
  if (!r) return '';
  if (r.kind === 'level') return `requests ${fmtFl(r.fl)}${r.reason === 'turbulence' ? ', turbulence' : ''}`;
  if (r.kind === 'resume') return `${r.phase === 'own' ? 'own' : 'requests'} direct ${r.fix}`;
  const where = r.side < 0 ? 'left' : 'right';
  if (r.phase === 'own') return `deviating ${where}, heading ${fmtHdg(r.heading)}`;
  if (r.phase === 'granted') return 'deviating, will report clear';
  return `requests ${where} heading ${fmtHdg(r.heading)}`;
}

// Etichetta breve del tipo di richiesta, per il riquadro dei messaggi e per l'etichetta del volo.
export const REQUEST_LABEL = { level: 'Level request', deviation: 'Weather deviation', resume: 'Back on route' };
export const REQUEST_TAG = { level: 'REQ LEVEL', deviation: 'REQ WX', resume: 'REQ DIRECT' };

export { fmtFl };
