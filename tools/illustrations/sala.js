// Scene illustrate della sala radar, per il sito.
//
// Ogni scena è composta in HTML/SVG: stanza sullo sfondo (sfocata), postazioni con i monitor, persone
// viste di spalle illuminate dagli schermi, e sopra bagliore, foschia e grana. Sui monitor ci sono le
// schermate vere del simulatore (docs/*.png), proiettate in prospettiva.
//
// sala.html?scena=turno|ascolto|sala  — la apre e la salva tools/illustrations.mjs.

const NS = 'http://www.w3.org/2000/svg';
const SHOTS = {
  radar: '../../docs/radar.png',
  tutorial: '../../docs/tutorial.png',
  start: '../../docs/schermata-iniziale.png',
};
const SHOT_W = 1470;
const SHOT_H = 820;

// generatore pseudo-casuale con seme: la stessa scena esce sempre uguale
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

function el(tag, attrs = {}, parent) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

function sv(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function layer(parent, style = {}) {
  return el('div', { class: 'layer', style }, parent);
}

function svgLayer(parent, w, h) {
  return sv('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` }, parent);
}

const pts = (q) => q.map((p) => p.join(',')).join(' ');

// --- prospettiva
// la stessa proiezione come funzione (u, v) ∈ [0,1]² → punto sullo schermo
function quadMap(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return (u, v) => {
    const wq = g * u + h * v + 1;
    return [(a * u + b * v + x0) / wq, (d * u + e * v + y0) / wq];
  };
}

// disegna un ritaglio dell'immagine dentro il quadrilatero: griglia di triangoli, ognuno affine
function drawQuad(c, img, [sx, sy, sw, sh], q, n = 24) {
  const map = quadMap(q);
  const tri = (s0, s1, s2, d0, d1, d2) => {
    c.save();
    c.beginPath();
    // un filo più grande, per non lasciare righe fra i triangoli
    const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
    const ex = (p) => [p[0] + (p[0] - cx) * 0.03, p[1] + (p[1] - cy) * 0.03];
    const [e0, e1, e2] = [ex(d0), ex(d1), ex(d2)];
    c.moveTo(...e0); c.lineTo(...e1); c.lineTo(...e2); c.closePath();
    c.clip();
    const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    const m11 = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
    const m12 = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
    const m21 = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
    const m22 = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
    const dx = d0[0] - m11 * s0[0] - m21 * s0[1];
    const dy = d0[1] - m12 * s0[0] - m22 * s0[1];
    c.setTransform(m11, m12, m21, m22, dx, dy);
    c.drawImage(img, 0, 0);
    c.restore();
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n;
      const S = (u, v) => [sx + u * sw, sy + v * sh];
      tri(S(u0, v0), S(u1, v0), S(u1, v1), map(u0, v0), map(u1, v0), map(u1, v1));
      tri(S(u0, v0), S(u1, v1), S(u0, v1), map(u0, v0), map(u1, v1), map(u0, v1));
    }
  }
}

// allarga un quadrilatero di `m` pixel verso l'esterno (cornice del monitor)
function grow(q, m) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4;
  const cy = q.reduce((s, p) => s + p[1], 0) / 4;
  return q.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy);
    return [x + (dx / l) * m * 1.25, y + (dy / l) * m];
  });
}

// un monitor: cornice scura con il bordo superiore illuminato, e la schermata del simulatore
function monitor(ctx, q, { shot = 'radar', crop = [0, 0, SHOT_W, SHOT_H], bezel = 10, bright = 1, stand = true } = {}) {
  const { under: svgBack, screens } = ctx.cur;
  const outer = grow(q, bezel);
  if (stand) {
    const bx = (q[2][0] + q[3][0]) / 2, by = (q[2][1] + q[3][1]) / 2;
    const sw = Math.abs(q[2][0] - q[3][0]) * 0.12, sh = bezel * 4;
    sv('rect', { x: bx - sw / 2, y: by, width: sw, height: sh, fill: '#05090d' }, svgBack);
  }
  sv('polygon', { points: pts(outer), fill: '#070b10', stroke: 'rgba(140, 200, 220, 0.22)', 'stroke-width': 1 }, svgBack);
  const c = screens.getContext('2d');
  c.save();
  c.filter = `brightness(${bright}) saturate(1.15)`;
  drawQuad(c, IMAGES[shot], crop, q, Math.max(4, Math.min(24, Math.round(Math.abs(q[1][0] - q[0][0]) / 30))));
  c.restore();
  // riflesso del vetro
  c.save();
  c.beginPath();
  q.forEach((p, k) => (k ? c.lineTo(...p) : c.moveTo(...p)));
  c.closePath();
  const gl = c.createLinearGradient(q[0][0], q[0][1], q[2][0], q[2][1]);
  gl.addColorStop(0, 'rgba(255,255,255,0.07)');
  gl.addColorStop(0.38, 'rgba(255,255,255,0)');
  gl.addColorStop(0.7, 'rgba(120,200,255,0.03)');
  gl.addColorStop(1, 'rgba(0,0,0,0.25)');
  c.fillStyle = gl;
  c.fill();
  c.restore();
}

// luce diffusa (alone ellittico che si somma alla scena)
function glow(parent, x, y, rx, ry, color, alpha) {
  el('div', {
    class: 'abs',
    style: {
      left: `${x - rx}px`, top: `${y - ry}px`, width: `${rx * 2}px`, height: `${ry * 2}px`,
      background: `radial-gradient(closest-side, ${color.replace('A', alpha)}, ${color.replace('A', alpha * 0.35)} 55%, ${color.replace('A', 0)})`,
      mixBlendMode: 'screen',
    },
  }, parent);
}

// --- persone viste di spalle. Coordinate locali: centro della testa in (0,0), testa larga ~104
let uid = 0;
function defs(svg) {
  return svg.querySelector('defs') || sv('defs', {}, svg);
}

function rimFilter(svg, { dx = 0, dy = 5, color = '#8fe6ff', strength = 0.95, soft = 1.4 }) {
  const id = `rim${uid++}`;
  const f = sv('filter', { id, x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs(svg));
  sv('feOffset', { in: 'SourceAlpha', dx, dy, result: 'off' }, f);
  sv('feComposite', { in: 'SourceAlpha', in2: 'off', operator: 'out', result: 'edge' }, f);
  sv('feGaussianBlur', { in: 'edge', stdDeviation: soft, result: 'edgeb' }, f);
  sv('feFlood', { 'flood-color': color, 'flood-opacity': strength }, f);
  sv('feComposite', { in2: 'edgeb', operator: 'in', result: 'rim' }, f);
  // un secondo alone più largo e tenue: la luce che "avvolge" il bordo
  sv('feGaussianBlur', { in: 'edge', stdDeviation: soft * 5, result: 'edgew' }, f);
  sv('feFlood', { 'flood-color': color, 'flood-opacity': strength * 0.35 }, f);
  sv('feComposite', { in2: 'edgew', operator: 'in', result: 'halo' }, f);
  const m = sv('feMerge', {}, f);
  sv('feMergeNode', { in: 'SourceGraphic' }, m);
  sv('feMergeNode', { in: 'halo' }, m);
  sv('feMergeNode', { in: 'rim' }, m);
  return `url(#${id})`;
}

function vGrad(svg, y1, y2, stops) {
  const id = `g${uid++}`;
  const g = sv('linearGradient', { id, x1: 0, y1, x2: 0, y2, gradientUnits: 'userSpaceOnUse' }, defs(svg));
  stops.forEach(([o, c]) => sv('stop', { offset: o, 'stop-color': c }, g));
  return `url(#${id})`;
}

const HEAD = 'M -52,-10 C -56,-60 -30,-84 0,-84 C 30,-84 56,-60 52,-10 C 50,24 41,48 27,62 L -27,62 C -41,48 -50,24 -52,-10 Z';
const TORSO_SEATED = 'M -33,56 L -36,100 C -50,112 -95,118 -125,128 C -150,138 -160,165 -164,215 L -172,470 L 172,470 L 164,215 C 160,165 150,138 125,128 C 95,118 50,112 36,100 L 33,56 Z';
const TORSO_STANDING = 'M -27,56 L -31,100 C -50,112 -95,118 -125,128 C -150,138 -158,165 -158,215 L -140,420 C -136,460 -128,500 -122,540 L 122,540 C 128,500 136,460 140,420 L 158,215 C 158,165 150,138 125,128 C 95,118 50,112 31,100 L 27,56 Z';

function person(svg, o) {
  const {
    x, y, s,
    hair = 'short',
    shirt = '#14222c',
    hairColor = '#0a0c0e',
    skin = '#241a16',
    arm = null,
    standing = false,
    chair = !standing,
    headset = !standing,
    rim = {},
    turn = 0,
  } = o;
  const rimPx = { dx: (rim.dx ?? 0) / s, dy: (rim.dy ?? 4) / s, soft: (rim.soft ?? 1.3) / s, color: rim.color, strength: rim.strength };
  const g = sv('g', { transform: `translate(${x},${y}) scale(${s})`, filter: rimFilter(svg, rimPx) }, svg);

  const torsoFill = vGrad(svg, 90, standing ? 560 : 470, [[0, shirt], [0.45, '#070b0f'], [1, '#020406']]);
  const skinFill = vGrad(svg, 0, 110, [[0, skin], [1, '#0b0807']]);

  if (standing) {
    // gambe e braccia lungo i fianchi
    const legs = vGrad(svg, 520, 1100, [[0, '#0c1116'], [1, '#020304']]);
    sv('path', { d: 'M -122,520 L -118,780 L -100,1060 L -40,1062 L -30,780 L -8,560 L 8,560 L 30,780 L 40,1062 L 100,1060 L 118,780 L 122,520 Z', fill: legs }, g);
    sv('path', { d: 'M -150,150 C -175,190 -180,300 -178,400 C -177,460 -170,520 -160,580 L -126,582 C -132,500 -134,420 -130,330 Z', fill: torsoFill }, g);
    sv('path', { d: 'M 150,150 C 175,190 180,300 178,400 C 177,460 170,520 160,580 L 126,582 C 132,500 134,420 130,330 Z', fill: torsoFill }, g);
    sv('ellipse', { cx: -144, cy: 600, rx: 20, ry: 30, fill: skinFill }, g);
    sv('ellipse', { cx: 144, cy: 600, rx: 20, ry: 30, fill: skinFill }, g);
  }

  // orecchie, collo, busto
  sv('ellipse', { cx: -53, cy: 8, rx: 9, ry: 17, fill: skin }, g);
  sv('ellipse', { cx: 53, cy: 8, rx: 9, ry: 17, fill: skin }, g);
  sv('path', { d: 'M -33,30 L -36,104 L 36,104 L 33,30 Z', fill: skinFill }, g);
  sv('path', { d: standing ? TORSO_STANDING : TORSO_SEATED, fill: torsoFill }, g);
  // colletto della camicia
  sv('path', { d: 'M -36,92 C -20,104 20,104 36,92 L 38,106 C 20,118 -20,118 -38,106 Z', fill: shirt, opacity: 0.9 }, g);
  // piega della schiena
  sv('path', { d: 'M 0,120 C 4,200 -3,300 2,400', stroke: 'rgba(0,0,0,0.35)', 'stroke-width': 6, fill: 'none' }, g);

  // testa e capelli
  const head = sv('g', { transform: `rotate(${turn})` }, g);
  sv('path', { d: HEAD, fill: hairColor }, head);
  if (hair === 'short') {
    // attaccatura sulla nuca
    sv('path', { d: 'M -40,44 C -20,58 20,58 40,44 L 27,62 L -27,62 Z', fill: '#130f0d' }, head);
  } else if (hair === 'ponytail') {
    sv('path', { d: 'M -14,-22 C -26,30 -22,92 -4,150 C 2,158 8,150 12,140 C 26,80 24,20 14,-22 Z', fill: hairColor }, head);
    sv('rect', { x: -9, y: -18, width: 18, height: 7, rx: 3, fill: '#16222a' }, head);
  } else if (hair === 'bun') {
    sv('circle', { cx: 0, cy: -86, r: 26, fill: hairColor }, head);
    sv('path', { d: 'M -20,-64 C -10,-70 10,-70 20,-64', stroke: 'rgba(0,0,0,0.5)', 'stroke-width': 4, fill: 'none' }, head);
  } else if (hair === 'long') {
    sv('path', { d: 'M -54,-10 C -60,40 -58,110 -48,150 L 48,150 C 58,110 60,40 54,-10 Z', fill: hairColor }, head);
  }
  // riflessi sui capelli
  sv('path', { d: 'M -36,-60 C -18,-76 18,-76 36,-60', stroke: 'rgba(150,215,235,0.10)', 'stroke-width': 3, fill: 'none' }, head);

  if (headset) {
    sv('path', { d: 'M -61,-4 C -68,-74 -30,-98 0,-98 C 30,-98 68,-74 61,-4', stroke: '#0d1419', 'stroke-width': 8, fill: 'none' }, head);
    sv('rect', { x: -73, y: -16, width: 22, height: 44, rx: 8, fill: '#111a20' }, head);
    sv('rect', { x: 51, y: -16, width: 22, height: 44, rx: 8, fill: '#111a20' }, head);
    // asta del microfono che gira verso la bocca
    sv('path', { d: 'M -66,22 C -74,44 -66,64 -48,74', stroke: '#111a20', 'stroke-width': 5, fill: 'none', 'stroke-linecap': 'round' }, head);
  }

  // braccio destro
  if (arm?.type === 'point') {
    const hx = (arm.hand[0] - x) / s, hy = (arm.hand[1] - y) / s;
    const sh = [128, 132];
    const mx = (sh[0] + hx) / 2, my = (sh[1] + hy) / 2;
    const len = Math.hypot(hx - sh[0], hy - sh[1]);
    const nx = -(hy - sh[1]) / len, ny = (hx - sh[0]) / len;
    const elbow = [mx + nx * 46 * Math.sign(nx || 1), my + ny * 46 * Math.sign(nx || 1) + 30];
    const dirx = (hx - elbow[0]) / Math.hypot(hx - elbow[0], hy - elbow[1]);
    const diry = (hy - elbow[1]) / Math.hypot(hx - elbow[0], hy - elbow[1]);
    const wrist = [hx - dirx * 80, hy - diry * 80];
    const sleeve = vGrad(svg, hy, sh[1] + 120, [[0, '#0a1015'], [1, '#05080b']]);
    sv('path', { d: `M ${sh[0]},${sh[1]} L ${elbow[0]},${elbow[1]}`, stroke: sleeve, 'stroke-width': 84, 'stroke-linecap': 'round', fill: 'none' }, g);
    sv('path', { d: `M ${elbow[0]},${elbow[1]} L ${wrist[0]},${wrist[1]}`, stroke: sleeve, 'stroke-width': 58, 'stroke-linecap': 'round', fill: 'none' }, g);
    // mano: palmo, indice teso, pollice
    const ang = (Math.atan2(diry, dirx) * 180) / Math.PI;
    const hand = sv('g', { transform: `translate(${wrist[0]},${wrist[1]}) rotate(${ang})` }, g);
    sv('path', { d: 'M -6,-20 C 14,-26 36,-22 42,-10 C 46,0 44,16 36,22 C 22,30 2,28 -8,20 Z', fill: skin }, hand);
    sv('path', { d: 'M 38,-12 L 76,-15', stroke: skin, 'stroke-width': 12, 'stroke-linecap': 'round' }, hand);
    sv('path', { d: 'M 18,-20 C 26,-26 34,-24 40,-18', stroke: 'rgba(0,0,0,0.35)', 'stroke-width': 3, fill: 'none' }, hand);
    sv('path', { d: 'M 30,6 C 34,10 36,16 33,20 M 22,10 C 26,14 28,20 24,24', stroke: 'rgba(0,0,0,0.35)', 'stroke-width': 2.5, fill: 'none' }, hand);
  } else if (arm?.type === 'ear') {
    const sleeve = vGrad(svg, -20, 200, [[0, '#0b1116'], [1, '#04070a']]);
    sv('path', { d: 'M 130,138 C 175,118 214,90 222,52', stroke: sleeve, 'stroke-width': 62, 'stroke-linecap': 'round', fill: 'none' }, g);
    sv('path', { d: 'M 222,52 C 196,24 140,8 96,4', stroke: sleeve, 'stroke-width': 46, 'stroke-linecap': 'round', fill: 'none' }, g);
    const hand = sv('g', { transform: 'rotate(-12 70 2)' }, g);
    sv('ellipse', { cx: 72, cy: 2, rx: 25, ry: 36, fill: vGrad(svg, -36, 40, [[0, skin], [1, '#0d0907']]) }, hand);
    sv('path', { d: 'M 60,-26 C 66,-10 66,14 60,30 M 74,-30 C 80,-10 80,14 74,32 M 88,-24 C 92,-8 92,12 88,26', stroke: 'rgba(0,0,0,0.4)', 'stroke-width': 2.5, fill: 'none' }, hand);
  } else if (arm?.type === 'mouse') {
    // gomito appoggiato, avambraccio verso il mouse davanti a sé
    const sleeve = vGrad(svg, 100, 300, [[0, '#0b1116'], [1, '#04070a']]);
    sv('path', { d: 'M 140,150 C 170,190 178,232 176,262', stroke: sleeve, 'stroke-width': 60, 'stroke-linecap': 'round', fill: 'none' }, g);
  }

  if (chair) {
    sv('path', {
      d: 'M -132,300 C -132,262 -110,250 -70,248 L 70,248 C 110,250 132,262 132,300 L 128,470 L -128,470 Z',
      fill: vGrad(svg, 248, 470, [[0, '#0c1217'], [1, '#030507']]),
    }, g);
    sv('path', { d: 'M -118,262 C -90,252 90,252 118,262', stroke: 'rgba(150,215,235,0.28)', 'stroke-width': 3 / s * 0.8 + 1, fill: 'none' }, g);
  }
  return g;
}

// --- atmosfera: bagliore degli schermi, foschia, grana, vignettatura
function atmosphere(stage, screens, w, h, { bloom = 0.55, vignette = 0.78, grain = 0.09 } = {}) {
  for (const [radius, k] of [[26, 1], [90, 0.7]]) {
    const cv = el('canvas', { class: 'abs', width: w, height: h, style: { left: 0, top: 0, opacity: bloom * k, mixBlendMode: 'screen' } }, stage);
    const c = cv.getContext('2d');
    for (const [sc, blur] of screens) {
      c.filter = `blur(${radius + blur}px) brightness(${radius > 50 ? 1.6 : 1.4})`;
      c.drawImage(sc, 0, 0);
    }
  }
  layer(stage, { background: `radial-gradient(ellipse 75% 70% at 55% 48%, rgba(0,0,0,0) 40%, rgba(0,0,0,${vignette}) 100%)` });
  const noise = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.6  0 0 0 0 0.65  0 0 0 1.4 -0.2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`;
  layer(stage, { backgroundImage: `url("data:image/svg+xml,${noise.replace(/#/g, '%23').replace(/"/g, "'")}")`, opacity: grain, mixBlendMode: 'overlay' });
  // leggera dominante fredda, come le sale vere
  layer(stage, { background: 'linear-gradient(180deg, rgba(20,60,80,0.10), rgba(5,15,25,0.18))', mixBlendMode: 'soft-light' });
}

// --- stanza in prospettiva: proiezione di un punto (x, y, z) in metri, y verso il basso dall'occhio
function camera(vx, vy, f) {
  return (x, y, z) => [vx + (x * f) / z, vy + (y * f) / z];
}

function room(ctx, cam, { ceiling = -1.7, floor = 1.3, wallZ = 18, width = 9, displays = true, lights = true, blur = 2.5 }) {
  ctx.group(blur);
  const svgBack = ctx.cur.under;
  const P = (x, y, z) => cam(x, y, z);
  // soffitto, parete di fondo, pavimento
  const zN = 1.2;
  sv('polygon', { points: pts([P(-width * 3, ceiling, zN), P(width * 3, ceiling, zN), P(width, ceiling, wallZ), P(-width, ceiling, wallZ)]), fill: '#060c12' }, svgBack);
  sv('polygon', { points: pts([P(-width, ceiling, wallZ), P(width, ceiling, wallZ), P(width, floor, wallZ), P(-width, floor, wallZ)]), fill: vGrad(svgBack, P(0, ceiling, wallZ)[1], P(0, floor, wallZ)[1], [[0, '#08121a'], [1, '#0b1820']]) }, svgBack);
  sv('polygon', { points: pts([P(-width, floor, wallZ), P(width, floor, wallZ), P(width * 3, floor, zN), P(-width * 3, floor, zN)]), fill: vGrad(svgBack, P(0, floor, wallZ)[1], P(0, floor, zN)[1], [[0, '#081017'], [1, '#020406']]) }, svgBack);
  if (lights) {
    for (const z of [2.2, 3.2, 4.6, 6.4, 9, 12.5, 16.5]) {
      for (const x of [-6, -3, 0, 3, 6]) {
        const q = [P(x - 0.5, ceiling, z), P(x + 0.5, ceiling, z), P(x + 0.5, ceiling, z + 0.6), P(x - 0.5, ceiling, z + 0.6)];
        sv('polygon', { points: pts(q), fill: 'rgba(170, 205, 220, 0.16)' }, svgBack);
        const [cx, cy] = P(x, ceiling + 0.02, z + 0.3);
        glow(ctx.cur.glows, cx, cy, 240 / z * 2, 80 / z * 2, 'rgba(120,170,200,A)', 0.12);
      }
    }
  }
  if (displays) {
    // grande schermo sulla parete di fondo
    const q = [P(-4.6, -0.9, wallZ - 0.05), P(4.6, -0.9, wallZ - 0.05), P(4.6, 0.4, wallZ - 0.05), P(-4.6, 0.4, wallZ - 0.05)];
    monitor(ctx, q, { shot: 'radar', crop: [0, 0, 1130, 820], bezel: 4, bright: 0.7, stand: false });
    const [cx, cy] = P(0, -0.25, wallZ);
    glow(ctx.cur.glows, cx, cy, 700, 260, 'rgba(60,140,180,A)', 0.25);
  }
}

// fila di postazioni: monitor sul banco, persona seduta davanti (lontano → vicino)
function consoleRow(ctx, cam, z, xs, { desk = 0.55, floor = 1.3, people = [], rim = {}, blur = 0 }) {
  ctx.group(blur);
  const svgBack = ctx.cur.over;
  const P = (x, y, zz) => cam(x, y, zz);
  const x0 = Math.min(...xs) - 0.9, x1 = Math.max(...xs) + 0.9;
  // banco: piano e frontale
  sv('polygon', { points: pts([P(x0, desk, z + 0.1), P(x1, desk, z + 0.1), P(x1, desk, z - 0.75), P(x0, desk, z - 0.75)]), fill: '#0b141b' }, svgBack);
  sv('polygon', { points: pts([P(x0, desk, z - 0.75), P(x1, desk, z - 0.75), P(x1, floor, z - 0.75), P(x0, floor, z - 0.75)]), fill: '#04080b' }, svgBack);
  sv('line', { x1: P(x0, desk, z - 0.75)[0], y1: P(x0, desk, z - 0.75)[1], x2: P(x1, desk, z - 0.75)[0], y2: P(x1, desk, z - 0.75)[1], stroke: 'rgba(140,210,230,0.35)', 'stroke-width': Math.max(0.6, 3 / z) }, svgBack);
  xs.forEach((x, i) => {
    for (const dx of [-0.33, 0.33]) {
      const q = [P(x + dx - 0.3, desk - 0.48, z), P(x + dx + 0.3, desk - 0.48, z), P(x + dx + 0.3, desk - 0.1, z), P(x + dx - 0.3, desk - 0.1, z)];
      const cx = 40 + Math.floor(rnd() * 700), cy = 20 + Math.floor(rnd() * 300);
      monitor(ctx, q, { shot: rnd() < 0.8 ? 'radar' : 'start', crop: [cx, cy, 640, 420], bezel: Math.max(1.5, 14 / z), bright: 1.05, stand: false });
      const [gx, gy] = P(x + dx, desk - 0.3, z);
      glow(ctx.cur.glows, gx, gy, 900 / z, 520 / z, 'rgba(70,160,200,A)', 0.32);
      const [dx2, dy2] = P(x + dx, desk, z - 0.3);
      glow(ctx.cur.glows, dx2, dy2, 700 / z, 120 / z, 'rgba(90,180,210,A)', 0.22);
    }
    const [fx, fy] = P(x, floor, z - 1.1);
    glow(ctx.cur.glows, fx, fy, 1300 / z, 260 / z, 'rgba(60,140,180,A)', 0.18);
    const p = people[i];
    if (p) {
      const [px, py] = P(x + (p.dx ?? 0), floor - 1.2, z - 0.85);
      person(ctx.cur.over, { x: px, y: py, s: ctx.unit / (z - 0.85), rim, ...p });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Scene

// sfocatura per profondità: nitido vicino al piano di fuoco, morbido lontano
const dof = (z, focus, k = 0.22) => Math.min(4, Math.abs(z - focus) * k);

// banco in primo piano con tastiere, spie e tazza
function frontDesk(ctx, top, x0, x1, items = {}) {
  const u = ctx.cur.under;
  sv('polygon', { points: pts([[x0, top], [x1, top], [x1 + 200, ctx.h], [x0 - 240, ctx.h]]), fill: vGrad(u, top, ctx.h, [[0, '#0d1820'], [1, '#03060a']]) }, u);
  sv('line', { x1: x0, y1: top, x2: x1, y2: top, stroke: 'rgba(150,215,235,0.4)', 'stroke-width': 2 }, u);
  const o = ctx.cur.over;
  for (const [x, w] of items.keyboards ?? []) {
    sv('rect', { x, y: top + 60, width: w, height: 46, rx: 6, fill: '#0a1218', stroke: 'rgba(150,215,235,0.25)' }, o);
    for (let r = 0; r < 4; r++) {
      sv('line', { x1: x + 10, y1: top + 70 + r * 9, x2: x + w - 10, y2: top + 70 + r * 9, stroke: 'rgba(150,215,235,0.10)', 'stroke-width': 5, 'stroke-dasharray': '9 3' }, o);
    }
  }
  for (const [x, c] of items.leds ?? []) {
    sv('circle', { cx: x, cy: top + 28, r: 3.2, fill: c }, o);
    glow(ctx.cur.glows, x, top + 28, 16, 12, 'rgba(160,255,190,A)', 0.55);
  }
  if (items.mug) {
    const [mx, my] = items.mug;
    sv('path', { d: `M ${mx},${my} L ${mx + 4},${my + 70} C ${mx + 6},${my + 82} ${mx + 52},${my + 82} ${mx + 54},${my + 70} L ${mx + 58},${my} Z`, fill: '#0c151b', stroke: 'rgba(150,215,235,0.3)' }, o);
    sv('path', { d: `M ${mx + 58},${my + 16} C ${mx + 84},${my + 16} ${mx + 84},${my + 50} ${mx + 56},${my + 52}`, stroke: 'rgba(150,215,235,0.3)', 'stroke-width': 7, fill: 'none' }, o);
    sv('ellipse', { cx: mx + 29, cy: my, rx: 29, ry: 7, fill: '#05090c', stroke: 'rgba(150,215,235,0.35)' }, o);
  }
}

const SCENES = {
  // copertina: pianificatore ed esecutivo di un settore; lei indica una traccia sul radar di lui
  turno: { w: 2400, h: 1250, build(ctx) {
    const cam = camera(1420, 640, 1500);
    ctx.unit = 1500 / 650;
    room(ctx, cam, { ceiling: -1.9, floor: 1.4, wallZ: 22, width: 12, blur: 3.5 });
    consoleRow(ctx, cam, 12, [-7.2, -5.4, -3.6, -1.8, 0, 1.8], {
      desk: 0.6, floor: 1.4, rim: { dy: 1.2, soft: 0.6 }, blur: 3,
      people: [{ hair: 'short' }, null, { hair: 'bun', shirt: '#1b1d24' }, { hair: 'short', shirt: '#22201c' }, null, { hair: 'long' }],
    });
    consoleRow(ctx, cam, 7.5, [-6.4, -4.4, -2.4], {
      desk: 0.6, floor: 1.4, rim: { dy: 1.6, soft: 0.7 }, blur: 2.2,
      people: [{ hair: 'ponytail', shirt: '#18222a' }, { hair: 'short', shirt: '#1e1b1a' }, null],
    });
    // supervisore in piedi nel corridoio
    const [sx, sy] = cam(-1.1, 1.4 - 1.68, 8.5);
    person(ctx.cur.over, { x: sx, y: sy, s: ctx.unit / 8.5, standing: true, hair: 'short', shirt: '#1a2630', rim: { dy: 1.6, soft: 0.7 } });

    // primo piano: il banco con tre monitor
    ctx.group(0);
    glow(ctx.cur.glows, 1640, 520, 950, 560, 'rgba(60,150,190,A)', 0.4);
    glow(ctx.cur.glows, 1000, 560, 420, 320, 'rgba(70,150,190,A)', 0.28);
    frontDesk(ctx, 800, 0, 2400, {
      keyboards: [[880, 300], [1450, 380]],
      leds: [[1240, '#7cfc9a'], [1262, '#7cfc9a'], [1284, '#ffb84d'], [2030, '#7cfc9a'], [2052, '#6ec8ff']],
      mug: [700, 830],
    });
    monitor(ctx, [[780, 420], [1220, 395], [1220, 735], [780, 720]], { shot: 'radar', crop: [1130, 0, 340, 560], bezel: 14, bright: 1.15 });
    monitor(ctx, [[1270, 300], [2010, 300], [2010, 760], [1270, 760]], { shot: 'radar', crop: [120, 60, 900, 560], bezel: 16, bright: 1.25 });
    monitor(ctx, [[2060, 360], [2420, 395], [2420, 730], [2060, 750]], { shot: 'tutorial', crop: [400, 120, 520, 520], bezel: 14, bright: 1.05 });
    glow(ctx.cur.glows, 1640, 830, 700, 120, 'rgba(90,190,220,A)', 0.35);

    const rim = { dy: 5, dx: 0, color: '#8fe8ff', soft: 1.4 };
    person(ctx.cur.over, { x: 1030, y: 930, s: 1.18, hair: 'ponytail', shirt: '#1a2a35', skin: '#3a2a22', arm: { type: 'point', hand: [1400, 600] }, rim: { ...rim, dx: 2 }, turn: 8 });
    person(ctx.cur.over, { x: 1700, y: 960, s: 1.3, hair: 'short', shirt: '#1d2228', skin: '#2e211b', arm: { type: 'ear' }, rim, turn: -4 });
  } },

  // primo piano: una controllora in ascolto davanti al radar
  ascolto: { w: 1800, h: 1200, build(ctx) {
    const cam = camera(900, 520, 1100);
    ctx.unit = 1100 / 650;
    room(ctx, cam, { ceiling: -1.7, floor: 1.3, wallZ: 14, width: 8, displays: false, blur: 4 });
    consoleRow(ctx, cam, 6, [-4.2, -2.4], { desk: 0.55, rim: { dy: 1.4, soft: 0.6 }, blur: 3.5, people: [{ hair: 'short' }, { hair: 'bun' }] });
    ctx.group(0);
    glow(ctx.cur.glows, 1200, 480, 900, 560, 'rgba(60,150,190,A)', 0.42);
    frontDesk(ctx, 850, -100, 1800, { keyboards: [[1060, 420]], leds: [[1540, '#7cfc9a'], [1562, '#ffb84d']] });
    monitor(ctx, [[640, 140], [1760, 190], [1760, 820], [640, 800]], { shot: 'radar', crop: [330, 120, 720, 440], bezel: 18, bright: 1.3 });
    monitor(ctx, [[-60, 300], [520, 270], [520, 790], [-60, 800]], { shot: 'radar', crop: [1130, 0, 340, 560], bezel: 16, bright: 1.1 });
    glow(ctx.cur.glows, 1200, 880, 700, 120, 'rgba(90,190,220,A)', 0.35);
    person(ctx.cur.over, { x: 640, y: 760, s: 2.15, hair: 'bun', shirt: '#1d2b36', skin: '#3a2a22', arm: { type: 'ear' }, rim: { dy: 5, dx: 3, color: '#8fe8ff', soft: 1.6 }, turn: 6 });
  } },

  // la sala vista dal fondo: file di postazioni, il turno in corso
  sala: { w: 2400, h: 900, build(ctx) {
    const cam = camera(1200, 230, 1250);
    ctx.unit = 1250 / 650;
    room(ctx, cam, { ceiling: -1.6, floor: 1.75, wallZ: 24, width: 11, blur: 3 });
    const rows = [
      [19, [-6, -4.2, -2.4, -0.6, 1.2, 3, 4.8]],
      [13.5, [-6.6, -4.8, -3, -1.2, 0.6, 2.4, 4.2, 6]],
      [9.5, [-5.4, -3.6, -1.8, 0, 1.8, 3.6, 5.4]],
      [6.5, [-4.8, -3, -1.2, 1.2, 3, 4.8]],
      [4.2, [-3.6, -1.8, 0.4, 2.2, 4]],
    ];
    const hairs = ['short', 'bun', 'short', 'ponytail', 'long', 'short', 'short', 'bun'];
    const shirts = ['#18242e', '#1d1c22', '#22201c', '#16202a', '#1b2630'];
    rows.forEach(([z, xs], r) => {
      const people = xs.map((_, i) => (rnd() < 0.15 ? null : { hair: hairs[(i + r) % hairs.length], shirt: shirts[(i * 3 + r) % shirts.length], turn: Math.round((rnd() - 0.5) * 16) }));
      consoleRow(ctx, cam, z, xs, { desk: 1.0, floor: 1.75, people, rim: { dy: 8 / z, soft: 3 / z }, blur: dof(z, 6, 0.2) });
      if (r === 2) {
        // supervisore in piedi fra le file
        const [sx, sy] = cam(-0.9, 1.75 - 1.72, 8.2);
        person(ctx.cur.over, { x: sx, y: sy, s: ctx.unit / 8.2, standing: true, hair: 'short', shirt: '#203040', rim: { dy: 1, soft: 0.5 } });
      }
    });
  } },
};

function build() {
  const name = new URLSearchParams(location.search).get('scena') || 'turno';
  const scene = SCENES[name];
  const { w, h } = scene;
  const stage = document.getElementById('stage');
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;

  const allScreens = [];
  const ctx = {
    w, h, cur: null,
    // un piano di profondità: cornici sotto, schermate, poi banco e persone sopra, poi la luce
    group(blur) {
      const g = layer(stage, blur ? { filter: `blur(${blur}px)` } : {});
      const under = svgLayer(g, w, h);
      const screens = el('canvas', { class: 'abs', width: w, height: h, style: { left: 0, top: 0 } }, g);
      const glows = layer(g);
      const over = svgLayer(g, w, h);
      allScreens.push([screens, blur]);
      this.cur = { under, screens, over, glows };
      return this.cur;
    },
  };
  scene.build(ctx);

  // il bagliore nasce da tutti gli schermi, vicini e lontani
  atmosphere(stage, allScreens, w, h, scene.atmo);
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = { w, h }; }));
}

const IMAGES = {};
function load() {
  return Promise.all(Object.entries(SHOTS).map(([k, src]) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { IMAGES[k] = i; res(); };
    i.onerror = () => rej(new Error(`immagine mancante: ${src}`));
    i.src = src;
  })));
}

load().then(build);
