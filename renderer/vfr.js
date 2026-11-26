// Traffico VFR (squawk 7000) sotto e attorno al settore: aviazione generale che vola a vista fra aviosuperfici e
// aeroporti, o resta in zona per un volo locale. È solo un arricchimento del radar: non è mai di nostra competenza,
// non entra nel calcolo della separazione e sul radar ne restano il nominativo, la quota (Mode C) e la velocità al
// suolo.
//
// Il nominativo è la marca di immatricolazione, fittizia ma secondo le regole (scritta senza trattino, come la
// trasmette il Mode S e come si scrive nel piano di volo): in Italia I- e quattro lettere (I-ABCD); gli ultraleggeri
// (VDS) I- e quattro caratteri, cifre o una lettera e tre cifre (I-8361, I-C726). Vicino ai confini del nord qualche
// velivolo straniero: Germania D-E e tre lettere, Francia F-G, Svizzera HB-, Austria OE-K.
//
// Quote e velocità sono quelle vere dell'aviazione generale: ultraleggeri ed elicotteri bassi (1500-3000 ft), gli
// altri ai livelli VFR semicircolari sopra i 3000 ft (rotta 000-179: migliaia dispari + 500 ft, 3500, 5500...;
// 180-359: pari + 500 ft, 4500, 6500...), quasi sempre fra 3500 e 7500 ft; salite e discese a 500 ft/min.
// Volano di giorno: la sera (e di notte) se ne vedono sempre meno.
import { airspace, inView } from './airspace.js';
import { normalizeDeg, angleDiff, bearing, distance, pointInPolygon } from './geo.js';

// velocità al suolo (kt), quota massima tipica (ft) e peso nel traffico
const TYPES = [
  { kind: 'ulm', gs: [70, 95], low: true, ulm: true, weight: 3 },
  { kind: 'c172', gs: [98, 115], ceiling: 9500, weight: 5 },
  { kind: 'pa28', gs: [105, 125], ceiling: 9500, weight: 3 },
  { kind: 'da40', gs: [115, 135], ceiling: 10500, weight: 2 },
  { kind: 'sr22', gs: [155, 180], ceiling: 11500, weight: 1 },
  { kind: 'heli', gs: [95, 125], low: true, weight: 1 },
];
const LEVEL_WEIGHTS = [[3500, 5], [4500, 5], [5500, 4], [6500, 3], [7500, 2], [8500, 1], [9500, 1], [10500, 0.4], [11500, 0.2]];
const FOREIGN = [['DE', 3], ['FG', 3], ['HB', 3], ['OEK', 2]]; // prefisso senza trattino, completato a 5 caratteri
const NORTH_LAT = 45;                       // sopra questa latitudine (Alpi, pianura padana) più stranieri
const LETTERS = 'ABCDEFGHIJKLMNOPRSTUVWXYZ'; // niente Q: i gruppi Q sono codici radio
const DAY_UTC = [6.5 * 3600, 16.5 * 3600]; // fascia con traffico VFR pieno
const DUSK_S = 3600;                        // dopo, nell'ora successiva, si spegne
const TRAIL_S = 12;                         // come le tracce radar (sim.js HISTORY_S)
const TRAIL_MAX = 8;
const VS_FPM = 500;
const TURN_DEG_S = 3;                       // virata standard
const SPAWN_MARGIN_NM = 25;                 // nascono e spariscono appena fuori dalla vista

// Generatore casuale proprio: i VFR non devono cambiare la sequenza del traffico IFR (né le misure del banco di
// prova, che fissa Math.random).
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Isole (coste chiuse abbastanza grandi): un VFR non attraversa il mare fra un'isola e la terraferma.
function islandOf(p) {
  for (let i = 0; i < airspace.coast.length; i++) {
    const line = airspace.coast[i];
    if (line.length < 20) continue;
    const a = line[0];
    const b = line[line.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) > 1) continue;
    if (pointInPolygon(p.x, p.y, line)) return i;
  }
  return -1;
}

export class VfrTraffic {
  constructor(seed = Date.now()) {
    this.rnd = makeRng(seed);
    this.flights = [];
    this.target = 4 + Math.floor(this.rnd() * 4); // 4-7 in vista di giorno
    this._spawnTimer = 0;
    this._id = 0;
  }

  _pick(list, weightOf) {
    let r = this.rnd() * list.reduce((s, x) => s + weightOf(x), 0);
    return list.find((x) => (r -= weightOf(x)) <= 0) ?? list[0];
  }

  _between(lo, hi) {
    return lo + this.rnd() * (hi - lo);
  }

  // Punto vicino a un aeroporto (aviosuperfici e campi di volo minori attorno ai grandi aeroporti).
  _field(ap) {
    const r = this._between(4, 18);
    const a = this.rnd() * Math.PI * 2;
    return { x: ap.x + Math.sin(a) * r, y: ap.y - Math.cos(a) * r };
  }

  _letter() {
    return LETTERS[Math.floor(this.rnd() * LETTERS.length)];
  }

  _digit(from = 0) {
    return String(from + Math.floor(this.rnd() * (10 - from)));
  }

  // Marca fittizia secondo le regole di immatricolazione (vedi in testa), diversa da quelle già in vista.
  _registration(type, lat) {
    for (let attempt = 0; attempt < 20; attempt++) {
      let reg;
      const foreign = this.rnd() < (lat >= NORTH_LAT ? 0.15 : 0.04);
      if (foreign && !type.ulm) {
        const prefix = this._pick(FOREIGN, (f) => f[1])[0];
        reg = prefix;
        while (reg.length < 5) reg += this._letter();
      } else if (type.ulm) {
        reg = this.rnd() < 0.6
          ? `I${this._digit(1)}${this._digit()}${this._digit()}${this._digit()}`
          : `I${this._letter()}${this._digit()}${this._digit()}${this._digit()}`;
      } else {
        reg = `I${this._letter()}${this._letter()}${this._letter()}${this._letter()}`;
      }
      if (!this.flights.some((f) => f.callsign === reg)) return reg;
    }
    return null;
  }

  // Quota di crociera: livello VFR semicircolare per la rotta, oppure bassa per ultraleggeri ed elicotteri.
  _cruise(type, track) {
    if (type.low) return Math.round(this._between(1500, 3000) / 100) * 100;
    const east = normalizeDeg(track) < 180;
    const levels = LEVEL_WEIGHTS.filter(([ft]) => ft <= type.ceiling && (Math.round((ft - 500) / 1000) % 2 === 1) === east);
    return this._pick(levels, (l) => l[1])[0];
  }

  // Piano: trasferimento verso un altro campo (fino a ~110 NM) oppure volo locale che torna al campo di partenza.
  _plan() {
    const airports = airspace.airports.filter((ap) => inView(ap, 40));
    if (!airports.length) return null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const from = airports[Math.floor(this.rnd() * airports.length)];
      const start = this._field(from);
      let points;
      if (this.rnd() < 0.35) {
        // volo locale: due o tre punti in zona, poi rientro
        points = [];
        let p = start;
        for (let k = 0, n = 2 + Math.floor(this.rnd() * 2); k < n; k++) {
          const a = this.rnd() * Math.PI * 2;
          const r = this._between(8, 22);
          p = { x: start.x + Math.sin(a) * r, y: start.y - Math.cos(a) * r };
          points.push(p);
        }
        points.push(start);
      } else {
        const dests = airports.filter((ap) => ap !== from && distance(ap, from) >= 25 && distance(ap, from) <= 110);
        if (!dests.length) continue;
        const end = this._field(dests[Math.floor(this.rnd() * dests.length)]);
        if (islandOf(start) !== islandOf(end)) continue;
        points = [end];
      }
      return { start, points };
    }
    return null;
  }

  // midway: già in volo in un punto qualsiasi del percorso (avvio della sessione).
  _spawn(midway) {
    const plan = this._plan();
    if (!plan) return null;
    const type = this._pick(TYPES, (t) => t.weight);
    const track = bearing(plan.start, plan.points[0]);
    const cruise = this._cruise(type, track);
    const { lat } = airspace.projection.toLatLon(plan.start.x, plan.start.y);
    const f = {
      id: `vfr-${++this._id}`,   // distinto dagli id dei voli IFR (hover, posizione della label)
      vfr: true,
      control: 'vfr',
      // label come quella degli altri voli: posizione, rotazione con un clic sulla traccia, trascinamento
      tagOffset: { x: 30, y: -30 },
      tagAngle: 45,
      selected: false,
      showVector: false,
      callsign: this._registration(type, lat),
      type,
      x: plan.start.x,
      y: plan.start.y,
      heading: track,
      speed: Math.round(this._between(...type.gs)),
      altitude: 1000,
      flightLevel: 10,
      cruise,
      points: plan.points,
      trail: [],
      _trailTimer: 0,
      _wobble: 0,
    };
    if (midway) {
      const to = plan.points[0];
      const k = this._between(0.15, 0.85);
      f.x += (to.x - f.x) * k;
      f.y += (to.y - f.y) * k;
      f.altitude = cruise;
      f.flightLevel = Math.round(cruise / 100);
    }
    if (!inView(f, SPAWN_MARGIN_NM)) return null;
    const back = (f.speed / 3600) * TRAIL_S;
    const rad = (f.heading * Math.PI) / 180;
    for (let k = TRAIL_MAX; k >= 1; k--) f.trail.push({ x: f.x - Math.sin(rad) * back * k, y: f.y + Math.cos(rad) * back * k });
    this.flights.push(f);
    return f;
  }

  // Quanti VFR ci devono essere all'ora (UTC) data.
  _targetAt(clockS) {
    const t = ((clockS % 86400) + 86400) % 86400;
    if (t >= DAY_UTC[0] && t <= DAY_UTC[1]) return this.target;
    if (t > DAY_UTC[1] && t < DAY_UTC[1] + DUSK_S) return Math.round(this.target * (1 - (t - DAY_UTC[1]) / DUSK_S));
    return 0;
  }

  seed(clockS) {
    const n = this._targetAt(clockS);
    for (let i = 0; i < n * 4 && this.flights.length < n; i++) this._spawn(true);
  }

  tick(dt, clockS) {
    for (const f of this.flights) this._step(f, dt);
    this.flights = this.flights.filter((f) => !f.done && inView(f, SPAWN_MARGIN_NM + 5));
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = this._between(60, 240);
      if (this.flights.length < this._targetAt(clockS)) this._spawn(false);
    }
  }

  _step(f, dt) {
    const to = f.points[0];
    const d = distance(f, to);
    const last = f.points.length === 1;
    if (d < 1.5) {
      if (last) {
        f.done = true;
        return;
      }
      f.points.shift();
      // nuovo tratto: livello VFR coerente con la nuova rotta
      if (!f.type.low) f.cruise = this._cruise(f.type, bearing(f, f.points[0]));
    }
    const diff = angleDiff(bearing(f, f.points[0]), f.heading);
    f.heading = normalizeDeg(f.heading + Math.max(-TURN_DEG_S * dt, Math.min(TURN_DEG_S * dt, diff)));

    // discesa verso il campo d'arrivo: inizia così prima da arrivare a 1500 ft sul campo
    const descentNm = ((Math.max(0, f.altitude - 1500) / VS_FPM) / 60) * f.speed;
    const target = last && d < descentNm + 2 ? 1500 : f.cruise;
    const step = (VS_FPM / 60) * dt;
    if (Math.abs(target - f.altitude) > step) f.altitude += Math.sign(target - f.altitude) * step;
    else {
      // in crociera a vista la quota oscilla di qualche decina di piedi
      f._wobble = Math.max(-80, Math.min(80, f._wobble + (this.rnd() - 0.5) * 12 * Math.sqrt(dt)));
      f.altitude = target + f._wobble;
    }

    f.flightLevel = Math.round(f.altitude / 100);

    const nm = (f.speed / 3600) * dt;
    const rad = (f.heading * Math.PI) / 180;
    f.x += Math.sin(rad) * nm;
    f.y -= Math.cos(rad) * nm;
    f._trailTimer += dt;
    if (f._trailTimer >= TRAIL_S) {
      f._trailTimer -= TRAIL_S;
      f.trail.push({ x: f.x, y: f.y });
      if (f.trail.length > TRAIL_MAX) f.trail.shift();
    }
  }
}
