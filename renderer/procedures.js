// SID e STAR degli aeroporti italiani (data/procedures.js): piste in uso nella sessione, scelta della
// procedura per un volo e livello di trasferimento all'avvicinamento sul punto iniziale della STAR.
// I dati restano completi (tutte le piste, tutti i fix) per i futuri settori di avvicinamento e partenza.
import { PROCEDURES, PROC_FIXES } from './data/procedures.js';

export { PROCEDURES, PROC_FIXES };

const OPPOSITE_SHARE = 0.25;   // sessioni con il vento contrario alla configurazione prevalente
const STAR_FT_PER_NM = 300;    // livello sul punto iniziale senza vincolo pubblicato: circa 3° sulla distanza diretta
const STAR_MAX_FL = 200;       // dall'aeroporto, al più FL200

const uses = (proc, runways) => proc.rwy.some((r) => runways.includes(r));

// pista opposta: 16L -> 34R, 07 -> 25
function reciprocal(rwy) {
  const n = ((Number(rwy.slice(0, 2)) + 17) % 36) + 1;
  const side = { L: 'R', R: 'L', C: 'C' }[rwy[2]] ?? '';
  return `${String(n).padStart(2, '0')}${side}`;
}

// Configurazione con il vento contrario: le piste opposte, se hanno procedure pubblicate (alcuni aeroporti,
// come Salerno, hanno STAR per una sola pista: lì si resta sulla configurazione prevalente).
function oppositeConfig(p) {
  if (p.altConfig) return p.altConfig;
  const flip = (list, procs) => {
    const out = list.map(reciprocal).filter((r) => p.runways[r]);
    return out.length && procs.some((x) => uses(x, out)) ? out : null;
  };
  const arr = flip(p.config.arr, p.stars);
  const dep = flip(p.config.dep, p.sids);
  return arr && dep ? { arr, dep } : p.config;
}

// Piste in uso nella sessione: la configurazione prevalente, oppure quella con il vento contrario.
export const activeRunways = {};

export function chooseRunways(random = Math.random) {
  for (const [icao, p] of Object.entries(PROCEDURES)) {
    activeRunways[icao] = random() < OPPOSITE_SHARE ? oppositeConfig(p) : p.config;
  }
  return activeRunways;
}
chooseRunways();

// SID utilizzabili dalle piste in uso, una per percorso (le varianti per categoria di scia hanno gli stessi fix).
export function activeSids(icao) {
  const p = PROCEDURES[icao];
  if (!p) return [];
  const rw = activeRunways[icao]?.dep ?? p.config.dep;
  const seen = new Set();
  return p.sids.filter((s) => {
    const key = s.fixes.join('>');
    if (!uses(s, rw) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function activeStars(icao) {
  const p = PROCEDURES[icao];
  if (!p) return [];
  const rw = activeRunways[icao]?.arr ?? p.config.arr;
  const seen = new Set();
  return p.stars.filter((s) => {
    if (!uses(s, rw) || seen.has(s.fixes[0])) return false;
    seen.add(s.fixes[0]);
    return true;
  });
}

// Designatore compatto come nel piano di volo: "SOSAK 5A" -> "SOSAK5A".
export const compact = (id) => id.replace(' ', '');

export function sidLabel(sid) {
  return sid.transition ? `${compact(sid.id)} ${compact(sid.transition)}` : compact(sid.id);
}

// Livelli (FL) a cui l'ACC può consegnare l'arrivo all'avvicinamento sul punto iniziale della STAR: quelli
// pubblicati se ci sono (per esempio VALMA FL180 per Fiumicino), altrimenti al più quello di una discesa di
// circa 3° sulla distanza diretta dall'aeroporto (directNm). Restituisce { min, max }.
export function starTransferLevels(star, directNm) {
  if (star.level) return { min: star.level.min ?? 0, max: star.level.max ?? 660 };
  return { min: 0, max: Math.min(STAR_MAX_FL, Math.floor((directNm * STAR_FT_PER_NM) / 1000) * 10) };
}
