// Flussi di traffico fra coppie di aeroporti e pianificazione verticale dei voli.
// I flussi vengono calcolati una sola volta al caricamento del settore; ogni nuovo volo
// sceglie un flusso, un tipo di aeromobile e un livello di crociera, poi il piano stabilisce
// se e come attraversa il volume del settore (ingresso, uscita, livelli coordinati).
import { AIRCRAFT_TYPES } from './world.js';
import { levelsForTrack } from './sectors.js';
import { performanceOf, scheduleSpeed, climbRate, descentRate } from './performance.js';
import { bearing, distance, angleDiff, pointInPolygon, distanceToPolygon } from './geo.js';
import { activeSids, activeStars, sidLabel, compact, starTransferLevels } from './procedures.js';

const MIN_PAIR_NM = 110;
const CORRIDOR_NM = 9;         // punti FRA considerati lungo la rotta diretta
const POINT_SPACING_NM = 30;
const COP_SNAP_NM = 25;        // distanza massima fra attraversamento del confine e COP
const MAX_TURN_DEG = 50;
const SAMPLE_NM = 2;
export const MIN_INSIDE_NM = 25; // tratta minima nel volume per considerare il volo di competenza: chi taglia
                                 // solo un angolo del settore resta all'ente adiacente
export const LEVEL_BEFORE_NM = 8; // sui confini laterali il livello coordinato va raggiunto prima del confine
const VERTICAL_MARGIN_NM = 5;    // salita o discesa oltre il limite completata almeno così prima del confine laterale
const REACTION_NM = 2;           // tratto dopo l'ingresso prima che il controllore autorizzi salita o discesa
const STAR_PROFILE_MAX_FL = 250; // livello massimo sul punto iniziale della STAR nel profilo pianificato
const STAR_LEVEL_BEFORE_NM = 25; // il profilo raggiunge il livello della STAR così prima del punto iniziale
const STAR_BELOW_FL = 40;        // STAR con livello di trasferimento fino a tanto sotto il nostro limite: l'hand-off
                                 // avviene comunque sul punto iniziale, al livello più basso del settore
const NOMINAL_PERF = { speed: 1, climb: 1, descent: 1 };

// --- geometria di supporto --------------------------------------------------

function clipSegmentToRect(a, b, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks = [[-dx, a.x - r.xMin], [dx, r.xMax - a.x], [-dy, a.y - r.yMin], [dy, r.yMax - a.y]];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

function segmentPolygonParams(a, b, poly) {
  const ts = [];
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const c = poly[j];
    const d = poly[i];
    const sx = d.x - c.x;
    const sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
  }
  return ts.sort((p, q) => p - q);
}

function maxTurn(points) {
  let worst = { deg: 0, index: -1 };
  for (let i = 1; i < points.length - 1; i++) {
    const turn = Math.abs(angleDiff(bearing(points[i], points[i + 1]), bearing(points[i - 1], points[i])));
    if (turn > worst.deg) worst = { deg: turn, index: i };
  }
  return worst;
}

// Posizione sulla spezzata alla distanza s; leg = indice del tratto.
export function pointAlong(flow, s) {
  const { points, cum } = flow;
  const clamped = Math.max(0, Math.min(s, flow.total));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < clamped) i++;
  const len = cum[i + 1] - cum[i];
  const t = len === 0 ? 0 : (clamped - cum[i]) / len;
  return {
    x: points[i].x + (points[i + 1].x - points[i].x) * t,
    y: points[i].y + (points[i + 1].y - points[i].y) * t,
    leg: i,
  };
}

// --- costruzione dei flussi -------------------------------------------------

function distanceFactor(nm) {
  if (nm < 200) return 0.4;
  if (nm > 2500) return 0.45;
  return 1;
}

// I voli nazionali (Roma, Milano, Venezia e Bologna con Sicilia, Sardegna, Puglia e Calabria) sono una
// quota importante del traffico degli ACC italiani; seguono i voli fra l'Italia e l'estero.
function regionFactor(o, d) {
  const italian = (a) => a.icao.startsWith('LI');
  if (italian(o) && italian(d)) return 2.2;
  if (italian(o) || italian(d)) return 1.3;
  return 1;
}

function nearestCop(A, p, maxNm) {
  let best = null;
  let bestD = maxNm;
  for (const c of A.cops) {
    const d = distance(c, p);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

// Punto di collegamento FRA (D per le partenze, A per gli arrivi) coerente con la direzione del volo.
function connectingPoint(A, airport, track, typeLetter, outbound) {
  let best = null;
  let bestScore = Infinity;
  for (const w of A.waypoints) {
    if (!w.types.includes(typeLetter)) continue;
    const d = distance(w, airport);
    if (d < 12 || d > 65) continue;
    const dir = outbound ? bearing(airport, w) : bearing(w, airport);
    const off = Math.abs(angleDiff(dir, track));
    if (off > 55) continue;
    const score = off + d * 0.3;
    if (score < bestScore) {
      best = w;
      bestScore = score;
    }
  }
  return best;
}

// Lunghezza (NM) di una spezzata.
function pathLength(points) {
  let nm = 0;
  for (let i = 1; i < points.length; i++) nm += distance(points[i - 1], points[i]);
  return nm;
}

const SID_MAX_DETOUR = 0.35;  // allungamento massimo dovuto alla SID o alla STAR, in frazione della distanza diretta
const SID_MAX_TURN = 100;     // virata massima fra l'ultimo tratto della SID e la rotta verso la destinazione

// SID delle piste in uso che porta il volo verso la destinazione con il minor allungamento.
function chooseSid(A, o, d) {
  const direct = distance(o, d);
  let best = null;
  for (const sid of activeSids(o.icao)) {
    const pts = sid.fixes.map((id) => A.fix(id));
    if (pts.some((p) => !p)) continue;
    const exit = pts[pts.length - 1];
    const prev = pts.length > 1 ? pts[pts.length - 2] : o;
    if (Math.abs(angleDiff(bearing(exit, d), bearing(prev, exit))) > SID_MAX_TURN) continue;
    const detour = pathLength([o, ...pts]) + distance(exit, d) - direct;
    if (detour > SID_MAX_DETOUR * direct) continue;
    const score = detour + 0.2 * Math.abs(angleDiff(bearing(o, exit), bearing(o, d)));
    if (!best || score < best.score) best = { sid, points: pts, score };
  }
  return best;
}

// STAR delle piste in uso il cui punto iniziale è sulla strada per chi arriva da o. A parità di allungamento
// si preferiscono i punti iniziali lontani, sul bordo della TMA: le STAR che cominciano a ridosso
// dell'aeroporto (per esempio da un VOR del campo) servono a chi arriva già basso.
const STAR_FAR_BONUS = 0.5;   // NM di allungamento accettati per ogni NM di distanza del punto iniziale
const STAR_FAR_NM = 60;
function chooseStar(A, o, d) {
  const direct = distance(o, d);
  let best = null;
  for (const star of activeStars(d.icao)) {
    const pts = star.fixes.map((id) => A.fix(id));
    if (pts.some((p) => !p)) continue;
    const iaf = pts[0];
    const detour = distance(o, iaf) + distance(iaf, d) - direct;
    if (detour > SID_MAX_DETOUR * direct) continue;
    const score = detour - STAR_FAR_BONUS * Math.min(distance(iaf, d), STAR_FAR_NM);
    if (!best || score < best.score) best = { star, points: pts, score };
  }
  return best;
}

function buildFlow(A, o, d, viewClip) {
  const track = bearing(o, d);

  // SID e STAR degli aeroporti visibili; senza procedure, i punti di collegamento FRA (D e A) della carta
  const local = (ap) => ap.x >= A.view.xMin - 20 && ap.x <= A.view.xMax + 20 && ap.y >= A.view.yMin - 20 && ap.y <= A.view.yMax + 20;
  const sid = local(o) ? chooseSid(A, o, d) : null;
  const star = local(d) ? chooseStar(A, o, d) : null;
  const dep = !sid && local(o) ? connectingPoint(A, o, track, 'D', true) : null;
  const arr = !star && local(d) ? connectingPoint(A, d, track, 'A', false) : null;
  const head = sid ? sid.points : dep ? [dep] : [];
  const tail = star ? star.points : arr && arr !== dep ? [arr] : [];
  // tratto in rotta: dalla fine della SID all'inizio della STAR
  const a = head.length ? head[head.length - 1] : o;
  const b = tail.length ? tail[0] : d;

  const seq = [];
  const len = distance(a, b);
  if (len > 1) {
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const tOf = (p) => ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
    const off = (p) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
    const kept = []; // {w, t, fixed}

    // attraversamenti del settore sul tratto in rotta, agganciati ai COP pubblicati
    const crossings = segmentPolygonParams(a, b, A.polygon);
    let entryCop = null;
    let exitCop = null;
    if (crossings.length) {
      if (!pointInPolygon(a.x, a.y, A.polygon)) {
        const t = crossings[0];
        entryCop = nearestCop(A, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, COP_SNAP_NM);
      }
      if (!pointInPolygon(b.x, b.y, A.polygon)) {
        const t = crossings[crossings.length - 1];
        exitCop = nearestCop(A, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, COP_SNAP_NM);
      }
      if (entryCop && exitCop && entryCop === exitCop) exitCop = null;
    }
    for (const cop of [entryCop, exitCop]) {
      if (cop && cop !== a && cop !== b && tOf(cop) > 0 && tOf(cop) < 1) kept.push({ w: cop, t: tOf(cop), fixed: true });
    }

    // punti FRA sul tratto in rotta visibile, spaziati (anche dalla fine della SID e dall'inizio della STAR)
    const rect = { xMin: A.view.xMin - 10, xMax: A.view.xMax + 10, yMin: A.view.yMin - 10, yMax: A.view.yMax + 10 };
    const clip = clipSegmentToRect(a, b, rect);
    if (clip) {
      const tMin = Math.max(clip[0] - 60 / len, 0.002);
      const tMax = Math.min(clip[1] + 60 / len, 0.998);
      const corridor = A.waypoints
        .filter((w) => w !== a && w !== b && tOf(w) > tMin && tOf(w) < tMax && off(w) <= CORRIDOR_NM)
        .sort((p, q) => off(p) - off(q));
      for (const w of corridor) {
        if (kept.some((k) => k.w === w || distance(k.w, w) < POINT_SPACING_NM)) continue;
        if (distance(a, w) < POINT_SPACING_NM / 2 || distance(b, w) < POINT_SPACING_NM / 2) continue;
        kept.push({ w, t: tOf(w), fixed: false });
      }
    }
    seq.push(...kept.sort((p, q) => p.t - q.t));

    // elimina i punti che impongono virate troppo strette (mai i COP)
    let points = [a, ...seq.map((k) => k.w), b];
    for (let guard = 0; guard < 10; guard++) {
      const worst = maxTurn(points);
      if (worst.deg <= MAX_TURN_DEG) break;
      const item = seq[worst.index - 1];
      if (!item || item.fixed) {
        const removable = seq.findIndex((k, idx) => !k.fixed && Math.abs(idx + 1 - worst.index) <= 1);
        if (removable < 0) return null;
        seq.splice(removable, 1);
      } else {
        seq.splice(worst.index - 1, 1);
      }
      points = [a, ...seq.map((k) => k.w), b];
    }
    if (maxTurn(points).deg > MAX_TURN_DEG + 10) return null;
  }

  const points = [o];
  for (const p of [...head, ...seq.map((k) => k.w), ...tail, d]) {
    if (p !== points[points.length - 1]) points.push(p);
  }
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
  const total = cum[cum.length - 1];
  const sidIdx = sid ? points.indexOf(a) : -1;
  const starIdx = star ? points.lastIndexOf(b) : -1;

  // il volo interessa il settore se una tratta ne attraversa il confine o un punto vi cade dentro
  let crossesSector = points.some((p) => pointInPolygon(p.x, p.y, A.polygon));
  for (let i = 1; !crossesSector && i < points.length; i++) {
    crossesSector = segmentPolygonParams(points[i - 1], points[i], A.polygon).length > 0;
  }

  return {
    id: `${o.icao}-${d.icao}`,
    origin: o,
    destination: d,
    points,
    ids: points.map((p) => p.id ?? p.icao),
    cum,
    total,
    track,
    distanceNm: distance(o, d),
    viewIn: viewClip[0] * total,
    viewOut: viewClip[1] * total,
    arrivalPoint: b === d ? null : b.id,
    departurePoint: a === o ? null : a.id,
    // SID seguita (fino al punto finale, sidEndS lungo il flusso) e STAR (dal punto iniziale, starStartS)
    sid: sid ? { id: sid.sid.id, transition: sid.sid.transition ?? null, label: sidLabel(sid.sid), exit: a.id } : null,
    sidIdx,
    sidEndS: sid ? cum[sidIdx] : null,
    star: star ? {
      id: star.star.id, label: compact(star.star.id), iaf: b.id, levels: starTransferLevels(star.star, distance(b, d)),
    } : null,
    starIdx,
    starStartS: star ? cum[starIdx] : null,
    crossesSector,
    lastSpawn: -Infinity,
  };
}

export function buildFlows(A) {
  const rect = { xMin: A.view.xMin - 10, xMax: A.view.xMax + 10, yMin: A.view.yMin - 10, yMax: A.view.yMax + 10 };
  const flows = [];
  for (const o of A.airports) {
    for (const d of A.airports) {
      if (o === d) continue;
      const nm = distance(o, d);
      if (nm < MIN_PAIR_NM) continue;
      const clip = clipSegmentToRect(o, d, rect);
      if (!clip || (clip[1] - clip[0]) * nm < 30) continue;
      const flow = buildFlow(A, o, d, clip);
      if (!flow) continue;
      flow.weight = o.weight * d.weight * distanceFactor(nm) * regionFactor(o, d);
      flows.push(flow);
    }
  }
  return flows;
}

// --- piano di volo ----------------------------------------------------------

export function pickType(distanceNm) {
  const candidates = AIRCRAFT_TYPES.filter((t) => distanceNm >= t.range[0] && distanceNm <= t.range[1]);
  const list = candidates.length ? candidates : AIRCRAFT_TYPES.filter((t) => t.wake === 'M');
  let r = Math.random() * list.reduce((s, t) => s + t.weight, 0);
  return list.find((t) => (r -= t.weight) <= 0) ?? list[0];
}

// Livello di crociera tipico (FL) secondo la distanza fra i due aeroporti, come nei piani di volo reali dei
// collegamenti italiani ed europei: Roma-Napoli (115 NM) intorno a FL180, Roma-Pisa (150 NM) FL250, Roma-Bari
// (200 NM) FL300, Roma-Palermo (230 NM) FL330, Roma-Milano (260-300 NM) FL350-360, oltre le 400 NM FL370-390.
const TYPICAL_RFL = [[110, 180], [150, 250], [200, 300], [250, 340], [300, 360], [400, 370], [600, 380], [1000, 390]];

export function typicalRfl(nm) {
  if (nm <= TYPICAL_RFL[0][0]) return TYPICAL_RFL[0][1];
  for (let i = 1; i < TYPICAL_RFL.length; i++) {
    const [d1, f1] = TYPICAL_RFL[i];
    if (nm <= d1) {
      const [d0, f0] = TYPICAL_RFL[i - 1];
      return f0 + ((f1 - f0) * (nm - d0)) / (d1 - d0);
    }
  }
  return TYPICAL_RFL[TYPICAL_RFL.length - 1][1];
}

// Livelli di crociera richiesti (RFL) plausibili: attorno al livello tipico della tratta (da 40 FL sotto a
// 20 sopra), secondo la semicircolare italiana, entro la tangenza del tipo e con almeno un breve tratto di
// crociera (il 10% della rotta) fra salita e discesa. I turboelica restano sotto la loro tangenza.
export function requestedLevels(flow, type) {
  const perf = performanceOf(type);
  const ceiling = Math.min(type.engine === 'jet' ? type.maxFL - 10 : type.maxFL, 410);
  const typical = typicalRfl(flow.distanceNm);
  let top = Math.min(ceiling, typical + 20);
  while (top > 90 && perf.climbDistance(top * 100) + perf.descentDistance(top * 100) > 0.9 * flow.total) top -= 10;
  const bottom = Math.max(90, Math.min(top, typical) - 40);
  return levelsForTrack(flow.track, bottom, top);
}

// Profilo verticale pianificato: salita dal decollo e discesa verso l'aeroporto di destinazione
// con le distanze del tipo di aeromobile, crociera al livello richiesto. Con una STAR la discesa è
// pianificata per arrivare al livello di trasferimento nominale STAR_LEVEL_BEFORE_NM prima del punto iniziale
// (i settori superiori fanno scendere il volo in tempo, il settore basso lo riceve livellato o quasi) e da lì
// prosegue lungo la STAR.
export function makeProfile(flow, type, cruiseFL) {
  const perf = performanceOf(type);
  let star = null;
  if (flow.star) {
    const { min, max } = flow.star.levels;
    const ft = Math.max(min, Math.min(max, STAR_PROFILE_MAX_FL)) * 100;
    star = { s: flow.starStartS - STAR_LEVEL_BEFORE_NM, ft, d0: perf.descentDistance(ft) };
  }
  return { type, perf, cruiseFt: cruiseFL * 100, total: flow.total, star };
}

export function profileAltitude(profile, s) {
  const { perf, star } = profile;
  const alt = Math.min(profile.cruiseFt, perf.climbAltitude(s), perf.descentAltitude(profile.total - s));
  if (!star) return alt;
  return Math.min(alt, s < star.s ? perf.descentAltitude(star.d0 + star.s - s) : star.ft);
}

export function profilePhase(profile, s) {
  const now = profileAltitude(profile, s);
  const next = profileAltitude(profile, s + 1);
  if (next > now + 20) return 'climb';
  if (next < now - 20) return 'descent';
  return 'cruise';
}

export function profileSpeed(profile, s) {
  return scheduleSpeed(profile.type, profileAltitude(profile, s), profilePhase(profile, s));
}

// Distanza lungo il profilo a cui il volo si trova `seconds` secondi prima di s1.
export function distanceBefore(profile, s1, seconds) {
  let s = s1;
  let t = 0;
  while (s > 0) {
    const step = Math.min(2, s);
    const dt = (step / profileSpeed(profile, s - step / 2)) * 3600;
    if (t + dt >= seconds) return s - ((seconds - t) / dt) * step;
    t += dt;
    s -= step;
  }
  return 0;
}

// Tempo di volo (s) lungo il profilo fra le distanze s0 e s1.
export function profileTime(profile, s0, s1) {
  let t = 0;
  for (let s = s0; s < s1; s += 2) {
    const step = Math.min(2, s1 - s);
    t += (step / profileSpeed(profile, s + step / 2)) * 3600;
  }
  return t;
}


// Probabilità che un volo del flusso entri davvero nel volume del settore (e non solo lateralmente):
// calcolata una volta per flusso con i tipi più comuni e i livelli di crociera estremi e intermedio.
export function volumeEligibility(A, flow) {
  const types = AIRCRAFT_TYPES.filter((t) => flow.distanceNm >= t.range[0] && flow.distanceNm <= t.range[1])
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  const sStart = flow.origin.x >= A.view.xMin - 5 && flow.origin.x <= A.view.xMax + 5
    && flow.origin.y >= A.view.yMin - 5 && flow.origin.y <= A.view.yMax + 5 ? 5 : flow.viewIn;
  let hits = 0;
  let trials = 0;
  for (const type of types) {
    const levels = requestedLevels(flow, type);
    if (!levels.length) continue;
    for (const fl of new Set([levels[0], levels[Math.floor(levels.length / 2)], levels[levels.length - 1]])) {
      trials++;
      const profile = makeProfile(flow, type, fl);
      const passage = sectorPassage(A, flow, profile, sStart);
      if (!passage || passage.insideNm < MIN_INSIDE_NM || passageReenters(A, flow, profile, passage)) continue;
      if (resolveExit(A, flow, profile, passage, NOMINAL_PERF, entryStart(A, passage))) hits++;
    }
  }
  return trials ? hits / trials : 0;
}

// Attraversamento del volume del settore lungo il piano a partire da sStart.
// Uscita laterale breve: il volo taglia una rientranza del confine e rientra entro EXCURSION_MAX_NM. In
// realtà il settore lo tiene (lo coordina con l'adiacente) e non lo passa per un minuto: restituisce la
// distanza del rientro, oppure null se il volo non rientra così presto.
export const EXCURSION_MAX_NM = 15;

function excursionEnd(A, flow, profile, fromS) {
  const end = Math.min(fromS + EXCURSION_MAX_NM, flow.viewOut + 5, flow.total);
  for (let s = fromS + SAMPLE_NM; s <= end; s += SAMPLE_NM) {
    const p = pointAlong(flow, s);
    const alt = profileAltitude(profile, s);
    if (alt >= A.floorFt && alt < A.ceilingFt && pointInPolygon(p.x, p.y, A.polygon)) return s;
  }
  return null;
}

export function sectorPassage(A, flow, profile, sStart) {
  const { floorFt, ceilingFt } = A;
  const end = Math.min(flow.viewOut + 5, flow.total);
  let prevLateral = null;
  let prevAlt = null;
  let entry = null;
  for (let s = sStart; s <= end; s += SAMPLE_NM) {
    const p = pointAlong(flow, s);
    const lateral = pointInPolygon(p.x, p.y, A.polygon);
    const alt = profileAltitude(profile, s);
    const inside = lateral && alt >= floorFt && alt < ceilingFt;
    if (!entry && inside) {
      let kind = 'inside';
      if (prevLateral !== null) kind = !prevLateral ? 'lateral' : alt > prevAlt ? 'below' : 'above';
      entry = { s, kind, point: p, alt };
    } else if (entry && !inside) {
      const kind = !lateral ? 'lateral' : alt >= ceilingFt ? 'top' : 'bottom';
      // breve uscita da una rientranza del confine seguita da un rientro: il settore tiene il volo
      const back = kind === 'lateral' ? excursionEnd(A, flow, profile, s) : null;
      if (back !== null) {
        s = back - SAMPLE_NM;
        prevLateral = true;
        prevAlt = alt;
        continue;
      }
      return sidEntry(A, flow, { entry, exit: { s, kind, point: p, alt }, insideNm: s - entry.s });
    }
    prevLateral = lateral;
    prevAlt = alt;
  }
  if (!entry) return null;
  const p = pointAlong(flow, end);
  return sidEntry(A, flow, {
    entry, exit: { s: end, kind: 'lateral', point: p, alt: profileAltitude(profile, end) }, insideNm: end - entry.s,
  });
}

// Sotto il settore, nel punto p, c'è l'avvicinamento e non un altro settore dell'ACC.
function approachBelow(A, p) {
  return !A.sectorsXY.some((x) => x.id !== A.sector.id && x.floorFL < A.sector.floorFL
    && pointInPolygon(p.x, p.y, x.polygonXY));
}

// Partenza che sale nel settore dall'avvicinamento sottostante: l'avvicinamento la consegna sul punto finale
// della SID (tenendola sotto il nostro limite inferiore fino a lì), non dove il profilo attraversa il limite.
function sidEntry(A, flow, passage) {
  if (!flow.sid || passage.entry.kind !== 'below') return passage;
  const s = flow.sidEndS;
  const fix = flow.points[flow.sidIdx];
  if (s <= passage.entry.s || s >= passage.exit.s - MIN_INSIDE_NM) return passage;
  if (!pointInPolygon(fix.x, fix.y, A.polygon) || !approachBelow(A, fix)) return passage;
  const entry = { ...passage.entry, s, point: pointAlong(flow, s), fix: fix.id };
  return { ...passage, entry, insideNm: passage.exit.s - s, floorEntry: passage.entry };
}

// Arrivo verso un aeroporto sotto il settore con il punto iniziale della STAR nel settore: l'hand-off
// all'avvicinamento avviene su quel punto, al livello di trasferimento della STAR (uscita 'star'), non mentre
// il volo si avvicina al limite inferiore. undefined: regola non applicabile; null: volo non assegnabile.
function starExit(A, flow, profile, passage, perf, start) {
  if (!flow.star) return undefined;
  const { exit } = passage;
  const s = flow.starStartS;
  const iaf = flow.points[flow.starIdx];
  if (!pointInPolygon(iaf.x, iaf.y, A.polygon) || !approachBelow(A, iaf)) return undefined;
  if (exit.kind === 'top' || (exit.kind === 'lateral' && exit.s < s - SAMPLE_NM)) return undefined;
  const lo = Math.ceil(A.sector.floorFL / 10) * 10;
  const hi = Math.floor((A.sector.ceilingFL - 5) / 10) * 10;
  const { min, max } = flow.star.levels;
  if (min > hi || max < lo - STAR_BELOW_FL) return undefined; // livello della STAR di un altro settore
  // livello di trasferimento: il più vicino al nostro limite inferiore che la STAR consente (limite FL105 ->
  // FL110), mai più alto di quello a cui il volo ci viene consegnato (una STAR non si percorre in salita)
  const bottom = Math.ceil((A.sector.floorFL + 5) / 10) * 10;
  let fl = Math.min(Math.max(bottom, min), Math.min(max, hi));
  fl = Math.max(lo, Math.min(fl, Math.floor(start.ft / 1000) * 10));
  if (s - passage.entry.s < MIN_INSIDE_NM) return null;
  // fino al punto iniziale il volo deve restare nel settore: niente angoli tagliati fuori e poi rientri, salvo
  // le brevi uscite da una rientranza del confine (vedi excursionEnd)
  let outside = 0;
  for (let x = passage.entry.s + SAMPLE_NM; x < s; x += SAMPLE_NM) {
    const p = pointAlong(flow, x);
    outside = pointInPolygon(p.x, p.y, A.polygon) ? 0 : outside + SAMPLE_NM;
    if (outside > EXCURSION_MAX_NM) return null;
  }
  if (start.s + verticalDistance(profile.type, perf, start.ft, fl * 100) > s - SAMPLE_NM) return null;
  return {
    ...passage,
    exit: { s, kind: 'star', point: pointAlong(flow, s), alt: fl * 100, fix: iaf.id },
    lateralS: s,
  };
}

// Il volo rientra nel volume dopo esserne uscito (confini con rientranze, oppure salita oltre il limite
// superiore seguita da una discesa)? Un volo così verrebbe trasferito e tornerebbe nel settore senza essere
// più in contatto: non viene assegnato al settore.
// Un secondo passaggio così breve non conta: è un volo che, già passato all'ente successivo (di solito
// l'avvicinamento, in discesa verso l'aeroporto), sfiora di nuovo un angolo del nostro volume.
const REENTRY_MIN_NM = 10;

export function passageReenters(A, flow, profile, passage) {
  const end = Math.min(flow.viewOut + 5, flow.total);
  let inside = 0;
  for (let s = passage.exit.s + SAMPLE_NM; s <= end; s += SAMPLE_NM) {
    const p = pointAlong(flow, s);
    const alt = profileAltitude(profile, s);
    if (alt >= A.floorFt && alt < A.ceilingFt && pointInPolygon(p.x, p.y, A.polygon)) {
      inside += SAMPLE_NM;
      if (inside >= REENTRY_MIN_NM) return true;
    } else {
      inside = 0;
    }
  }
  return false;
}

// Distanza lungo il confine laterale: primo campione fuori dal poligono del settore dopo fromS.
function lateralExitS(A, flow, fromS) {
  const end = Math.min(flow.viewOut + 5, flow.total);
  for (let s = fromS; s <= end; s += SAMPLE_NM) {
    const p = pointAlong(flow, s);
    if (!pointInPolygon(p.x, p.y, A.polygon)) return s;
  }
  return end;
}

// Distanza (NM) per salire o scendere da fromFt a toFt con i ratei e le velocità del singolo aereo, come fa
// un volo autorizzato subito al livello (più rapido del profilo pianificato, che usa ratei ridotti).
export function verticalDistance(type, perf, fromFt, toFt) {
  const up = toFt > fromFt;
  let nm = 0;
  for (let ft = fromFt; up ? ft < toFt : ft > toFt;) {
    const dh = Math.min(500, Math.abs(toFt - ft));
    const mid = ft + (up ? dh : -dh) / 2;
    const fpm = up ? climbRate(type, mid) * perf.climb : descentRate(type, mid) * perf.descent;
    const kt = scheduleSpeed(type, mid, up ? 'climb' : 'descent') * perf.speed;
    nm += ((dh / fpm) * kt) / 60;
    ft += up ? dh : -dh;
  }
  return nm;
}

// Da dove il controllore può far salire o scendere il volo: poco dopo l'ingresso, dal livello coordinato
// (l'ente inferiore o superiore lo tiene appena fuori dal nostro volume).
export function entryStart(A, passage) {
  const { entry } = passage;
  const ft = entry.kind === 'below' ? A.floorFt - 1000 : entry.kind === 'above' ? A.ceilingFt + 1000 : entry.alt;
  return { s: entry.s + REACTION_NM, ft };
}

// Uscita dal settore dettata dal livello finale del volo e dai limiti verticali del settore:
// - in discesa verso un aeroporto la cui STAR comincia nel settore, con l'avvicinamento sotto: passa
//   all'avvicinamento sul punto iniziale della STAR, al livello di trasferimento (uscita 'star', starExit);
// - in salita verso un livello di crociera oltre il limite superiore: passa al settore superiore mentre si
//   avvicina al limite (uscita 'top'), non su un punto di rotta;
// - in discesa verso l'aeroporto di destinazione: passa al settore inferiore o all'avvicinamento mentre si
//   avvicina al limite inferiore (uscita 'bottom');
// - livellato (in crociera, oppure al livello di crociera raggiunto dentro il settore): esce lateralmente su un
//   punto di rotta, al livello di crociera (levelFt);
// - in discesa verso una STAR che comincia nel settore adiacente dello stesso strato (con l'avvicinamento sotto
//   entrambi): esce lateralmente sul COP, livellato al livello coordinato.
// Il profilo pianificato può arrivare al confine laterale ancora in salita o in discesa: il volo resta nostro
// solo se, autorizzato subito dopo l'ingresso (start), completa la salita o la discesa prima del confine.
// Restituisce il passaggio con l'uscita effettiva e lateralS (distanza del confine laterale), oppure null.
export function resolveExit(A, flow, profile, passage, perf, start) {
  const star = starExit(A, flow, profile, passage, perf, start);
  if (star !== undefined) return star;
  const { exit } = passage;
  if (exit.kind !== 'lateral') {
    const lateralS = lateralExitS(A, flow, exit.s);
    // partenza consegnata sul punto finale della SID: comincia a salire da lì, più tardi di quanto dica il
    // profilo pianificato; deve comunque passare il limite superiore prima del confine laterale
    if (exit.kind === 'top' && passage.entry.fix) {
      const s = start.s + verticalDistance(profile.type, perf, start.ft, A.ceilingFt + 500);
      if (s > lateralS - VERTICAL_MARGIN_NM) {
        // non ce la farebbe: l'avvicinamento la consegna prima, dove il profilo attraversa il nostro limite
        const fallback = { ...passage, entry: passage.floorEntry, insideNm: exit.s - passage.floorEntry.s, floorEntry: null };
        const fromEntry = start.s <= passage.entry.s + REACTION_NM + 0.01;
        return resolveExit(A, flow, profile, fallback, perf, fromEntry ? entryStart(A, fallback) : start);
      }
      return { ...passage, exit: { ...exit, s: Math.max(s, exit.s), point: pointAlong(flow, Math.max(s, exit.s)) }, lateralS };
    }
    return { ...passage, lateralS };
  }
  const lateralS = exit.s;
  const phase = profilePhase(profile, Math.max(start.s, exit.s - LEVEL_BEFORE_NM));
  const vertical = (kind, targetFt) => {
    const s = start.s + verticalDistance(profile.type, perf, start.ft, targetFt);
    if (s > lateralS - VERTICAL_MARGIN_NM) return null;
    return { ...passage, exit: { s, kind, point: pointAlong(flow, s), alt: targetFt }, lateralS };
  };
  if (phase === 'climb' && profile.cruiseFt >= A.ceilingFt) return vertical('top', A.ceilingFt + 500);
  if (phase === 'descent' && flow.star && flow.starStartS > lateralS && approachBelow(A, exit.point)) {
    // arrivo la cui STAR comincia nel settore adiacente dello stesso strato: esce livellato sul COP, al livello
    // che il profilo ha poco prima del confine (mai più alto di quello a cui ci è stato consegnato)
    const levelFt = Math.min(start.ft, Math.max(A.floorFt + 500, profileAltitude(profile, lateralS - LEVEL_BEFORE_NM)));
    if (start.s + verticalDistance(profile.type, perf, start.ft, levelFt) > lateralS - LEVEL_BEFORE_NM) return null;
    return { ...passage, exit: { ...exit, levelFt }, lateralS };
  }
  if (phase === 'descent') return vertical('bottom', A.floorFt - 500);
  if (phase === 'climb') {
    // livello di crociera dentro il settore: lo raggiunge e poi esce livellato
    const s = start.s + verticalDistance(profile.type, perf, start.ft, profile.cruiseFt);
    if (s > lateralS - LEVEL_BEFORE_NM) return null;
    return { ...passage, exit: { ...exit, levelFt: profile.cruiseFt }, lateralS };
  }
  return { ...passage, lateralS };
}
