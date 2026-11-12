import { airspace, waypoint, unitAt, sectorAt } from './airspace.js';
import { pointAlong, profileAltitude, profilePhase } from './flows.js';
import { topTransferFL, bottomTransferFL } from './sectors.js';
import { HISTORY_S, isConcerned, predictAltitude, SEP_HORIZONTAL_NM, SEP_VERTICAL_FT } from './sim.js';
import { bearing, pointInPolygon } from './geo.js';
import { soundSpeedKt, MACH_FROM_FT } from './performance.js';
import {
  isActiveAt, currentOrNextWindow, areaBand, areaOverlapsBand, fmtClock, PREACTIVE_S,
} from './areas.js';
import { cellOutline, cellRadius, cellAt, WEATHER_COLORS } from './weather.js';

export const TAG_W = 116;
const TAG_LINE = 15;

// Colori per stato di controllo.
export const COLORS = {
  assumed: '#7CFC9A',
  offered: '#ff5bd8',
  notInContact: '#e8d45a',
  conflict: '#ff4d4d',
  warning: '#ffb84d',
  selected: '#ffffff',
  route: 'rgba(110, 200, 255, 0.9)',
};
// sfondo del radar e alone scuro attorno ai testi
export const MAP_BG = '#050b12';
const HALO = 'rgba(5, 11, 18, 0.85)';

// Label integrata. I campi dipendono da quello che fa il volo (livellato, oppure in salita o in discesa)
// e dal passaggio del mouse; tre righe da livellato, quattro in salita o discesa. fullLabel: voli di nostra
// competenza, per cui il livello autorizzato è il nostro.
export function fullLabel(ac) {
  return ac.control === 'assumed' || ac.control === 'offered';
}

// in salita o in discesa: si muove in verticale, oppure ha ancora da raggiungere il livello autorizzato
export function isEvolving(ac) {
  return Math.abs(ac.verticalFpm ?? 0) >= 100 || Math.abs(ac.assignedAltitude - ac.altitude) >= 100;
}

// altezza di riferimento (tre righe): la quarta riga, in salita o discesa, cresce dalla parte opposta alla traccia
export function tagHeight() {
  return 8 + TAG_LINE * 3;
}

// Aereo sotto il mouse: la sua label prende il riquadro grigio, si vede completa e sta sopra le altre.
let hoveredId = null;
export function setHovered(ac) {
  hoveredId = ac?.id ?? null;
}
const isHovered = (ac) => ac.id === hoveredId;

// Vista scelta dal controllore: ingrandimento, spostamento del centro (NM) rispetto alla vista del settore,
// lunghezza del vettore velocità (minuti) e filtro dei livelli per le etichette (tagMinFL-tagMaxFL).
export const ZOOM_RANGE = [0.5, 4];
export const TAG_FL_RANGE = [0, 450]; // agli estremi il filtro non ha limite (sotto FL000 o sopra FL450)
export const VECTOR_RANGE = [1, 10];
// mapPoints: punti sulla mappa, 'all' tutti con nome, 'cop' solo i punti di uscita del settore, 'symbols' solo i triangoli;
// inactiveAreas: contorni delle zone non attive (quelle in procinto di attivarsi si vedono sempre)
// stars/sids: SID e STAR delle piste in uso degli aeroporti visibili
export const radarView = {
  zoom: 1, panX: 0, panY: 0, vectorMin: 2, tagMinFL: TAG_FL_RANGE[0], tagMaxFL: TAG_FL_RANGE[1], mapPoints: 'all',
  inactiveAreas: true, stars: true, sids: false,
};

// Il punto è disegnato sulla mappa con il filtro scelto (serve anche per sceglierlo con un clic).
export function waypointShown(wp) {
  return radarView.mapPoints !== 'cop' || airspace.copIds.has(wp.id);
}

// Filtro dei livelli: fuori dall'intervallo resta solo la traccia. Le etichette dei voli in contatto o da
// assumere, di quello selezionato e di quelli in conflitto o in allarme STCA si vedono sempre, come sui
// sistemi reali, dove il filtro in quota riguarda solo il traffico non di competenza.
export function tagVisible(ac) {
  if (isHovered(ac)) return true;
  if (ac.control === 'assumed' || ac.control === 'offered' || ac.selected || ac.stca || ac.conflict || ac.apw) return true;
  const fl = ac.flightLevel;
  const { tagMinFL: lo, tagMaxFL: hi } = radarView;
  return (lo <= TAG_FL_RANGE[0] || fl >= lo) && (hi >= TAG_FL_RANGE[1] || fl <= hi);
}

export function resetView() {
  radarView.zoom = 1;
  radarView.panX = 0;
  radarView.panY = 0;
}

// Le coordinate di disegno sono in px CSS (indipendenti dal devicePixelRatio):
// il canvas viene scalato una volta sola in app.js con ctx.setTransform(dpr,...).
export function makeTransform(canvas) {
  const view = airspace.view;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const scale = Math.min(cw / (view.xMax - view.xMin), ch / (view.yMax - view.yMin)) * radarView.zoom;
  const centerX = (view.xMin + view.xMax) / 2 + radarView.panX;
  const centerY = (view.yMin + view.yMax) / 2 + radarView.panY;
  const offsetX = cw / 2 - centerX * scale;
  const offsetY = ch / 2 - centerY * scale;

  return {
    scale,
    toPx(x, y) {
      return { px: x * scale + offsetX, py: y * scale + offsetY };
    },
    fromPx(px, py) {
      return { x: (px - offsetX) / scale, y: (py - offsetY) / scale };
    },
  };
}

// Sposta la mappa di (dx, dy) px CSS.
export function panBy(canvas, dx, dy) {
  const { scale } = makeTransform(canvas);
  radarView.panX -= dx / scale;
  radarView.panY -= dy / scale;
}

// Nuovo ingrandimento, tenendo fermo sullo schermo il punto (px, py): il centro del radar se non indicato.
export function zoomTo(canvas, zoom, px = canvas.clientWidth / 2, py = canvas.clientHeight / 2) {
  const before = makeTransform(canvas).fromPx(px, py);
  radarView.zoom = Math.max(ZOOM_RANGE[0], Math.min(ZOOM_RANGE[1], zoom));
  const after = makeTransform(canvas).fromPx(px, py);
  radarView.panX += before.x - after.x;
  radarView.panY += before.y - after.y;
}

function pathOf(ctx, t, points, close) {
  ctx.beginPath();
  points.forEach((p, i) => {
    const { px, py } = t.toPx(p.x, p.y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  if (close) ctx.closePath();
}

// --- mappa statica (ridisegnata solo quando cambiano dimensioni o settore) ---

let mapCache = { key: '', canvas: null };

function drawStaticMap(ctx, t, cw, ch) {
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, cw, ch);

  ctx.strokeStyle = 'rgba(70, 150, 160, 0.5)';
  ctx.lineWidth = 1.1;
  for (const line of airspace.coast) {
    pathOf(ctx, t, line, false);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(120, 170, 120, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  for (const line of airspace.fraBoundary) {
    pathOf(ctx, t, line, false);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(170, 170, 170, 0.45)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([10, 4, 2, 4]);
  for (const line of airspace.accLines) {
    pathOf(ctx, t, line, false);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // settori dello stesso livello
  ctx.font = '11px monospace';
  for (const s of airspace.sectorsXY) {
    if (s.layer !== airspace.sector.layer || s.id === airspace.sector.id) continue;
    ctx.strokeStyle = 'rgba(150, 190, 200, 0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    pathOf(ctx, t, s.polygonXY, true);
    ctx.stroke();
    ctx.setLineDash([]);
    const c = s.polygonXY.reduce((acc, p) => ({ x: acc.x + p.x / s.polygonXY.length, y: acc.y + p.y / s.polygonXY.length }), { x: 0, y: 0 });
    const { px, py } = t.toPx(c.x, c.y);
    ctx.fillStyle = 'rgba(150, 190, 200, 0.3)';
    ctx.textAlign = 'center';
    ctx.fillText(s.name, px, py);
    ctx.textAlign = 'left';
  }

  // il nostro settore
  pathOf(ctx, t, airspace.polygon, true);
  ctx.fillStyle = 'rgba(80, 160, 180, 0.07)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(160, 225, 235, 0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();

  drawProcedures(ctx, t, cw, ch);

  // punti FRA: i punti di coordinamento del settore sono evidenziati
  for (const wp of airspace.waypoints) {
    if (!waypointShown(wp)) continue;
    const { px, py } = t.toPx(wp.x, wp.y);
    if (px < -20 || py < -20 || px > cw + 20 || py > ch + 20) continue;
    const cop = airspace.copIds.has(wp.id);
    const size = cop ? 5 : 3.5;
    ctx.strokeStyle = cop ? 'rgba(120, 220, 235, 0.95)' : 'rgba(150, 190, 200, 0.4)';
    ctx.lineWidth = cop ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(px, py - size);
    ctx.lineTo(px + size, py + size * 0.85);
    ctx.lineTo(px - size, py + size * 0.85);
    ctx.closePath();
    ctx.stroke();
    if (radarView.mapPoints === 'symbols') continue;
    ctx.font = cop ? 'bold 11px monospace' : '10px monospace';
    ctx.fillStyle = cop ? 'rgba(120, 220, 235, 0.9)' : 'rgba(150, 190, 200, 0.36)';
    ctx.fillText(wp.id, px + size + 2, py - 4);
  }

  // aeroporti italiani visibili
  ctx.font = 'bold 11px monospace';
  for (const apt of airspace.airports) {
    if (!apt.app) continue;
    const { px, py } = t.toPx(apt.x, apt.y);
    ctx.strokeStyle = 'rgba(230, 230, 230, 0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.moveTo(px - 8, py);
    ctx.lineTo(px + 8, py);
    ctx.stroke();
    ctx.fillStyle = 'rgba(230, 230, 230, 0.75)';
    ctx.fillText(apt.icao, px + 9, py + 13);
  }

  // scala: la lunghezza più adatta all'ingrandimento
  const nm = [5, 10, 20, 40, 80].find((n) => n * t.scale >= 45) ?? 80;
  const len = nm * t.scale;
  // in alto a destra: in basso c'è la barra degli strumenti
  const x0 = cw - len - 70;
  const y0 = 26;
  ctx.strokeStyle = 'rgba(215, 230, 234, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - 4);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x0 + len, y0);
  ctx.lineTo(x0 + len, y0 - 4);
  ctx.stroke();
  ctx.fillStyle = 'rgba(215, 230, 234, 0.6)';
  ctx.font = '11px monospace';
  ctx.fillText(`${nm} NM`, x0 + len + 6, y0 + 3);
}

// SID e STAR delle piste in uso: le STAR continue, le SID tratteggiate, entrambe tenui sotto i punti FRA. Il nome
// della STAR sta sul punto iniziale (dove l'arrivo passa all'avvicinamento), quello della SID sul punto finale.
// I fix intermedi, che non sono punti FRA, sono piccoli cerchi senza nome.
const PROC_COLORS = { star: 'rgba(140, 200, 150, 0.42)', sid: 'rgba(215, 180, 120, 0.42)' };
function drawProcedures(ctx, t, cw, ch) {
  const shown = airspace.procMap.filter((p) => (p.kind === 'star' ? radarView.stars : radarView.sids));
  if (!shown.length) return;
  ctx.save();
  ctx.lineWidth = 1;
  for (const p of shown) {
    ctx.strokeStyle = PROC_COLORS[p.kind];
    ctx.setLineDash(p.kind === 'sid' ? [5, 4] : []);
    pathOf(ctx, t, p.points.filter(Boolean), false);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const labelled = new Set();
  ctx.font = '10px monospace';
  for (const p of shown) {
    ctx.fillStyle = PROC_COLORS[p.kind];
    for (const q of p.points) {
      if (!q?.proc || q.types) continue;
      const { px, py } = t.toPx(q.x, q.y);
      ctx.beginPath();
      ctx.arc(px, py, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (radarView.mapPoints === 'symbols') continue;
    const at = p.kind === 'star' ? p.points[0] : p.points[p.points.length - 1];
    const key = `${p.kind}|${at?.id}`;
    if (!at || labelled.has(key)) continue;
    labelled.add(key);
    const { px, py } = t.toPx(at.x, at.y);
    if (px < -20 || py < -20 || px > cw + 20 || py > ch + 20) continue;
    ctx.fillStyle = PROC_COLORS[p.kind].replace('0.42', '0.8');
    ctx.fillText(p.name, px + 7, py + 12);
  }
  ctx.restore();
}

function blitStaticMap(ctx, canvas, t) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const key = `${airspace.sector.id}|${cw}|${ch}|${dpr}|${radarView.zoom}|${radarView.panX}|${radarView.panY}|${radarView.mapPoints}|${radarView.stars}|${radarView.sids}`;
  if (mapCache.key !== key) {
    const off = document.createElement('canvas');
    off.width = Math.round(cw * dpr);
    off.height = Math.round(ch * dpr);
    const octx = off.getContext('2d');
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStaticMap(octx, t, cw, ch);
    mapCache = { key, canvas: off };
  }
  ctx.drawImage(mapCache.canvas, 0, 0, cw, ch);
}

// --- elementi dinamici ---

// Zone P, R, D, TSA e TRA: attive in grigio chiaro, in procinto di attivarsi (entro PREACTIVE_S) con il contorno
// tratteggiato e l'ora d'inizio, non attive appena accennate (si possono nascondere dal menu Mappa, e hanno il
// nome solo se interessano i livelli del settore). Diventano rosse, con un rosso tenue che lascia vedere il
// traffico, appena la previsione lungo rotta e livello porta dentro un volo in contatto (il suo tag ha un
// asterisco rosso); il contorno si fa più marcato quando il volo è troppo vicino (allarme di prossimità). Per il
// volo selezionato compaiono la rotta e il punto d'ingresso previsto, con livello, ora e tempo mancante.
const AREA_GREY = '205, 210, 218';
const AREA_RED = '255, 77, 77';

// Temporali: eco delle celle convettive come su un display meteo, a due livelli (nucleo e bordo), con la
// sommità scritta accanto. Sotto le tracce e le mappe, così non copre niente di importante.
const TURB_COLOR = '#b9b36a';

// Turbolenza riportata dai piloti (PIREP): zona tratteggiata con la fascia di livelli. Quella non ancora
// riportata non si vede, come in realtà.
function drawTurbulence(ctx, t, sim) {
  const zones = sim.weather?.turb?.filter((z) => z.reported) ?? [];
  if (!zones.length) return;
  ctx.save();
  ctx.strokeStyle = TURB_COLOR;
  ctx.fillStyle = TURB_COLOR;
  ctx.lineWidth = 1;
  ctx.font = '11px monospace';
  for (const z of zones) {
    const { px, py } = t.toPx(z.x, z.y);
    const r = z.r * t.scale;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.06;
    ctx.fill();
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.fillText(`TURB MOD ${String(z.lo).padStart(3, '0')}-${String(z.hi).padStart(3, '0')}`, px - 48, py - r + 14);
  }
  ctx.restore();
}

function drawWeather(ctx, t, sim) {
  drawTurbulence(ctx, t, sim);
  if (!sim.weather?.cells.length) return;
  ctx.save();
  for (const cell of sim.weather.cells) {
    if (cellRadius(cell) < 0.5) continue;
    const color = WEATHER_COLORS[cell.intensity];
    for (const [scale, alpha] of [[1, 0.1], [0.62, 0.16], [0.32, 0.22]]) {
      const pts = cellOutline(cell, scale);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const { px, py } = t.toPx(p.x, p.y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.fill();
      if (scale === 1) {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // sommità della cella: i voli più alti passano sopra
    const c = cellAt(cell);
    const { px, py } = t.toPx(c.x, c.y);
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = color;
    ctx.font = '11px monospace';
    ctx.fillText(`CB ${String(cell.topFL).padStart(3, '0')}`, px - 20, py + 4);
  }
  ctx.restore();
}

function drawAreas(ctx, t, sim, selected, cw, ch) {
  if (!sim.areaSchedule) return;
  const clock = sim.clockS;
  const s = airspace.sector;
  const red = new Set();
  for (const a of airspace.areas) if (a.alarm) red.add(a);
  for (const ac of sim.aircraft) if (ac.areaConflict && (ac.control === 'assumed' || ac.control === 'offered')) red.add(ac.areaConflict.area);
  if (selected?.areaConflict) red.add(selected.areaConflict.area);
  const labels = [];
  ctx.save();
  for (const a of airspace.areas) {
    const tl = t.toPx(a.bbox.xMin, a.bbox.yMin);
    const br = t.toPx(a.bbox.xMax, a.bbox.yMax);
    if (br.px < 0 || tl.px > cw || br.py < 0 || tl.py > ch) continue;
    const active = isActiveAt(sim.areaSchedule, a, clock);
    const next = active ? null : currentOrNextWindow(sim.areaSchedule, a, clock);
    const preactive = !!next && next[0] - clock <= PREACTIVE_S;
    const ours = areaOverlapsBand(a, s.floorFL * 100, s.ceilingFL * 100, 2000);
    const alarm = red.has(a);
    if (!active && !preactive && !alarm && !radarView.inactiveAreas) continue;
    pathOf(ctx, t, a.polygon, true);
    if (alarm) {
      ctx.fillStyle = `rgba(${AREA_RED}, ${a.alarm ? 0.13 : 0.09})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${AREA_RED}, ${a.alarm ? 0.9 : 0.6})`;
      ctx.lineWidth = a.alarm ? 2 : 1.4;
      ctx.setLineDash([]);
    } else if (active) {
      ctx.fillStyle = `rgba(${AREA_GREY}, ${ours ? 0.15 : 0.07})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${AREA_GREY}, ${ours ? 0.6 : 0.3})`;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([]);
    } else if (preactive) {
      ctx.strokeStyle = `rgba(${AREA_GREY}, 0.5)`;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([6, 4]);
    } else {
      ctx.strokeStyle = `rgba(${AREA_GREY}, 0.13)`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (active || preactive || alarm || ours) {
      const when = active ? '' : next ? ` ${fmtClock(next[0]).replace(':', '')}` : '';
      labels.push({ a, alarm, dim: !alarm && ((active && !ours) || (!active && !preactive)), text: `${a.name}${when}`, band: areaBand(a) });
    }
  }
  // etichette sopra i contorni: nome (con l'ora d'inizio se non è ancora attiva) e limiti verticali
  ctx.textAlign = 'center';
  for (const l of labels) {
    const p = t.toPx(l.a.labelAt.x, l.a.labelAt.y);
    const y = p.py + l.a.stack * 26 - 4;
    const color = l.alarm ? `rgba(${AREA_RED}, 1)` : `rgba(${AREA_GREY}, ${l.dim ? 0.45 : 0.85})`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = HALO;
    ctx.font = 'bold 11px monospace';
    ctx.strokeText(l.text, p.px, y);
    ctx.fillStyle = color;
    ctx.fillText(l.text, p.px, y);
    ctx.font = '10px monospace';
    ctx.strokeText(l.band, p.px, y + 12);
    ctx.fillText(l.band, p.px, y + 12);
  }
  ctx.textAlign = 'left';

  // punto d'ingresso previsto del volo selezionato
  const c = selected?.areaConflict;
  if (c) {
    const p = t.toPx(c.x, c.y);
    ctx.strokeStyle = `rgba(${AREA_RED}, 1)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.px - 6, p.py - 6);
    ctx.lineTo(p.px + 6, p.py + 6);
    ctx.moveTo(p.px + 6, p.py - 6);
    ctx.lineTo(p.px - 6, p.py + 6);
    ctx.stroke();
    const label = `${c.area.name} F${pad(c.altFt / 100)} ${fmtClock(clock + c.t).replace(':', '')} ${Math.round(c.t / 60)} MIN`;
    ctx.font = 'bold 11px monospace';
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(8, 0, 0, 0.9)';
    ctx.fillRect(p.px + 9, p.py - 20, w, 16);
    ctx.strokeStyle = `rgba(${AREA_RED}, 0.8)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(p.px + 9, p.py - 20, w, 16);
    ctx.fillStyle = '#ff8f8f';
    ctx.fillText(label, p.px + 14, p.py - 8);
  }
  ctx.restore();
}

// Ora UTC della simulazione nell'angolo in alto a sinistra.
function drawClock(ctx, sim) {
  if (sim.clockS === undefined) return;
  ctx.save();
  ctx.font = 'bold 15px monospace';
  ctx.fillStyle = 'rgba(215, 230, 234, 0.8)';
  ctx.fillText(`${fmtClock(sim.clockS, true)} UTC`, 14, 24);
  ctx.restore();
}

function drawRouteLine(ctx, t, ac) {
  if (!ac.route || ac.route.length === 0) return;
  const exitIndex = ac.exitIndex;
  const points = ac.route.slice(0, Math.min(exitIndex + 2, ac.route.length))
    .map((id) => ({ id, wp: waypoint(id) }))
    .filter((p) => p.wp);
  let prev = t.toPx(ac.x, ac.y);
  ctx.lineWidth = 1.6;
  ctx.font = 'bold 11px monospace';
  points.forEach(({ id, wp }, i) => {
    const p = t.toPx(wp.x, wp.y);
    const afterExit = i > exitIndex;
    ctx.strokeStyle = COLORS.route;
    ctx.setLineDash(afterExit ? [5, 5] : []);
    ctx.beginPath();
    ctx.moveTo(prev.px, prev.py);
    ctx.lineTo(p.px, p.py);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!afterExit) {
      ctx.fillStyle = COLORS.route;
      ctx.fillText(id, p.px + 6, p.py - 5);
    }
    if (id === ac.exitFix) {
      ctx.strokeStyle = COLORS.route;
      ctx.beginPath();
      ctx.arc(p.px, p.py, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    prev = p;
  });
}

function drawFutureConflict(ctx, t, conflict) {
  const pa = t.toPx(conflict.a.x, conflict.a.y);
  const pb = t.toPx(conflict.b.x, conflict.b.y);

  ctx.strokeStyle = COLORS.conflict;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pa.px, pa.py);
  ctx.lineTo(pb.px, pb.py);
  ctx.stroke();

  const minutes = Math.floor(conflict.timeToConflict / 60);
  const seconds = Math.round(conflict.timeToConflict % 60).toString().padStart(2, '0');
  const label = `${minutes}:${seconds}`;
  ctx.font = 'bold 11px monospace';
  const w = ctx.measureText(label).width + 10;
  const spot = freeSpot(pa, pb, w, 16);
  ctx.fillStyle = 'rgba(10, 2, 2, 0.85)';
  ctx.fillRect(spot.x, spot.y, w, 16);
  ctx.fillStyle = '#ff6b6b';
  ctx.fillText(label, spot.x + 5, spot.y + 12);
}

// Allarme a breve termine. La linea rossa lampeggiante unisce le due tracce, che sono già rosse.
// Per le coppie che ci riguardano (almeno un volo in contatto o da assumere) le due tracce sono anche
// cerchiate e compare il tempo alla perdita di separazione, scritto fermo (non lampeggia, così si legge)
// e messo dove non copre etichette o altre tracce. Per gli allarmi dei settori vicini restano solo le
// tracce rosse e la linea: nessun conteggio, che confonderebbe con i nostri.
const STCA_LABEL_H = 17;

function drawStca(ctx, t, pair, now) {
  const pa = t.toPx(pair.a.x, pair.a.y);
  const pb = t.toPx(pair.b.x, pair.b.y);
  const on = Math.floor(now / 350) % 2 === 0;
  ctx.save();
  ctx.strokeStyle = on ? 'rgba(255, 40, 40, 1)' : 'rgba(255, 40, 40, 0.5)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(pa.px, pa.py);
  ctx.lineTo(pb.px, pb.py);
  ctx.stroke();

  if (!isConcerned(pair.a) && !isConcerned(pair.b)) {
    ctx.restore();
    return;
  }

  // cerchi attorno alle due tracce coinvolte: si individuano a colpo d'occhio
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = on ? 'rgba(255, 60, 60, 0.95)' : 'rgba(255, 60, 60, 0.45)';
  for (const p of [pa, pb]) {
    ctx.beginPath();
    ctx.arc(p.px, p.py, 14, 0, Math.PI * 2);
    ctx.stroke();
  }

  const secs = Math.max(0, Math.round(pair.timeToConflict));
  const label = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  ctx.font = 'bold 12px monospace';
  const w = ctx.measureText(label).width + 12;
  const spot = freeSpot(pa, pb, w, STCA_LABEL_H);
  ctx.fillStyle = 'rgba(8, 0, 0, 0.92)';
  ctx.fillRect(spot.x, spot.y, w, STCA_LABEL_H);
  ctx.strokeStyle = 'rgba(255, 70, 70, 0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(spot.x, spot.y, w, STCA_LABEL_H);
  ctx.fillStyle = '#ff8f8f';
  ctx.fillText(label, spot.x + 6, spot.y + 13);
  ctx.restore();
}

// Posizione per il conteggio: attorno alla metà della linea, dalla parte che copre meno etichette e tracce.
function freeSpot(pa, pb, w, h) {
  const dx = pb.px - pa.px;
  const dy = pb.py - pa.py;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  let best = null;
  let bestCost = Infinity;
  for (const along of [0, -0.2, 0.2]) {
    for (const side of [1, -1]) {
      for (const dist of [16, 34, 54]) {
        const cx = (pa.px + pb.px) / 2 + dx * along + nx * side * dist;
        const cy = (pa.py + pb.py) / 2 + dy * along + ny * side * dist;
        const r = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
        let cost = dist * 0.4 + Math.abs(along) * 60;
        for (const block of tagBlocks) cost += rectOverlap(r, block) * 0.5;
        for (const p of trackPoints) {
          if (p.px > r.x0 - 8 && p.px < r.x1 + 8 && p.py > r.y0 - 8 && p.py < r.y1 + 8) cost += 400;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = { x: r.x0, y: r.y0 };
        }
      }
    }
  }
  return best;
}

const rectOverlap = (a, b) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

// Anteprima delle istruzioni in preparazione nell'etichetta (bianco tratteggiato).
function drawPreview(ctx, t, sim, preview) {
  if (!preview) return;
  const ac = sim.aircraft.find((a) => a.id === preview.aircraftId);
  if (!ac) return;
  const { px, py } = t.toPx(ac.x, ac.y);

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 4]);

  if (preview.heading !== null) {
    const rad = (preview.heading * Math.PI) / 180;
    const len = 30 * t.scale; // ~30nm
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.sin(rad) * len, py - Math.cos(rad) * len);
    ctx.stroke();
  }

  const wp = preview.waypointId && waypoint(preview.waypointId);
  if (wp) {
    const q = t.toPx(wp.x, wp.y);
    ctx.beginPath();
    ctx.arc(q.px, q.py, 11, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Posizione del tag: nessun deconflittatore automatico, i tag possono sovrapporsi. Un clic sulla traccia
// ruota il tag di 45° in senso orario attorno ad essa, in una delle otto posizioni a linea guida fissa
// (ac.tagAngle, gradi da nord): il tag si posa dove la linea dalla traccia al bordo del blocco di testo è lunga
// LEADER_PX, qualunque sia la direzione, e tagOffset viene ricalcolato a ogni fotogramma dalla misura del testo.
// Trascinando il tag la distanza diventa libera (tagAngle = null) finché non si clicca di nuovo la traccia.
// Le otto posizioni usate dal deconflittatore sono calcolate sul blocco di testo (allineato a sinistra nel
// riquadro largo TAG_W, circa TAG_TEXT_HALF_W px per lato attorno al suo centro, spostato di TAG_TEXT_SHIFT px
// a sinistra del centro del riquadro), così il testo non copre mai la traccia.
const TAG_TEXT_HALF_W = 48;
const TAG_TEXT_SHIFT = 9;
const TAG_GAP = 14;
export const LEADER_PX = 18;

function tagRing(ac, deg) {
  const rad = (deg * Math.PI) / 180;
  const sx = Math.sin(rad);
  const sy = -Math.cos(rad);
  return { sx, sy, r: TAG_TEXT_HALF_W * Math.abs(sx) + (tagHeight() / 2) * Math.abs(sy) + TAG_GAP };
}

// Direzione attuale del tag (0 = nord, in senso orario): la posizione fissa se c'è, altrimenti quella del
// blocco di testo rispetto alla traccia dopo un trascinamento.
function tagDirection(ac) {
  if (ac.tagAngle !== null && ac.tagAngle !== undefined) return ac.tagAngle;
  return (Math.atan2(ac.tagOffset.x - TAG_TEXT_SHIFT, -ac.tagOffset.y) * 180) / Math.PI;
}

export function rotateTag(ac) {
  const next = ((Math.round(tagDirection(ac) / 45) * 45 + 45) % 360 + 360) % 360;
  ac.tagAngle = next;
  // l'offset vero si ricalcola al prossimo fotogramma; intanto una stima sulle misure di riferimento
  const { sx, sy, r } = tagRing(ac, next);
  ac.tagOffset.x = sx * r + TAG_TEXT_SHIFT;
  ac.tagOffset.y = sy * r;
}

// Il tag è stato messo a mano (trascinato o deconflittato): la distanza dalla traccia resta quella scelta.
export function freeTag(ac) {
  ac.tagAngle = null;
}

// Centro del blocco di testo (hw, hh: semilarghezza e semialtezza) perché la linea guida dalla traccia (px, py)
// lungo la direzione deg sia lunga LEADER_PX fino al bordo del blocco.
function fixedBlockCentre(px, py, deg, hw, hh) {
  const rad = (deg * Math.PI) / 180;
  const sx = Math.sin(rad);
  const sy = -Math.cos(rad);
  const reach = Math.min(hw / Math.max(Math.abs(sx), 1e-6), hh / Math.max(Math.abs(sy), 1e-6));
  const r = LEADER_PX + reach;
  return { cx: px + sx * r, cy: py + sy * r };
}

// Deconflitta una volta sola i tag visibili, nella situazione attuale: nessun effetto continuo, dopo il clic
// i tag restano dove sono stati messi finché il controllore non li sposta. Ogni tag sceglie fra le otto
// posizioni attorno alla traccia (a tre distanze) quella che non copre altri tag, altre tracce o linee guida;
// a parità resta dov'era. Prima si sistemano i voli di competenza, poi due passate di rifinitura.
const DECONFLICT_EXTRA = [0, 18, 36];
const TRACK_CLEAR_PX = 7;

function tagBlock(ac, anchor, offset) {
  const hw = TAG_TEXT_HALF_W;
  const hh = tagHeight() / 2 - 2;
  const cx = anchor.px + offset.x - TAG_TEXT_SHIFT;
  const cy = anchor.py + offset.y;
  return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
}

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

const inRect = (r, x, y, m = 0) => x >= r.x0 - m && x <= r.x1 + m && y >= r.y0 - m && y <= r.y1 + m;

// quanti dei punti lungo la linea traccia-centro del tag cadono nel riquadro r
function leaderHits(anchor, block, r) {
  const bx = (block.x0 + block.x1) / 2;
  const by = (block.y0 + block.y1) / 2;
  let n = 0;
  for (let k = 1; k <= 6; k++) {
    const f = k / 7;
    if (inRect(r, anchor.px + (bx - anchor.px) * f, anchor.py + (by - anchor.py) * f)) n++;
  }
  return n;
}

export function deconflictTags(canvas, aircraftList) {
  const t = makeTransform(canvas);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const items = aircraftList.filter(tagVisible).map((ac) => ({ ac, anchor: t.toPx(ac.x, ac.y) }))
    .filter(({ anchor: p }) => p.px > -150 && p.py > -150 && p.px < cw + 150 && p.py < ch + 150);
  const tracks = aircraftList.map((ac) => ({ ac, p: t.toPx(ac.x, ac.y) }));
  items.sort((a, b) => rank(b.ac) - rank(a.ac));

  const placed = new Map(); // ac.id -> blocco del tag
  const candidates = (ac) => {
    const list = [];
    for (let i = 0; i < 8; i++) {
      for (const extra of DECONFLICT_EXTRA) {
        const { sx, sy, r } = tagRing(ac, i * 45);
        list.push({ x: sx * (r + extra) + TAG_TEXT_SHIFT, y: sy * (r + extra), extra });
      }
    }
    return list;
  };
  const cost = (item, offset) => {
    const block = tagBlock(item.ac, item.anchor, offset);
    let c = offset.extra * 1.5;
    for (const [id, other] of placed) {
      if (id === item.ac.id) continue;
      c += overlapArea(block, other) * 4;
      c += leaderHits(item.anchor, block, other) * 60;
    }
    for (const { ac, p } of tracks) {
      if (ac === item.ac) continue;
      if (inRect(block, p.px, p.py, TRACK_CLEAR_PX)) c += 800;
    }
    // le linee guida degli altri tag già sistemati non devono attraversare questo tag
    for (const other of items) {
      if (other === item || !placed.has(other.ac.id)) continue;
      c += leaderHits(other.anchor, placed.get(other.ac.id), block) * 60;
    }
    // fuori dallo schermo il tag non si legge
    if (block.x0 < 0 || block.y0 < 0 || block.x1 > cw || block.y1 > ch) c += 300;
    // a parità, meglio non spostarlo
    c += Math.hypot(offset.x - item.ac.tagOffset.x, offset.y - item.ac.tagOffset.y) * 0.05;
    return c;
  };

  for (let pass = 0; pass < 3; pass++) {
    for (const item of items) {
      let best = null;
      let bestCost = Infinity;
      for (const offset of candidates(item.ac)) {
        const c = cost(item, offset);
        if (c < bestCost) {
          bestCost = c;
          best = offset;
        }
      }
      item.ac.tagOffset.x = best.x;
      item.ac.tagOffset.y = best.y;
      item.ac.tagAngle = null;
      placed.set(item.ac.id, tagBlock(item.ac, item.anchor, best));
    }
  }
}

function aircraftColor(ac) {
  if (ac.conflict || ac.stca || ac.apw) return COLORS.conflict;
  // emergenza in rosso, urgenza (PAN PAN) e avaria radio in ambra: hanno priorità ma non sono un'emergenza
  if (ac.emergency) return ac.emergency.urgency === 'MAYDAY' ? COLORS.conflict : COLORS.warning;
  if (ac.control === 'assumed') return COLORS.assumed;
  if (ac.control === 'offered') return COLORS.offered;
  return COLORS.notInContact;
}

const pad = (fl) => Math.round(fl).toString().padStart(3, '0');

// Traccia radar come su uno schermo di controllo: simbolo di posizione (punto pieno) e scia delle ultime
// posizioni, una ogni HISTORY_S secondi: a intervalli fissi di tempo i punti di un aereo veloce sono più
// distanziati e la scia più lunga. I punti più vecchi si rimpiccioliscono e svaniscono; se sono molto
// ravvicinati (aereo lento) diventano più piccoli, così restano distinti. Il vettore velocità (posizione prevista
// fra radarView.vectorMin minuti con prua e velocità attuali) si accende e si spegne con un doppio clic sul
// nominativo nella label.
const SYMBOL_R = 3.3;
const HISTORY_DOTS = 6;

function drawTrack(ctx, t, ac, color, dim) {
  const { px, py } = t.toPx(ac.x, ac.y);
  ctx.fillStyle = color;
  const dots = Math.min(HISTORY_DOTS, ac.trail.length);
  const spacingPx = (ac.speed / 3600) * HISTORY_S * t.scale;
  const maxR = Math.max(0.8, Math.min(2, spacingPx * 0.35));
  for (let i = 0; i < dots; i++) {
    const p = t.toPx(ac.trail[ac.trail.length - 1 - i].x, ac.trail[ac.trail.length - 1 - i].y);
    const age = (i + 1) / (dots + 1);
    ctx.globalAlpha = dim * (0.9 - 0.65 * age);
    ctx.beginPath();
    ctx.arc(p.px, p.py, maxR * (1 - 0.45 * age), 0, Math.PI * 2);
    ctx.fill();
  }

  if (ac.showVector) {
    const len = (ac.speed / 60) * radarView.vectorMin * t.scale;
    const rad = (ac.heading * Math.PI) / 180;
    ctx.globalAlpha = dim * 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.sin(rad) * len, py - Math.cos(rad) * len);
    ctx.stroke();
  }

  ctx.globalAlpha = dim;
  ctx.beginPath();
  ctx.arc(px, py, SYMBOL_R, 0, Math.PI * 2);
  ctx.fill();
}

// --- range and bearing (celeste), lettura in testo semplice ---

const MEASURE_COLOR = '#7fd6ff';
let measureBoxes = []; // riquadri delle etichette disegnate nell'ultimo fotogramma, per il clic che le toglie

// Testo con un alone del colore dello sfondo, per leggerlo sopra le linee della mappa.
function plainText(ctx, text, x, y, color) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = HALO;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawMeasure(ctx, t, from, to, index) {
  const a = t.toPx(from.x, from.y);
  const b = t.toPx(to.x, to.y);
  ctx.save();
  ctx.strokeStyle = MEASURE_COLOR;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(a.px, a.py);
  ctx.lineTo(b.px, b.py);
  ctx.stroke();
  const nm = Math.hypot(to.x - from.x, to.y - from.y);
  // rilevamento nei due versi: dall'inizio verso la fine e ritorno
  const fmtBrg = (b) => String(Math.round(b) % 360 || 360).padStart(3, '0');
  const brg = bearing(from, to);
  const label = `${fmtBrg(brg)}/${fmtBrg(brg + 180)} ${nm < 10 ? nm.toFixed(1) : Math.round(nm)} NM`;
  ctx.font = 'bold 12px monospace';
  const w = ctx.measureText(label).width + 10;
  const x = (a.px + b.px) / 2 - w / 2;
  const y = (a.py + b.py) / 2 - 9;
  plainText(ctx, label, x + 5, y + 13, MEASURE_COLOR);
  ctx.restore();
  if (index !== null) measureBoxes.push({ index, x, y, w, h: 18 });
}

// Indice della misura fissata la cui etichetta si trova nel punto (px CSS), oppure -1.
export function measureAt(x, y) {
  const box = measureBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  return box ? box.index : -1;
}

// --- distanza minima fra due aerei (viola) ---
// Punto di massimo avvicinamento con prua e velocità attuali (moto rettilineo) e quote che vanno verso il livello
// autorizzato: distanza minima, fra quanto e differenza di quota in quel momento. Rosso se lì mancherebbe la
// separazione (5 NM e 1000 ft).
const CPA_COLOR = '#c9a0ff';
const CPA_MAX_S = 1800;
let cpaBoxes = [];

export function closestApproach(a, b) {
  const v = (ac) => {
    const r = (ac.heading * Math.PI) / 180;
    return { x: (Math.sin(r) * ac.speed) / 3600, y: (-Math.cos(r) * ac.speed) / 3600 };
  };
  const va = v(a);
  const vb = v(b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dvx = vb.x - va.x;
  const dvy = vb.y - va.y;
  const dv2 = dvx * dvx + dvy * dvy;
  const t = dv2 < 1e-12 ? 0 : Math.max(0, Math.min(CPA_MAX_S, -(dx * dvx + dy * dvy) / dv2));
  const pa = { x: a.x + va.x * t, y: a.y + va.y * t };
  const pb = { x: b.x + vb.x * t, y: b.y + vb.y * t };
  const altA = predictAltitude(a, t);
  const altB = predictAltitude(b, t);
  return { t, pa, pb, nm: Math.hypot(pb.x - pa.x, pb.y - pa.y), altA, altB, dFt: Math.abs(altA - altB) };
}

function drawCpa(ctx, t, a, b, index) {
  const c = closestApproach(a, b);
  const lost = c.nm < SEP_HORIZONTAL_NM && c.dFt < SEP_VERTICAL_FT;
  const color = lost ? COLORS.conflict : CPA_COLOR;
  const A = t.toPx(a.x, a.y);
  const B = t.toPx(b.x, b.y);
  const PA = t.toPx(c.pa.x, c.pa.y);
  const PB = t.toPx(c.pb.x, c.pb.y);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(A.px, A.py);
  ctx.lineTo(PA.px, PA.py);
  ctx.moveTo(B.px, B.py);
  ctx.lineTo(PB.px, PB.py);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(PA.px, PA.py);
  ctx.lineTo(PB.px, PB.py);
  ctx.stroke();
  for (const p of [PA, PB]) {
    ctx.beginPath();
    ctx.arc(p.px, p.py, 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // distanza minima, minuti al punto di massimo avvicinamento, separazione verticale in quel momento
  const nm = c.nm < 10 ? c.nm.toFixed(1) : Math.round(c.nm);
  const label = `${nm} NM ${Math.round(c.t / 60)} MIN ${Math.round(c.dFt / 100) * 100} FT`;
  ctx.font = 'bold 12px monospace';
  const w = ctx.measureText(label).width + 10;
  const x = (PA.px + PB.px) / 2 - w / 2;
  const y = (PA.py + PB.py) / 2 + 8;
  if (lost) {
    ctx.fillStyle = COLORS.conflict;
    ctx.fillRect(x, y, w, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 5, y + 13);
  } else {
    plainText(ctx, label, x + 5, y + 13, color);
  }
  ctx.restore();
  cpaBoxes.push({ index, x, y, w, h: 18 });
}

// Indice della coppia la cui etichetta si trova nel punto (px CSS), oppure -1.
export function cpaAt(x, y) {
  const box = cpaBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  return box ? box.index : -1;
}

// Primo aereo scelto con lo strumento, in attesa del secondo: cerchio viola tratteggiato.
function drawCpaPick(ctx, t, ac) {
  const p = t.toPx(ac.x, ac.y);
  ctx.save();
  ctx.strokeStyle = CPA_COLOR;
  ctx.lineWidth = 1.6;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(p.px, p.py, 15, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawAircraft(ctx, t, ac, now) {
  const { px, py } = t.toPx(ac.x, ac.y);
  const color = aircraftColor(ac);
  const inContact = ac.control === 'assumed' || ac.control === 'offered';
  const dim = inContact ? 1 : 0.8;

  drawTrack(ctx, t, ac, color, dim);
  trackPoints.push({ px, py });

  if (ac.selected) {
    ctx.strokeStyle = COLORS.selected;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(px, py, 11, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (!tagVisible(ac)) {
    ctx.globalAlpha = 1;
    return;
  }
  // Label integrata. Colonne fisse di un carattere:
  //   0-2       3     4-8       10-12
  //   CALLSIGN                  HDG         (HDG solo col mouse sopra)
  //   LEV       ↑↓    EFX         VR
  //   SPD       w/t   ALV       COO
  //   SLB             XFL       NXS
  // Sopra, gli allarmi in rosso (e la cornice rossa). In ciano i dati letti da bordo (HDG, VR, SPD, SLB); ALV e SLB
  // diventano arancioni se il livello selezionato a bordo non è quello autorizzato. Senza il mouse si vedono solo i
  // campi con un valore; col mouse sopra la label è grigia e mostra anche i campi vuoti in minuscolo (efx, coo,
  // xfl, nxs). Sui voli in contatto ALV e SPD si cliccano per autorizzare un altro valore.
  const hovered = isHovered(ac);
  const tDim = hovered ? 1 : dim;
  const rows = labelRows(ctx, ac, color, hovered);

  const textW = measureRows(ctx, rows);

  // la quarta riga (salita o discesa) cresce dalla parte opposta alla traccia
  // posizione delle righe: quella della label senza mouse, che cresce (riga dell'SLB) dalla parte opposta alla
  // traccia. Col mouse sopra le righe restano ferme dove sono e i campi in più si aggiungono sotto: così il campo
  // su cui si sta per cliccare (velocità, livello…) non si sposta sotto il cursore.
  const baseH = tagHeight();
  const h = 8 + TAG_LINE * rows.length;
  const restRows = hovered ? labelRows(ctx, ac, color, false) : rows;
  const restH = 8 + TAG_LINE * restRows.length;
  const restW = hovered ? measureRows(ctx, restRows) : textW;
  let boxLeft;
  let boxTop;
  if (ac.tagAngle !== null && ac.tagAngle !== undefined) {
    // posizione fissa: il blocco di testo (senza mouse) sta a LEADER_PX dalla traccia nella direzione scelta;
    // tagOffset si aggiorna di conseguenza, così trascinamento e deconflittatore ripartono da qui
    const hw = (restW + 8) / 2;
    const hh = (restH - 6) / 2;
    const { cx, cy } = fixedBlockCentre(px, py, ac.tagAngle, hw, hh);
    boxLeft = cx - hw - 3;
    boxTop = cy - restH / 2;
    const tagY = boxTop + baseH / 2;
    ac.tagOffset.x = boxLeft + TAG_W / 2 - px;
    ac.tagOffset.y = (tagY - py < -5 ? boxTop + restH - baseH / 2 : tagY) - py;
  } else {
    const tagX = px + ac.tagOffset.x;
    const tagY = py + ac.tagOffset.y;
    boxLeft = tagX - TAG_W / 2;
    const baseTop = tagY - baseH / 2;
    boxTop = ac.tagOffset.y < -5 ? baseTop - (restH - baseH) : baseTop;
  }

  // linea guida dalla traccia al bordo del blocco di testo (non lo attraversa)
  const block = { ac, x0: boxLeft + 3, x1: boxLeft + 11 + textW, y0: boxTop + 3, y1: boxTop + h - 3 };
  tagBlocks.push(block);
  const end = edgePoint(px, py, (block.x0 + block.x1) / 2, (block.y0 + block.y1) / 2, block);
  if (end) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = tDim * 0.6;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  // riquadro grigio col mouse sopra
  if (hovered) {
    const r = [block.x0 - 1.5, block.y0 - 1.5, block.x1 - block.x0 + 3, block.y1 - block.y0 + 3];
    ctx.globalAlpha = 1;
    ctx.fillStyle = HOVER_BG;
    ctx.fillRect(...r);
    ctx.strokeStyle = HOVER_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(...r);
  }

  // il traffico passato a noi lampeggia (nominativo) finché non si fa hand-on
  const blink = ac.control === 'offered' && Math.floor(now / 450) % 2 === 0;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = HALO;
  const x0 = boxLeft + 7;
  rows.forEach((row, i) => {
    const y = boxTop + 17 + TAG_LINE * i;
    for (const seg of row) {
      const x = seg.center ? x0 + (textW - seg.w) / 2 : x0 + seg.dx;
      ctx.font = seg.font;
      ctx.globalAlpha = tDim * (seg.key === 'name' && blink ? 0.35 : 1);
      if (!hovered) ctx.strokeText(seg.text, x, y);
      ctx.fillStyle = seg.color;
      ctx.fillText(seg.text, x, y);
      // il nominativo si può cliccare due volte per aprire il pannello delle istruzioni
      if (seg.key === 'name') tagNames.push({ ac, x0: x - 3, x1: x + seg.w + 3, y0: y - 13, y1: y + 4 });
      // prua, prossimo punto, rateo, livello autorizzato e velocità si cliccano per cambiarli (voli in contatto)
      if (seg.key && seg.key !== 'name' && ac.control === 'assumed') {
        tagFields.push({ ac, kind: seg.key, x0: x - 3, x1: x + Math.max(seg.w, 3 * cwOf(ctx)) + 3, y0: y - 12, y1: y + 4 });
      }
    }
  });
  ctx.globalAlpha = 1;
}

const LABEL_FONT = '13px monospace';
const NAME_FONT = 'bold 13px monospace';
const DOWNLINK = '#45c8ee';                   // dati letti da bordo (ciano)
const XFL_NEAR_FT = 2000;                     // livello arancione a meno di 2000 ft dal livello di passaggio
const MISMATCH = '#ff9f40';                   // livello selezionato a bordo diverso dall'autorizzato
const XFL_COLOR = '#d68cff';                  // livello d'uscita
const XFL_EMPTY = '#e8eef0';
const HOVER_BG = 'rgba(92, 100, 112, 0.9)';
const HOVER_BORDER = 'rgba(210, 218, 228, 0.7)';

function cwOf(ctx) {
  ctx.font = LABEL_FONT;
  return ctx.measureText('0').width;
}

// Larghezza del testo delle righe (px), misurando ogni segmento (seg.w) con il suo carattere.
function measureRows(ctx, rows) {
  let textW = 0;
  for (const row of rows) {
    for (const seg of row) {
      ctx.font = seg.font;
      seg.w = ctx.measureText(seg.text).width;
      if (!seg.center) textW = Math.max(textW, seg.dx + seg.w);
    }
  }
  return textW;
}

// Sigla di tre lettere dell'ente successivo: settore (NWM, NEA…), APP o ACC confinante (MIL, PAD…).
function unitCode(name) {
  if (!name) return null;
  const sector = airspace.sectorsXY.find((x) => x.name === name);
  if (sector) return sector.id.slice(0, 3).toUpperCase();
  if (/ APP$/.test(name)) return 'APP';
  return name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
}

function nextUnitCode(ac) {
  if (ac.nextUnitCode) return ac.nextUnitCode.slice(0, 3).toUpperCase();
  return unitCode(ac.nextUnit);
}

// Ente successivo e livello di passaggio dei voli non nostri, dal loro piano: lungo la rotta, il primo punto
// in cui cambia l'ente competente e il livello pianificato lì. Un volo che ci verrà passato (inbound) va al
// nostro settore al livello coordinato. Ricalcolato ogni COORD_REFRESH_MS.
const COORD_REFRESH_MS = 5000;
const COORD_STEP_NM = 5;
const COORD_AHEAD_NM = 400;

export function plannedHandoff(ac) {
  if (ac.control === 'inbound') {
    return { code: airspace.sector.id, fl: ac.entryFt ? Math.round(ac.entryFt / 1000) * 10 : null };
  }
  const now = performance.now();
  if (ac._handoff && now - ac._handoff.at < COORD_REFRESH_MS) return ac._handoff;
  let result = { code: null, fl: null, at: now };
  if (ac.flow && ac.profile) {
    const s0 = ac.alongTrackNm();
    const here = unitAt(ac, ac.altitude);
    const sector = sectorAt(ac, ac.altitude);
    // il volo può essere un po' fuori dal profilo (deviazioni, rotta accorciata): il profilo si usa per come
    // cambia la quota da qui in avanti, a partire dalla quota vera, senza mai superare il livello di crociera
    const offset = ac.altitude - profileAltitude(ac.profile, s0);
    const ceilingFt = (ac.rfl ?? 999) * 100;
    const end = Math.min(ac.flow.total, s0 + COORD_AHEAD_NM);
    for (let s = s0 + COORD_STEP_NM; s <= end; s += COORD_STEP_NM) {
      const alt = Math.max(0, Math.min(ceilingFt, profileAltitude(ac.profile, s) + offset));
      const unit = unitAt(pointAlong(ac.flow, s), alt);
      if (unit !== here) {
        let fl = Math.round(alt / 1000) * 10;
        // come per i nostri voli: in salita o in crociera un settore dell'ACC passa il volo al livello di crociera
        // richiesto, oppure a quello più vicino al suo limite superiore se non ci arriva; in discesa attraverso il
        // limite inferiore, al livello più vicino a quel limite
        const phase = sector ? profilePhase(ac.profile, s - COORD_STEP_NM) : 'cruise';
        const p = pointAlong(ac.flow, s);
        if (phase !== 'descent' && sector && ac.rfl) fl = Math.min(ac.rfl, topTransferFL(sector));
        else if (phase === 'descent' && pointInPolygon(p.x, p.y, sector.polygonXY)) fl = bottomTransferFL(sector);
        result = { code: unitCode(unit), fl, at: now };
        break;
      }
    }
  }
  ac._handoff = result;
  return result;
}

// Livello richiesto in rotta (XFL): il livello di crociera del piano di volo (RFL), lo stesso per tutta la rotta.
function routeLevel(ac) {
  return ac.rfl ?? null;
}

const pad3 = (n) => String(Math.round(n)).padStart(3, '0');

const fmtMach = (m) => {
  const v = Math.round(m * 100);
  return v >= 100 ? (v / 100).toFixed(2) : `.${String(v).padStart(2, '0')}`;
};

// Velocità: da FL250 in su in Mach (".74"), sotto in nodi. Quella letta a bordo in ciano, quella assegnata da
// noi nel colore della label.
function speedField(ac, color) {
  const mach = ac.altitude >= MACH_FROM_FT;
  if (ac.speedMode === 'assigned' && fullLabel(ac)) {
    return { text: mach ? fmtMach(ac.assignedSpeed / soundSpeedKt(ac.altitude)) : pad3(ac.assignedSpeed), color };
  }
  return { text: mach ? fmtMach(ac.speed / soundSpeedKt(ac.altitude)) : pad3(ac.speed), color: DOWNLINK };
}

// Righe della label, sullo schema della label integrata (colonne di un carattere):
//   CALLSIGN          HDG           HDG col mouse sopra, oppure assegnata (vettoramento)
//   LEV ↑  EFX        VR            freccia e VR solo in salita o discesa
//   SPD w/t ALV       NXT           ALV col mouse sopra o in salita/discesa; NXT col mouse sopra
//   SLB    XFL        COO           solo in salita o discesa: SLB se diverso dall'ALV, XFL e COO col mouse sopra
// EFX è il prossimo punto della rotta, VR il rateo in centinaia di ft/min, SLB il livello selezionato a bordo,
// XFL il livello richiesto in rotta (crociera del piano di volo), COO il livello d'uscita
// dal settore, NXT il settore successivo (per i voli non nostri, ricavati dal loro piano). Il traffico non in
// contatto, senza il mouse sopra, mostra solo nominativo e livello.
// Col mouse sopra i campi senza valore restano in minuscolo (efx, nxt, xfl, coo): anche vuoti si cliccano.
// Ogni campo: {text, dx (px dall'inizio della riga), color, font, key (campo cliccabile)}.
function labelRows(ctx, ac, color, hovered) {
  const cw = cwOf(ctx);
  const cArrow = 3 * cw;
  const cMid = 4 * cw;
  const cRight = 10 * cw; // i punti italiani hanno 5 lettere: colonna centrale 4-8, destra 10-12
  const field = (text, dx, c, key = null, font = LABEL_FONT) => ({ text, dx, color: c, font, key });
  // campo con un valore, oppure (solo col mouse sopra) il suo nome in minuscolo
  const opt = (row, v, dx, c, empty, key = null, emptyColor = color) => {
    if (v !== null && v !== undefined) row.push(field(v, dx, c, key));
    else if (hovered) row.push(field(empty, dx, emptyColor, key));
  };
  const evolving = isEvolving(ac);

  // il nominativo resta nel colore della label anche da selezionato: la selezione si vede dal cerchio sulla traccia
  const nameRow = [field(ac.callsign, 0, color, 'name', NAME_FONT)];
  ctx.font = NAME_FONT;
  let nameEnd = ctx.measureText(ac.callsign).width;
  // asterisco rosso: proseguendo con rotta e livello autorizzato il volo entrerà in una zona attiva
  if (fullLabel(ac) && ac.areaConflict) {
    nameRow.push(field('*', nameEnd + 2, COLORS.conflict, null, 'bold 16px monospace'));
    nameEnd += 2 + ctx.measureText('*').width;
  }
  // prua: col mouse sopra quella letta da bordo (ciano); se il volo è vettorato quella assegnata (colore della
  // label), sempre visibile finché non riprende la rotta
  const hdgAssigned = ac.mode === 'heading' && fullLabel(ac);
  if (hovered || hdgAssigned) {
    const hdg = pad3(Math.round(hdgAssigned ? ac.assignedHeading : ac.heading) % 360 || 360);
    nameRow.push(field(hdg, Math.max(cRight, nameEnd + cw), hdgAssigned ? color : DOWNLINK, 'heading'));
  }
  const rows = [nameRow];

  // livello, freccia di tendenza, prossimo punto e rateo verticale
  const vfpm = ac.verticalFpm ?? 0;
  const diff = ac.assignedAltitude - ac.altitude;
  const up = Math.abs(vfpm) >= 100 ? vfpm > 0 : diff > 0;
  // livello di volo arancione quando si avvicina al livello di passaggio al settore superiore o inferiore
  // (entro XFL_NEAR_FT, andandoci incontro o già arrivato): è il momento dell'hand-off
  const toXfl = ac.requestedExitFL !== null && ac.requestedExitFL !== undefined ? ac.requestedExitFL * 100 - ac.altitude : null;
  const nearXfl = ac.control === 'assumed' && ac.verticalExit && toXfl !== null && Math.abs(toXfl) <= XFL_NEAR_FT
    && (Math.abs(toXfl) < 100 || Math.sign(toXfl) === Math.sign(ac.verticalFpm ?? 0));
  const levRow = [field(pad3(ac.flightLevel), 0, nearXfl ? COLORS.warning : color)];
  if (evolving) levRow.push(field(up ? '↑' : '↓', cArrow, color));
  // traffico non in contatto senza il mouse sopra: solo nominativo e livello
  if (!fullLabel(ac) && !hovered) {
    rows.push(levRow);
    return rows;
  }
  const nextFix = ac.mode === 'route' ? ac.route[0] ?? null : null;
  opt(levRow, nextFix, cMid, color, 'efx', 'fix');
  if (evolving && Math.abs(vfpm) >= 100) {
    levRow.push(field(String(Math.round(Math.abs(vfpm) / 100)).padStart(2, '0'), 11 * cw, DOWNLINK, 'rate'));
  }
  rows.push(levRow);

  // velocità e scia; livello autorizzato col mouse sopra o in salita/discesa (per un volo da assumere quello
  // coordinato dall'ente precedente, per il traffico non nostro quello verso cui sta andando), arancione se a
  // bordo è selezionato un livello diverso
  const assumed = ac.control === 'assumed';
  const alv = assumed ? ac.clearedFL
    : ac.control === 'offered' && ac.entryFt ? Math.round(ac.entryFt / 1000) * 10
      : Math.round(ac.assignedAltitude / 1000) * 10;
  const slb = ac.slbFL ?? alv;
  const mismatch = assumed && slb !== alv;
  // livello autorizzato diverso da quello d'uscita dal settore (o da quello rivisto dopo una richiesta)
  const exitMismatch = fullLabel(ac) && ac.requestedExitFL !== null && ac.requestedExitFL !== undefined
    && alv !== ac.requestedExitFL && alv !== ac.altExitFL;
  const spd = speedField(ac, color);
  const spdRow = [field(spd.text, 0, spd.color, 'speed'), field(ac.type?.wake ?? '', cArrow, color)];
  if (hovered || evolving) spdRow.push(field(pad3(alv), cMid, mismatch ? MISMATCH : color, 'fl'));
  // ente successivo e livello d'uscita: quelli coordinati per i nostri voli, quelli del piano per gli altri
  const handoff = fullLabel(ac) ? null : plannedHandoff(ac);
  // settore successivo: col mouse sopra, sia da livellato sia in salita o discesa
  if (hovered) opt(spdRow, handoff ? handoff.code : nextUnitCode(ac), cRight, color, 'nxt');
  rows.push(spdRow);

  if (evolving) {
    // SLB solo quando a bordo è selezionato un livello diverso dall'autorizzato (arancione come l'ALV)
    const slbRow = mismatch ? [field(pad3(slb), 0, MISMATCH)] : [];
    if (hovered) {
      // XFL: livello richiesto nel piano di volo; COO: livello d'uscita dal settore (arancione se l'autorizzato
      // non lo rispetta)
      const xfl = routeLevel(ac);
      opt(slbRow, xfl ? pad3(xfl) : null, cMid, XFL_COLOR, 'xfl', null, XFL_EMPTY);
      if (handoff) opt(slbRow, handoff.fl ? pad3(handoff.fl) : null, cRight, color, 'coo');
      else {
        opt(slbRow, ac.requestedExitFL === null || ac.requestedExitFL === undefined ? null : pad3(ac.requestedExitFL),
          cRight, exitMismatch ? COLORS.warning : color, 'coo');
      }
    }
    if (slbRow.length) rows.push(slbRow);
  } else if (hovered && exitMismatch) {
    // livellato col mouse sopra: il livello d'uscita compare (arancione) solo se l'autorizzato non lo rispetta
    rows.push([field(pad3(ac.requestedExitFL), cRight, COLORS.warning, 'coo')]);
  }
  return rows;
}

// Riquadri dei testi dei tag e posizioni delle tracce dell'ultimo fotogramma: servono a mettere il
// conteggio dell'STCA dove non copre nulla.
let tagBlocks = [];
let trackPoints = [];

// Riquadro della label di un volo nell'ultimo fotogramma (px CSS), oppure null se non è disegnata.
export function labelBlock(ac) {
  return tagBlocks.find((b) => b.ac === ac) ?? null;
}

// Label sotto il punto (px CSS), secondo quanto disegnato nell'ultimo fotogramma: la più in alto.
export function labelAt(x, y) {
  for (let i = tagBlocks.length - 1; i >= 0; i--) {
    const b = tagBlocks[i];
    if (x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 2) return b.ac;
  }
  return null;
}

// Nominativi scritti sui tag: un doppio clic apre il pannello laterale delle istruzioni.
let tagNames = [];

export function tagNameAt(x, y) {
  for (let i = tagNames.length - 1; i >= 0; i--) {
    const f = tagNames[i];
    if (x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) return f.ac;
  }
  return null;
}

// Livello e velocità scritti sui tag dei voli in contatto: un clic apre il menu per autorizzarne un altro.
let tagFields = [];

export function tagFieldAt(x, y) {
  for (let i = tagFields.length - 1; i >= 0; i--) {
    const f = tagFields[i];
    if (x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) return { ac: f.ac, kind: f.kind };
  }
  return null;
}

// Punto in cui il segmento dall'esterno (ax, ay) verso (bx, by) entra nel rettangolo r; null se parte già dentro.
function edgePoint(ax, ay, bx, by, r) {
  if (ax >= r.x0 && ax <= r.x1 && ay >= r.y0 && ay <= r.y1) return null;
  let tEnter = 0;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [[-dx, ax - r.x0], [dx, r.x1 - ax], [-dy, ay - r.y0], [dy, r.y1 - ay]]) {
    if (p < 0) tEnter = Math.max(tEnter, q / p);
  }
  return { x: ax + dx * tEnter, y: ay + dy * tEnter };
}

// measures: linee R&B fissate {a, b}, ciascun estremo un aereo o un punto della mappa {x, y}; measuring: linea
// in corso {from, x, y} dal punto d'inizio al cursore (px CSS). cpas: coppie per la distanza minima {a, b};
// cpaPick: primo aereo scelto per una nuova coppia.
export function render(ctx, canvas, sim, {
  futureConflicts = [], stca = [], preview = null, now = 0, measures = [], measuring = null, cpas = [], cpaPick = null,
} = {}) {
  const t = makeTransform(canvas);
  blitStaticMap(ctx, canvas, t);

  const selected = sim.aircraft.find((ac) => ac.selected);
  drawWeather(ctx, t, sim);
  drawAreas(ctx, t, sim, selected, canvas.clientWidth, canvas.clientHeight);
  drawClock(ctx, sim);
  if (selected) drawRouteLine(ctx, t, selected);
  drawPreview(ctx, t, sim, preview);

  // prima il traffico non in contatto, sopra quello di nostra competenza
  const order = [...sim.aircraft].sort((a, b) => rank(a) - rank(b));
  tagFields = [];
  tagNames = [];
  tagBlocks = [];
  trackPoints = [];
  for (const ac of order) drawAircraft(ctx, t, ac, now);
  measureBoxes = [];
  measures.forEach((m, i) => drawMeasure(ctx, t, m.a, m.b, i));
  if (measuring) drawMeasure(ctx, t, measuring.from, t.fromPx(measuring.x, measuring.y), null);
  cpaBoxes = [];
  cpas.forEach((c, i) => drawCpa(ctx, t, c.a, c.b, i));
  if (cpaPick) drawCpaPick(ctx, t, cpaPick);
  const alarmed = new Set(stca.map((p) => `${p.a.id}-${p.b.id}`));
  for (const conflict of futureConflicts) {
    if (!alarmed.has(`${conflict.a.id}-${conflict.b.id}`)) drawFutureConflict(ctx, t, conflict);
  }
  for (const pair of stca) drawStca(ctx, t, pair, now);

  return t;
}

function rank(ac) {
  if (isHovered(ac)) return 4;
  if (ac.selected) return 3;
  if (ac.control === 'assumed') return 2;
  if (ac.control === 'offered') return 1;
  return 0;
}
