import { Simulation, MAX_STRIKES } from './sim.js';
import {
  render, makeTransform, measureAt, radarView, resetView, panBy, zoomTo, ZOOM_RANGE, tagVisible, TAG_FL_RANGE,
  rotateTag, freeTag, waypointShown, VECTOR_RANGE, deconflictTags, tagFieldAt, tagNameAt, cpaAt, labelAt, setHovered, labelBlock,
} from './radar.js';
import {
  AREA_KINDS, areaBand, fmtClock, isActiveAt, currentOrNextWindow, PREACTIVE_S,
} from './areas.js';
import { LabelPanel } from './label.js';
import { emergencyCall } from './emergency.js';
import { REQUEST_TAG } from './requests.js';
import { airspace, loadSector, sectorSummary, isFraPoint, inView } from './airspace.js';
import {
  SECTORS, DIFFICULTY, DIFFICULTY_ORDER, sectorDemand, LAYERS, LAYER_ORDER, ACC_BOUNDARY, CENTRES, CENTRE, setCentre,
} from './sectors.js';
import { EMERGENCY_PCT_DEFAULT } from './emergency.js';
import { WEATHER_DEFAULT } from './weather.js';
import { COASTLINE, ACC_BOUNDARIES } from './data/chart.js';
import { soundSpeedKt, MACH_FROM_FT } from './performance.js';
import { makeProjection, distance } from './geo.js';
import { Tutorial, LESSONS, loadProgress, resumePoint, fillBackground } from './tutorial.js';
import {
  APP_NAME, TAGLINE, CONTACT, ABOUT, DISCLAIMER, SOURCES, PROJECT_URL, ISSUES_URL, donateUrl, openExternal,
  appVersion,
} from './support.js';

const canvas = document.getElementById('radar');
const ctx = canvas.getContext('2d');
const pane = document.getElementById('radar-pane');
const $ = (id) => document.getElementById(id);

let sim = null;
let currentSectorId = null;
let hoveredAc = null;      // volo sotto il mouse (serve anche al tutorial)
let tutorial = null;       // modalità guidata, creata alla prima lezione
const labelPanel = new LabelPanel(document, null);

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = pane.clientWidth * dpr;
  canvas.height = pane.clientHeight * dpr;
  // Da qui in poi tutte le coordinate di disegno sono in px CSS,
  // indipendenti dalla densità di pixel dello schermo (Retina compreso).
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawStartMap();
}
window.addEventListener('resize', resizeCanvas);
// la mappa della schermata iniziale si ridisegna a ogni cambio di dimensione: aprendo le regole il
// riquadro si accorcia, e un disegno vecchio verrebbe solo schiacciato
if (window.ResizeObserver) new ResizeObserver(() => drawStartMap()).observe($('start-map'));

const fmtTime = (s) => {
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtFl = (fl) => `FL${String(Math.round(fl)).padStart(3, '0')}`;
const fmtBand = (floorFL, ceilingFL) => `${fmtFl(floorFL)}–${fmtFl(ceilingFL)}`;

// --- notifiche sul radar ---------------------------------------------------

const MAX_TOASTS = 3;

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  const box = $('toasts');
  box.prepend(el);
  // la colonna non cresce oltre qualche riga: le notifiche più vecchie escono subito
  while (box.children.length > MAX_TOASTS) box.lastElementChild.remove();
  setTimeout(() => el.classList.add('leaving'), 4200);
  setTimeout(() => el.remove(), 4800);
}

// --- messaggi dei piloti ---------------------------------------------------
// Le chiamate radio restano in alto a destra finché il volo è di nostra competenza. Due righe strette:
// chi chiama (con quota e tipo di chiamata) e le sue parole. Lo stato esteso sta nell'etichetta.

let lastRadioKey = '';

function radioRows() {
  return sim.messages.map((m) => {
    const ac = sim.aircraft.find((a) => a.id === m.acId);
    const e = ac?.emergency;
    const r = ac?.request;
    let head = m.callsign;
    if (e) head = `${ac.callsign} ${fmtFl(ac.flightLevel)} · ${emergencyCall(e)}`;
    else if (r) head = `${ac.callsign} ${fmtFl(ac.flightLevel)} · ${REQUEST_TAG[r.kind]}`;
    return { m, ac, head, pending: (!!e && e.phase === 'requested') || r?.phase === 'pending' };
  });
}

// Poche righe sul radar: prima le emergenze, poi le richieste in attesa, poi il resto.
const MAX_RADIO_ROWS = 3;

function rankRow(r) {
  if (r.ac?.emergency) return 0;
  if (r.pending) return 1;
  return 2;
}

function updateRadioMessages() {
  const all = radioRows();
  const sorted = [...all].sort((a, b) => rankRow(a) - rankRow(b) || a.m.id - b.m.id);
  const rows = sorted.slice(0, MAX_RADIO_ROWS);
  const hidden = sorted.length - rows.length;
  const key = `${hidden}\u00b6${rows.map((r) => `${r.m.id}|${r.m.text}|${r.head}|${r.pending}`).join('\u00b6')}`;
  if (key === lastRadioKey) return;
  lastRadioKey = key;
  const box = $('radio-msgs');
  box.innerHTML = '';
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = `radio-msg ${row.m.kind}${row.pending ? ' pending' : ''}`;
    el.innerHTML = '<div class="radio-head"></div><div class="radio-text"></div>';
    el.querySelector('.radio-head').textContent = row.head;
    el.querySelector('.radio-text').textContent = row.m.text;
    if (row.ac) {
      el.title = `${row.m.text} — open ${row.ac.callsign}`;
      el.addEventListener('click', () => labelPanel.select(row.ac));
    } else {
      el.style.cursor = 'default';
    }
    box.appendChild(el);
  }
  if (hidden > 0) {
    const more = document.createElement('div');
    more.className = 'radio-more';
    more.textContent = `+${hidden} more`;
    box.appendChild(more);
  }
}

// --- scelta del settore ----------------------------------------------------

let hoveredSector = null;
let activeLayer = 'alto';

function buildCentreTabs() {
  const tabs = $('centre-tabs');
  tabs.innerHTML = '';
  for (const c of CENTRES) {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'tab');
    btn.dataset.centre = c.id;
    btn.innerHTML = `${c.name}<span>${c.subtitle}</span>`;
    btn.addEventListener('click', () => selectCentre(c.id));
    tabs.appendChild(btn);
  }
}

// Cambio di ACC: settori, strati, perimetro e inquadratura della mappa vengono dal centro scelto.
function selectCentre(centreId) {
  const centre = setCentre(centreId);
  hoveredSector = null;
  document.querySelectorAll('#centre-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.centre === centreId);
    b.setAttribute('aria-selected', String(b.dataset.centre === centreId));
  });
  $('start-title').textContent = centre.name;
  $('start-sub').textContent = centre.description;
  document.title = `ACS Simulator · ${centre.name}`;
  buildLayerTabs();
  selectLayer(centre.layerOrder.includes(activeLayer) ? activeLayer : centre.layerOrder[0]);
}

function buildLayerTabs() {
  const tabs = $('layer-tabs');
  tabs.innerHTML = '';
  for (const layerId of LAYER_ORDER) {
    const sectors = SECTORS.filter((x) => x.layer === layerId);
    const floor = Math.min(...sectors.map((x) => x.floorFL));
    const ceiling = Math.max(...sectors.map((x) => x.ceilingFL));
    const btn = document.createElement('button');
    btn.setAttribute('role', 'tab');
    btn.dataset.layer = layerId;
    btn.innerHTML = `${LAYERS[layerId].label}<span>${fmtBand(floor, ceiling)}</span>`;
    btn.addEventListener('click', () => selectLayer(layerId));
    tabs.appendChild(btn);
  }
}

function selectLayer(layerId) {
  if (setupSector) closeSetup();
  activeLayer = layerId;
  hoveredSector = null;
  document.querySelectorAll('#layer-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.layer === layerId);
    b.setAttribute('aria-selected', String(b.dataset.layer === layerId));
  });
  $('layer-detail').textContent = `${LAYERS[layerId].detail} · ${LAYERS[layerId].short}`;
  buildSectorList();
  drawStartMap();
}

function buildSectorList() {
  const list = $('sector-list');
  list.innerHTML = '';
  for (const s of SECTORS.filter((x) => x.layer === activeLayer)) {
    const size = sectorSummary(s);
    const card = document.createElement('button');
    card.className = 'sector-card';
    card.dataset.sector = s.id;
    const airports = s.layer !== 'alto' && size.airports.length ? ` · ${size.airports.join(' ')}` : '';
    card.innerHTML = `
      <div class="sector-card-head">
        <strong>${s.name}</strong>
      </div>
      <div class="sector-meta">${fmtBand(s.floorFL, s.ceilingFL)} · ${Math.round(size.areaNm2 / 1000)}k NM²${airports}</div>
      <div class="sector-desc">${s.description}</div>`;
    card.addEventListener('mouseenter', () => { hoveredSector = s.id; drawStartMap(); });
    card.addEventListener('mouseleave', () => { hoveredSector = setupSector?.id ?? null; drawStartMap(); });
    card.addEventListener('click', () => openSetup(s.id));
    list.appendChild(card);
  }
}

function drawStartMap() {
  const mapCanvas = $('start-map');
  if (!mapCanvas || $('start-screen').classList.contains('hidden')) return;
  const dpr = window.devicePixelRatio || 1;
  const w = mapCanvas.clientWidth;
  const h = mapCanvas.clientHeight;
  mapCanvas.width = w * dpr;
  mapCanvas.height = h * dpr;
  const c = mapCanvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  const { lat, lon, box } = CENTRE.mapView;
  const proj = makeProjection(lat, lon);
  const scale = Math.min(w / (box.xMax - box.xMin), h / (box.yMax - box.yMin));
  const ox = (w - (box.xMax - box.xMin) * scale) / 2 - box.xMin * scale;
  const oy = (h - (box.yMax - box.yMin) * scale) / 2 - box.yMin * scale;
  const toPx = ([lat, lon]) => {
    const p = proj.toXY(lat, lon);
    return [p.x * scale + ox, p.y * scale + oy];
  };
  const line = (pts, close) => {
    c.beginPath();
    pts.forEach((p, i) => {
      const [x, y] = toPx(p);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    if (close) c.closePath();
  };

  c.fillStyle = '#050b12';
  c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(70, 150, 160, 0.55)';
  c.lineWidth = 1;
  for (const l of COASTLINE) { line(l); c.stroke(); }
  c.strokeStyle = 'rgba(170, 170, 170, 0.5)';
  c.setLineDash([8, 3, 2, 3]);
  for (const l of ACC_BOUNDARIES) { line(l); c.stroke(); }
  c.setLineDash([]);
  line(ACC_BOUNDARY, true);
  c.strokeStyle = 'rgba(215, 230, 234, 0.55)';
  c.lineWidth = 1.5;
  c.stroke();

  // si mostra uno strato alla volta: quello scelto nelle schede
  const layer = activeLayer;
  for (const s of SECTORS.filter((x) => x.layer === layer)) {
    const isHover = s.id === hoveredSector;
    line(s.polygon, true);
    c.fillStyle = isHover ? 'rgba(124, 252, 154, 0.22)' : 'rgba(110, 200, 255, 0.06)';
    c.fill();
    c.strokeStyle = isHover ? '#7CFC9A' : 'rgba(110, 200, 255, 0.5)';
    c.lineWidth = isHover ? 2 : 1;
    c.stroke();
  }
  c.textAlign = 'center';
  for (const s of SECTORS) {
    if (s.layer !== layer) continue;
    const lat = s.polygon.reduce((a, p) => a + p[0], 0) / s.polygon.length;
    const lon = s.polygon.reduce((a, p) => a + p[1], 0) / s.polygon.length;
    const [x, y] = toPx([lat, lon]);
    const hover = s.id === hoveredSector;
    c.font = '11px monospace';
    c.fillStyle = hover ? '#7CFC9A' : 'rgba(215, 230, 234, 0.6)';
    c.fillText(s.name.replace(/ (ALTO|MEDIO|BASSO)$/, ''), x, y);
    c.font = '11px monospace';
    c.fillStyle = hover ? '#7CFC9A' : 'rgba(110, 200, 255, 0.7)';
    c.fillText(fmtBand(s.floorFL, s.ceilingFL), x, y + 13);
  }
  c.textAlign = 'left';
}

// --- impostazioni della sessione ---------------------------------------------
// Scelto il settore si regolano traffico (difficoltà), meteo ed emergenze. Le scelte restano per le sessioni
// successive in questo browser; la difficoltà di partenza è quella tipica del settore finché non se ne sceglie una.

const SETUP_KEY = 'atc-session-setup';
let setupSector = null;
const setup = loadSetup();

function loadSetup() {
  const base = { difficulty: null, weather: { ...WEATHER_DEFAULT }, emergencyPct: EMERGENCY_PCT_DEFAULT };
  try {
    const saved = JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null');
    if (saved) {
      return {
        difficulty: DIFFICULTY[saved.difficulty] ? saved.difficulty : null,
        weather: { ...base.weather, ...saved.weather },
        emergencyPct: Number.isFinite(saved.emergencyPct) ? saved.emergencyPct : base.emergencyPct,
      };
    }
  } catch { /* nessuna preferenza salvata */ }
  return base;
}

function saveSetup() {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
  } catch { /* archivio non disponibile: le scelte valgono per questa sessione */ }
}

function sessionSettings(sector = SECTORS.find((x) => x.id === currentSectorId)) {
  return {
    difficulty: setup.difficulty ?? sector?.difficulty,
    weather: { ...setup.weather },
    emergencyPct: setup.emergencyPct,
  };
}

function openSetup(sectorId) {
  setupSector = SECTORS.find((x) => x.id === sectorId);
  hoveredSector = sectorId;
  const size = sectorSummary(setupSector);
  $('setup-name').textContent = setupSector.name;
  $('setup-meta').textContent = `${fmtBand(setupSector.floorFL, setupSector.ceilingFL)} · `
    + `${Math.round(size.areaNm2 / 1000)}k NM²${size.airports.length ? ` · ${size.airports.join(' ')}` : ''}`;
  $('setup-desc').textContent = setupSector.description;
  $('sector-browse').classList.add('hidden');
  $('sector-setup').classList.remove('hidden');
  renderSetup();
  drawStartMap();
}

function closeSetup() {
  setupSector = null;
  hoveredSector = null;
  $('sector-setup').classList.add('hidden');
  $('sector-browse').classList.remove('hidden');
  drawStartMap();
}

const WX_WORDS = [[0, 'assente'], [25, 'debole'], [50, 'moderato'], [75, 'forte'], [100, 'severo']];

function renderSetup() {
  if (!setupSector) return;
  const chosen = setup.difficulty ?? setupSector.difficulty;
  const box = $('setup-difficulty');
  box.innerHTML = '';
  for (const key of DIFFICULTY_ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = key;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(key === chosen));
    b.innerHTML = `${DIFFICULTY[key].label}<span>${sectorDemand(setupSector, key)} voli/h</span>`;
    b.addEventListener('click', () => {
      setup.difficulty = key;
      saveSetup();
      renderSetup();
    });
    box.appendChild(b);
  }
  const d = DIFFICULTY[chosen];
  const demand = sectorDemand(setupSector, chosen);
  const fmtMin = (sec) => String(Math.round(sec / 30) / 2).replace('.', ',');
  $('setup-traffic-note').textContent = `Circa ${String(d.load).replace('.', ',')} voli in contatto insieme, `
    + `${demand} all'ora. I primi ${Math.max(2, Math.round(d.load))} sono già in avvicinamento appena fuori dal settore `
    + `e ti vengono offerti nei primi ${Math.round(d.fillS / 60)} minuti: dopo 5 minuti il settore è a regime; `
    + `${d.conflictsPerHour} conflitti all'ora con ${fmtMin(d.reactionS[0])}-${fmtMin(d.reactionS[1])} minuti per reagire.`;

  const wx = setup.weather;
  document.querySelectorAll('#setup-wx-type button').forEach((b) => {
    b.setAttribute('aria-pressed', String(!!wx[b.dataset.wx]));
  });
  const pct = Math.round(wx.intensity * 100);
  $('setup-wx').value = String(pct);
  const anyWx = wx.storms || wx.turbulence;
  $('setup-wx').disabled = !anyWx;
  const word = WX_WORDS.find(([v]) => pct <= v)[1];
  $('setup-wx-val').textContent = anyWx ? `${pct}%` : '—';
  let wxNote;
  if (!anyWx || pct === 0) {
    wxNote = 'Nessun fenomeno: niente deviazioni, solo le richieste di livello di routine.';
  } else {
    const parts = [];
    if (wx.storms) {
      const every = Math.round((6600 - 3600 * wx.intensity) / 60 / 5) * 5;
      parts.push(`fronti temporaleschi circa ogni ${every} minuti: i piloti chiederanno prue per aggirare le celle`);
    }
    if (wx.turbulence) {
      parts.push(`zone di turbolenza fra i livelli del settore: i piloti chiederanno di salire o scendere`);
    }
    wxNote = `Meteo ${word}. ${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.`;
  }
  $('setup-wx-note').textContent = wxNote;

  const e = setup.emergencyPct;
  $('setup-emg').value = String(e);
  $('setup-emg-val').textContent = `${String(e).replace('.', ',')}%`;
  const perHour = (e / 100) * demand;
  $('setup-emg-note').textContent = e > 0
    ? `Il ${String(e).replace('.', ',')}% dei voli offerti dichiara un'emergenza: circa `
      + `${perHour < 1 ? `una ogni ${Math.round(60 / perHour)} minuti` : `${perHour.toFixed(1).replace('.', ',')} all'ora`}`
      + ' a regime, una alla volta.'
    : 'Nessuna emergenza.';
}

document.querySelectorAll('#setup-wx-type button').forEach((b) => {
  b.addEventListener('click', () => {
    setup.weather[b.dataset.wx] = !setup.weather[b.dataset.wx];
    saveSetup();
    renderSetup();
  });
});
$('setup-wx').addEventListener('input', (ev) => {
  setup.weather.intensity = Number(ev.target.value) / 100;
  saveSetup();
  renderSetup();
});
$('setup-emg').addEventListener('input', (ev) => {
  setup.emergencyPct = Number(ev.target.value);
  saveSetup();
  renderSetup();
});
$('setup-back').addEventListener('click', closeSetup);
$('setup-start').addEventListener('click', () => {
  if (setupSector) startGame(setupSector.id, sessionSettings(setupSector));
});

function showStartScreen() {
  if (tutorial?.active) tutorial.stop();
  if (sim) sim.paused = true;
  if (sim) selectLayer(airspace.sector.layer);
  else drawStartMap();
  $('gameover').classList.add('hidden');
  $('lesson-done').classList.add('hidden');
  $('tutorial-browse').classList.add('hidden');
  $('sector-browse').classList.remove('hidden');
  renderTutorialCta();
  $('start-screen').classList.remove('hidden');
  drawStartMap();
}

// lesson: lezione della modalità guidata (tutorial.js) oppure null per una sessione normale.
function startGame(sectorId, settings = sessionSettings(), lesson = null) {
  currentSectorId = sectorId;
  loadSector(sectorId);
  sim = new Simulation(settings);
  if (lesson && sim.scripted) {
    // il traffico lo fa comparire la lezione: niente voli, niente zone attive, niente richieste
    // dei piloti finché non è quello il punto da insegnare
    for (const a of airspace.areas) {
      a.active = false;
      a.alarm = false;
      sim.areaSchedule.set(a.id, []);
    }
    sim._levelAt = Infinity;
    sim._emergencyAt = Infinity;
    fillBackground(sim, lesson.background ?? 6);
  } else {
    sim.seedInitialTraffic();
  }
  measures = [];
  cpas = [];
  setTool(null);
  lastAreasKey = '';
  lastRadioKey = '';
  $('radio-msgs').innerHTML = '';
  resetView();
  setSectorTagFilter();
  syncRadarMenu();
  labelPanel.setSimulation(sim);

  sim.on('event', (event) => {
    const { type, ac, correct } = event;
    if (type === 'offered') toast(`${ac.callsign} from ${ac.prevUnit ?? 'previous unit'}: click the tag to assume`, 'offered');
    if (type === 'handoff' && correct) toast(`✓ ${ac.callsign} transferred to ${ac.nextUnit}, ${fmtFl(ac.clearedFL)}`, 'ok');
    // un volo in emergenza si passa a voce: il livello e l'uscita non contano come errore e la riga
    // resta fra i messaggi dei piloti, senza una notifica in più
    if (type === 'handoff' && !correct && !event.emergency) toast(`✗ ${ac.callsign} transferred at ${fmtFl(ac.clearedFL)}, not ${fmtFl(ac.requestedExitFL)} (${sim.strikes.length}/${MAX_STRIKES})`, 'error');
    if (type === 'missed' && !event.emergency) toast(`✗ ${ac.callsign} left the sector without hand-off (${sim.strikes.length}/${MAX_STRIKES})`, 'error');
    if (type === 'stca') toast(`⚠ STCA ${event.a.callsign} – ${event.b.callsign}: separation lost in ${Math.max(0, Math.round(event.t))} s`, 'error');
    if (type === 'offpoint') toast(`✗ ${ac.callsign} left wide of ${ac.exitFix} (${sim.strikes.length}/${MAX_STRIKES})`, 'error');
    if (type === 'xfl-revised') toast(`${ac.callsign} XFL revised ${fmtFl(ac.requestedExitFL)}, coordinated with ${ac.nextUnit}`, 'ok');
    if (type === 'xfl-level') toast(`⚠ ${ac.callsign} level at ${fmtFl(ac.requestedExitFL)}: transfer to ${ac.nextUnit}`, 'warn');
    if (type === 'deviation') toast(`⚠ ${ac.callsign} deviating on own for weather, heading ${String(Math.round(event.request.heading)).padStart(3, '0')}`, 'warn');
    // le parole del pilota stanno nel riquadro dei messaggi: la notifica dice solo come cambia il coordinamento
    if (type === 'emergency') {
      const e = event.emergency;
      toast(`${ac.callsign}${e.divert ? ` diverting ${e.divert}` : ''}: exit ${fmtFl(ac.requestedExitFL)} `
        + `to ${ac.nextUnit}`, e.urgency === 'MAYDAY' ? 'error' : 'warn');
    }
    const { area } = event;
    if (type === 'area-on') toast(`${area.name} active ${areaBand(area)}${event.until ? ` until ${fmtClock(event.until)}` : ''}`, 'warn');
    if (type === 'area-off') toast(`${area.name} no longer active`, 'info');
    if (type === 'apw') {
      const when = event.t > 0 ? `, inside in ${Math.round(event.t)} s` : ', too close';
      toast(`⚠ ${ac.callsign} ${fmtFl(ac.flightLevel)} towards active ${area.name} ${areaBand(area)}${when}`, 'error');
    }
    if (type === 'area-infringement') {
      toast(event.strike
        ? `✗ ${ac.callsign} entered active ${area.name} (${sim.strikes.length}/${MAX_STRIKES})`
        : `${ac.callsign} entered active ${area.name} just after take-over: no strike`, event.strike ? 'error' : 'warn');
    }
    if (tutorial?.active) tutorial.onSimEvent(event);
  });
  sim.on('gameover', (over) => {
    if (tutorial?.active) tutorial.onGameOver(over);
    else showGameOver(over);
  });

  const s = airspace.sector;
  $('hud-sector').textContent = s.name;
  $('hud-sector-sub').textContent = lesson
    ? `${fmtBand(s.floorFL, s.ceilingFL)} · tutorial · ${lesson.title.toLowerCase()}`
    : `${fmtBand(s.floorFL, s.ceilingFL)} · ${airspace.layer.short} · traffico ${sim.difficulty.label.toLowerCase()} · ${sim.demand} mov/h`;
  document.querySelectorAll('#speed-buttons button').forEach((b) => b.classList.toggle('active', b.dataset.mult === '1'));
  $('pause-btn').textContent = 'Pausa';
  $('toasts').innerHTML = '';
  $('start-screen').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('lesson-done').classList.add('hidden');
}

function showGameOver(over) {
  const details = $('go-details');
  details.innerHTML = '';
  const add = (text) => {
    const li = document.createElement('li');
    li.textContent = text;
    details.appendChild(li);
  };
  if (over.reason === 'separation') {
    const { a, b } = over.detail;
    $('go-reason').textContent = 'Perdita di separazione';
    add(`${a.callsign} ${fmtFl(a.flightLevel)} e ${b.callsign} ${fmtFl(b.flightLevel)}`);
    add(`Distanza ${distance(a, b).toFixed(1)} NM, differenza di quota ${Math.round(Math.abs(a.altitude - b.altitude))} ft (minimi 5 NM / 1000 ft)`);
  } else {
    $('go-reason').textContent = `${MAX_STRIKES} errori di coordinamento`;
    for (const strike of over.detail.strikes) add(`${strike.callsign}: ${strike.reason}`);
  }
  $('go-time').textContent = fmtTime(over.time);
  $('go-assumed').textContent = String(over.stats.assumed);
  $('go-handoffs').textContent = String(over.stats.handedOff);
  $('gameover').classList.remove('hidden');
}

$('go-retry').addEventListener('click', () => startGame(currentSectorId));
$('go-change').addEventListener('click', showStartScreen);
$('change-sector').addEventListener('click', showStartScreen);

// --- modalità guidata ------------------------------------------------------
// Il tutorial (tutorial.js) gira sulla simulazione vera: qui ci sono solo il ponte verso lo stato
// dell'interfaccia, l'elenco delle lezioni nella schermata iniziale e la scheda di fine lezione.

const tutorialApi = {
  sim: () => sim,
  selected: () => labelPanel.aircraft,
  hovered: () => hoveredAc,
  tool: () => tool,
  cpas: () => cpas,
  measures: () => measures,
  toast,
  // Porta in vista il volo di cui si sta parlando, senza cambiare l'ingrandimento: se è già ben visibile
  // (e non sotto il riquadro dell'istruttore) la vista non si muove, altrimenti si va a metà strada fra il
  // volo e il centro del settore, così restano in vista tutti e due.
  centreOn(ac) {
    if (!ac) return;
    const t = makeTransform(canvas);
    const { px, py } = t.toPx(ac.x, ac.y);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const coach = $('coach').getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    const underCoach = !$('coach').classList.contains('hidden')
      && px < coach.right - paneBox.left + 20 && py < coach.bottom - paneBox.top + 20;
    const visible = px > w * 0.12 && px < w * 0.88 && py > h * 0.12 && py < h * 0.88;
    if (visible && !underCoach) return;
    const v = airspace.view;
    radarView.panX = (ac.x - (v.xMin + v.xMax) / 2) / 2;
    radarView.panY = (ac.y - (v.yMin + v.yMax) / 2) / 2;
    syncRadarMenu();
  },
  setSpeed(mult) {
    if (!sim) return;
    sim.timeMultiplier = mult;
    document.querySelectorAll('#speed-buttons button')
      .forEach((b) => b.classList.toggle('active', parseFloat(b.dataset.mult) === mult));
  },
  syncPause() {
    if (sim) $('pause-btn').textContent = sim.paused ? 'Riprendi' : 'Pausa';
  },
  exitToList: () => openTutorialList(),
  startLesson: (i) => startTutorialLesson(i),
};

function tutorialProgress() {
  return tutorial ? tutorial.progress : loadProgress();
}

function renderTutorialCta() {
  const p = tutorialProgress();
  const n = p.done.length;
  $('tutorial-cta-fill').style.width = `${Math.round((n / LESSONS.length) * 100)}%`;
  $('tutorial-cta-sub').textContent = n === 0
    ? 'Dieci lezioni: dal primo volo al turno completo'
    : n >= LESSONS.length ? 'Completato · ripassa quando vuoi' : `${n} lezioni su ${LESSONS.length}`;
  const resume = resumePoint(p);
  if (resume) $('tutorial-cta-sub').textContent = `Lezione ${resume.index + 1}, passo ${resume.step + 1} di ${resume.of}`;
  $('tutorial-cta-go').textContent = resume ? 'Riprendi ▸' : n === 0 ? 'Inizia ▸' : n >= LESSONS.length ? 'Rivedi ▸' : 'Continua ▸';
  $('tutorial-cta').classList.toggle('fresh', n === 0);
}

function renderLessonList() {
  const p = tutorialProgress();
  const list = $('lesson-list');
  const resume = resumePoint(p);
  list.innerHTML = '';
  LESSONS.forEach((l, i) => {
    const done = p.done.includes(l.id);
    const stars = p.stars[l.id] ?? 0;
    const row = document.createElement('button');
    row.className = `lesson-row${done ? ' done' : ''}`;
    row.innerHTML = `
      <span class="lesson-num">${done ? '✓' : i + 1}</span>
      <span class="lesson-main"><strong></strong><span class="muted"></span></span>
      <span class="lesson-stars">${[1, 2, 3].map((k) => `<i class="${k <= stars ? 'on' : ''}">★</i>`).join('')}</span>`;
    row.querySelector('strong').textContent = l.title;
    row.querySelector('.muted').textContent = resume?.index === i
      ? `In corso: passo ${resume.step + 1} di ${resume.of} · ${l.subtitle}`
      : l.subtitle;
    row.addEventListener('click', () => startTutorialLesson(i));
    list.appendChild(row);
  });
  $('tutorial-progress').textContent = `${p.done.length} di ${LESSONS.length} completate · settore NW ALTO di Roma ACC`;
  // il pulsante grande riprende la lezione lasciata a metà, o porta alla prima non ancora fatta
  const next = LESSONS.findIndex((l) => !p.done.includes(l.id));
  const i = resume ? resume.index : next < 0 ? 0 : next;
  $('tutorial-start').textContent = resume
    ? `Riprendi: ${i + 1}. ${LESSONS[i].title} · passo ${resume.step + 1}`
    : `${next < 0 ? 'Rivedi' : p.done.length ? 'Continua' : 'Inizia'}: ${i + 1}. ${LESSONS[i].title}`;
  $('tutorial-start').onclick = () => startTutorialLesson(i);
}

function openTutorialList() {
  if (tutorial?.active) tutorial.stop();
  if (sim) sim.paused = true;
  $('gameover').classList.add('hidden');
  $('lesson-done').classList.add('hidden');
  $('sector-setup').classList.add('hidden');
  $('sector-browse').classList.add('hidden');
  $('tutorial-browse').classList.remove('hidden');
  $('start-screen').classList.remove('hidden');
  renderLessonList();
  drawStartMap();
}

const TUTORIAL_SECTOR = 'NWA';   // NW ALTO di Roma ACC: passaggi lunghi e uscite di ogni tipo

function startTutorialLesson(index, { resume = true } = {}) {
  const lesson = LESSONS[index];
  if (!lesson) return;
  selectCentre('roma');
  tutorial ??= new Tutorial(tutorialApi);
  startGame(TUTORIAL_SECTOR, {
    scripted: lesson.scripted !== false,
    difficulty: lesson.difficulty ?? 'facile',
    weather: { storms: false, turbulence: false, intensity: 0 },
    emergencyPct: 0,
  }, lesson);
  tutorial.start(index, { resume });
}

$('tutorial-cta').addEventListener('click', openTutorialList);
$('tutorial-back').addEventListener('click', () => {
  $('tutorial-browse').classList.add('hidden');
  $('sector-browse').classList.remove('hidden');
  renderTutorialCta();
  drawStartMap();
});
$('tutorial-reset').addEventListener('click', () => {
  tutorial ??= new Tutorial(tutorialApi);
  tutorial.progress.done = [];
  tutorial.progress.stars = {};
  tutorial.progress.current = null;
  try {
    localStorage.setItem('atc-tutorial-progress', JSON.stringify(tutorial.progress));
  } catch { /* archivio non disponibile */ }
  renderLessonList();
  renderTutorialCta();
});

$('ld-next').addEventListener('click', () => {
  const next = (tutorial?.lessonIndex ?? -1) + 1;
  if (next < LESSONS.length) startTutorialLesson(next);
  else showStartScreen();
});
$('ld-again').addEventListener('click', () => startTutorialLesson(tutorial?.lessonIndex ?? 0, { resume: false }));
$('ld-list').addEventListener('click', () => openTutorialList());

renderTutorialCta();

// --- interazione con il radar ---------------------------------------------

function cssPoint(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

const SYMBOL_HIT_PX = 12;

// Aereo la cui traccia (simbolo di posizione) è vicina al punto, senza considerare le etichette. Le tracce di
// competenza (verdi e magenta) hanno la precedenza: una gialla vicina viene scelta solo se nessuna di quelle è
// a portata di clic.
const ours = (ac) => ac.control === 'assumed' || ac.control === 'offered';

function findTrackAt(t, x, y) {
  let closest = null;
  let closestDist = SYMBOL_HIT_PX;
  for (const ac of sim.aircraft) {
    if (closest && ours(closest) && !ours(ac)) continue;
    const p = t.toPx(ac.x, ac.y);
    const d = Math.hypot(p.px - x, p.py - y);
    if (d >= SYMBOL_HIT_PX) continue;
    if (d < closestDist || (ours(ac) && closest && !ours(closest))) {
      closestDist = d;
      closest = ac;
    }
  }
  return closest;
}

// Label sotto il punto, come è stata disegnata (anche allargata dal passaggio del mouse o dagli allarmi).
function findTagAt(t, x, y) {
  return labelAt(x, y);
}

function findAircraftAt(t, x, y) {
  return findTagAt(t, x, y) ?? findTrackAt(t, x, y);
}

function findWaypointAt(t, x, y) {
  let closest = null;
  let closestDist = 12;
  for (const wp of airspace.waypoints) {
    if (!waypointShown(wp)) continue;
    const p = t.toPx(wp.x, wp.y);
    const d = Math.hypot(p.px - x, p.py - y);
    if (d < closestDist) {
      closestDist = d;
      closest = wp;
    }
  }
  return closest;
}

// Pressione su un'etichetta: trascinandola si sposta, un clic la apre (e fa l'hand-on del traffico magenta).
// Pressione su una traccia: un clic ruota il tag di 45° in senso orario (se il tag è nascosto dal filtro dei
// livelli apre l'etichetta).
// Strumenti in basso a sinistra:
//   R&B     range and bearing: clic sul punto d'inizio e poi su quello di fine, ciascuno un aereo (la linea lo
//           segue) o un punto della mappa. Sulla linea: distanza e rilevamento nei due versi. Lo strumento resta
//           attivo per altre linee finché non si ripreme il pulsante o si preme Esc. Un clic sull'etichetta di una
//           linea la toglie.
//   Dist. min  clic su un aereo e poi su un altro: quanto si passeranno vicini con prua, velocità e livello
//           autorizzato attuali (distanza minima, fra quanto, differenza di quota). Resta e si aggiorna; un clic
//           sull'etichetta la toglie.
//   Vettore lunghezza del vettore velocità, in minuti.
//   Mappa   menu dei filtri: punti FRA e zone non attive.
const DOUBLE_CLICK_MS = 450;
let lastNameClick = { ac: null, t: 0 }; // ultimo clic su un nominativo, per riconoscere il doppio clic
// { mode: 'tag' | 'track', ac, onTrack, grabDx, grabDy, startX, startY, x, y, moved }
let dragState = null;
let measures = [];    // linee R&B fissate: { a, b }, ciascun estremo un aereo oppure un punto della mappa {x, y}
let tool = null;      // strumento attivo: null | 'rb' | 'cpa'
let rbStart = null;   // punto d'inizio della linea R&B in corso
let cpas = [];        // coppie per la distanza minima: { a, b }
let cpaFirst = null;  // primo aereo scelto per una nuova coppia
let cursor = null;    // posizione del cursore sul radar (px CSS), per l'anteprima della linea

function setTool(next) {
  tool = next;
  rbStart = null;
  cpaFirst = null;
  for (const [id, name] of [['tool-rb', 'rb'], ['tool-cpa', 'cpa']]) {
    $(id).classList.toggle('active', tool === name);
    $(id).setAttribute('aria-pressed', String(tool === name));
  }
  canvas.classList.toggle('tool-active', tool !== null);
}
$('tool-rb').addEventListener('click', () => setTool(tool === 'rb' ? null : 'rb'));
$('tool-cpa').addEventListener('click', () => setTool(tool === 'cpa' ? null : 'cpa'));
const isAircraft = (o) => o && o.callsign !== undefined;

canvas.addEventListener('mousedown', (ev) => {
  // su Mac ctrl+clic è il clic destro: lo gestisce il menu contestuale (vettore)
  if (!sim || ev.button !== 0 || ev.ctrlKey) return;
  const { x, y } = cssPoint(ev);
  const t = makeTransform(canvas);
  const menuWasOpen = tagMenu !== null;
  closeTagMenu();

  const measure = measureAt(x, y);
  if (measure >= 0) {
    measures.splice(measure, 1);
    dragState = null;
    return;
  }
  const cpa = cpaAt(x, y);
  if (cpa >= 0) {
    cpas.splice(cpa, 1);
    dragState = null;
    return;
  }
  // distanza minima: due clic su due aerei; un clic sulla mappa vuota annulla la scelta del primo
  if (tool === 'cpa') {
    dragState = null;
    const ac = findAircraftAt(t, x, y);
    if (!ac) cpaFirst = null;
    else if (!cpaFirst) cpaFirst = ac;
    else if (ac !== cpaFirst) {
      if (!cpas.some((c) => (c.a === cpaFirst && c.b === ac) || (c.a === ac && c.b === cpaFirst))) cpas.push({ a: cpaFirst, b: ac });
      cpaFirst = null;
    }
    return;
  }
  // R&B: ogni clic è un estremo della linea, su un aereo (traccia o tag) o sulla mappa
  if (tool === 'rb') {
    dragState = null;
    const point = findAircraftAt(t, x, y) ?? t.fromPx(x, y);
    if (!rbStart) {
      rbStart = point;
    } else if (point !== rbStart) {
      const dup = isAircraft(point) && measures.some((m) => (m.a === rbStart && m.b === point) || (m.a === point && m.b === rbStart));
      if (!dup) measures.push({ a: rbStart, b: point });
      rbStart = null;
    }
    return;
  }

  // la traccia ha la precedenza: un tag ruotato o trascinato può passarle sopra
  // livello o velocità scritti sul tag: si apre il menu per autorizzare un altro valore
  const field = tagFieldAt(x, y);
  if (field && !menuWasOpen) {
    dragState = null;
    openTagMenu(field, x, y);
    return;
  }

  // la label ha la precedenza sulle tracce degli altri aerei che copre (anche quelle gialle); solo sulla traccia
  // del suo stesso volo vale la traccia (un clic la ruota)
  const label = findTagAt(t, x, y);
  const near = findTrackAt(t, x, y);
  const track = near && (!label || label === near) ? near : null;
  const tag = track ? null : label;
  const target = track ?? tag;
  if (!target) {
    dragState = null;
    emptyClick(t, x, y);
    return;
  }

  const p = t.toPx(target.x, target.y);
  dragState = {
    mode: tag ? 'tag' : 'track',
    onTrack: !!track,
    ac: target,
    grabDx: x - (p.px + target.tagOffset.x),
    grabDy: y - (p.py + target.tagOffset.y),
    startX: x,
    startY: y,
    x,
    y,
    moved: false,
  };
});

// Clic sulla mappa vuota: con l'etichetta aperta un punto FRA si sceglie per la rotta, altrimenti si deseleziona.
function emptyClick(t, x, y) {
  const wp = labelPanel.aircraft && findWaypointAt(t, x, y);
  if (!wp || !labelPanel.pickWaypoint(wp.id)) labelPanel.deselect();
}

function endDrag(ev) {
  // lo stato del trascinamento si azzera prima di tutto: niente resta mai agganciato al cursore
  const state = dragState;
  dragState = null;
  if (!state || !sim) return;
  const t = makeTransform(canvas);
  if (state.moved) return;
  if (state.onTrack && tagVisible(state.ac)) {
    rotateTag(state.ac);
    return;
  }
  try {
    // clic su un traffico magenta: hand-on
    if (state.ac.control === 'offered' && !sim.gameOver) sim.handOn(state.ac);
    // il clic seleziona soltanto (traccia cerchiata e rotta celeste); due clic di fila sul nominativo
    // accendono o spengono il vettore velocità (lo spadino)
    const clickAt = performance.now();
    const onName = tagNameAt(state.x, state.y) === state.ac;
    const double = onName && lastNameClick.ac === state.ac && clickAt - lastNameClick.t < DOUBLE_CLICK_MS;
    lastNameClick = onName && !double ? { ac: state.ac, t: clickAt } : { ac: null, t: 0 };
    labelPanel.select(state.ac, false);
    if (double) state.ac.showVector = !state.ac.showVector;
  } catch (err) {
    console.error('Errore nell\'apertura dell\'etichetta', err);
  }
}

window.addEventListener('mousemove', (ev) => {
  if (!dragState) return;
  // pulsante già rilasciato (ad esempio fuori dalla finestra): il trascinamento termina
  if ((ev.buttons & 1) === 0) {
    endDrag(ev);
    return;
  }
  const { x, y } = cssPoint(ev);
  dragState.x = x;
  dragState.y = y;

  if (!dragState.moved && Math.hypot(x - dragState.startX, y - dragState.startY) > 4) {
    dragState.moved = true;
  }
  if (!dragState.moved || dragState.mode !== 'tag') return;

  // trascinato a mano: la distanza dalla traccia resta libera finché non si clicca di nuovo la traccia
  freeTag(dragState.ac);
  const t = makeTransform(canvas);
  const p = t.toPx(dragState.ac.x, dragState.ac.y);
  dragState.ac.tagOffset.x = x - dragState.grabDx - p.px;
  dragState.ac.tagOffset.y = y - dragState.grabDy - p.py;
});

window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', () => { dragState = null; });

// Nota con i comandi: nascosta, si richiama con il pulsante ? o con H e si chiude con Esc.
// --- informazioni, fonti dei dati e sostegno al progetto ---------------------

const aboutOpen = () => !$('about').classList.contains('hidden');

function showAbout(show) {
  $('about').classList.toggle('hidden', !show);
}

function buildAbout() {
  const v = appVersion();
  $('brand-version').textContent = v ? `v${v}` : '';
  $('about-version').textContent = v ? `v${v}` : '';
  $('about-tagline').textContent = TAGLINE;
  $('about-what').innerHTML = ABOUT;
  $('about-disclaimer').innerHTML = DISCLAIMER;
  $('about-contact').textContent = CONTACT ? `${APP_NAME} · ${CONTACT}` : APP_NAME;

  const list = $('about-sources');
  list.innerHTML = '';
  for (const src of SOURCES) {
    const li = document.createElement('li');
    const what = document.createElement('b');
    what.textContent = src.what;
    const who = document.createElement('span');
    who.textContent = ` — ${src.who}`;
    li.append(what, who);
    if (src.url) {
      const a = document.createElement('button');
      a.className = 'link';
      a.textContent = 'apri';
      a.addEventListener('click', () => openExternal(src.url));
      li.append(' ', a);
    }
    list.appendChild(li);
  }

  // i pulsanti del sostegno compaiono solo quando l'indirizzo è configurato (vedi support.js):
  // schermata iniziale, scheda delle informazioni, colonna di destra in sessione e schede di fine partita
  $('about-support').classList.toggle('hidden', !donateUrl);
  for (const el of document.querySelectorAll('#donate-btn, #support-btn, [data-donate]')) {
    el.classList.toggle('hidden', !donateUrl);
  }
}

$('about-btn').addEventListener('click', () => showAbout(true));
$('about-close').addEventListener('click', () => showAbout(false));
$('about').addEventListener('click', (ev) => {
  if (ev.target === $('about')) showAbout(false);
});
for (const el of document.querySelectorAll('#about-donate, #donate-btn, #support-btn, [data-donate]')) {
  el.addEventListener('click', () => openExternal(donateUrl));
}
$('about-project').addEventListener('click', () => openExternal(`${PROJECT_URL}/releases/latest`));
$('about-issues').addEventListener('click', () => openExternal(ISSUES_URL));
buildAbout();

const helpOpen = () => !$('help').classList.contains('hidden');
const showHelp = (show) => $('help').classList.toggle('hidden', !show);
$('help-btn').addEventListener('click', () => showHelp(!helpOpen()));
$('help-close').addEventListener('click', () => showHelp(false));
$('help').addEventListener('click', (ev) => {
  if (ev.target === $('help')) showHelp(false);
});

window.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((ev.key === 'h' || ev.key === 'H' || ev.key === '?') && !typing) {
    showHelp(!helpOpen());
    return;
  }
  // barra spaziatrice: hand-off del volo selezionato
  if (ev.key === ' ' && !typing && sim && !sim.gameOver) {
    ev.preventDefault();
    if (!labelPanel.handOffSelected()) toast('Select a flight under your control first', 'warn');
    return;
  }
  if ((ev.key === 'r' || ev.key === 'R') && !typing && sim) {
    setTool(tool === 'rb' ? null : 'rb');
    return;
  }
  if ((ev.key === 'c' || ev.key === 'C') && !typing && sim) {
    setTool(tool === 'cpa' ? null : 'cpa');
    return;
  }
  if (ev.key !== 'Escape') return;
  if (aboutOpen()) showAbout(false);
  else if (helpOpen()) showHelp(false);
  else if (tagMenu) closeTagMenu();
  else if (popupOpen()) showPopup(null);
  else if (tool) setTool(null);
  else labelPanel.deselect();
});

// --- menu a tendina sui valori del tag -------------------------------------
// Un clic sul livello o sulla velocità scritti nel tag di un volo in contatto apre l'elenco dei valori
// (di 10 in 10): scegliendone uno l'istruzione è impartita subito, come dall'etichetta.
const range = (from, to, step) => {
  const out = [];
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) out.push(v);
  return out;
};
const pad3 = (v) => String(v).padStart(3, '0');

// Prossimo punto: prima quelli della rotta (fino al punto d'uscita, oltre è di altri enti), poi gli altri punti
// FRA sulla mappa, dal più vicino.
function fixItems(ac) {
  const onRoute = ac.route.slice(0, ac.exitIndex + 1).filter((id) => isFraPoint(id));
  const others = airspace.waypoints
    .filter((w) => isFraPoint(w.id) && !onRoute.includes(w.id) && inView(w, 40))
    .sort((a, b) => distance(ac, a) - distance(ac, b))
    .map((w) => w.id);
  return [{ group: 'Rotta' }, ...onRoute, { group: 'Altri punti' }, ...others];
}

// Campi della label che si cliccano: titolo, valori (numeri, oppure {group} per un'intestazione), valore
// attuale e come scriverlo.
const TAG_MENUS = {
  fl: { title: 'ALV', items: () => range(450, 50, -10), current: (ac) => ac.clearedFL, format: pad3 },
  speed: {
    title: 'SPD',
    items: () => range(560, 160, -10),
    current: (ac) => Math.round(ac.speedMode === 'assigned' ? ac.assignedSpeed : ac.speed),
    format: String,
  },
  heading: {
    title: 'HDG',
    items: () => range(5, 360, 5),
    current: (ac) => Math.round(ac.mode === 'heading' ? ac.assignedHeading : ac.heading) % 360 || 360,
    format: pad3,
  },
  // da FL250 in su la velocità si assegna in Mach, come si legge nella label (78 = Mach .78)
  mach: {
    title: 'MACH',
    items: () => range(90, 60, -1),
    current: (ac) => Math.round(((ac.speedMode === 'assigned' ? ac.assignedSpeed : ac.speed) / soundSpeedKt(ac.altitude)) * 100),
    format: (v) => (v >= 100 ? (v / 100).toFixed(2) : `.${String(v).padStart(2, '0')}`),
  },
  rate: {
    title: 'VR',
    items: () => range(5, 40, 1),
    current: (ac) => Math.round(Math.abs(ac.verticalFpm ?? 0) / 100),
    format: (v) => String(v).padStart(2, '0'),
  },
  fix: {
    title: 'EFX',
    items: fixItems,
    current: (ac) => (ac.mode === 'route' ? ac.route[0] ?? null : null),
    format: (v) => v ?? '---',
  },
};

let tagMenu = null;

function closeTagMenu() {
  if (!tagMenu) return;
  tagMenu.el.remove();
  tagMenu = null;
}

function openTagMenu(field, x, y) {
  const { ac } = field;
  const kind = field.kind === 'speed' && ac.altitude >= MACH_FROM_FT ? 'mach' : field.kind;
  if (ac.control !== 'assumed' || sim.gameOver) return;
  const spec = TAG_MENUS[kind];
  const current = spec.current(ac);
  const items = spec.items(ac);
  // valore evidenziato: quello uguale all'attuale, per i numeri il più vicino
  const values = items.filter((v) => typeof v !== 'object');
  const nearest = typeof current === 'number'
    ? values.reduce((best, v) => (Math.abs(v - current) < Math.abs(best - current) ? v : best), values[0])
    : current;

  const el = document.createElement('div');
  el.className = 'tag-menu';
  // come sul sistema reale: nominativo, campo e valore attuale, poi l'elenco da scorrere
  const head = document.createElement('div');
  head.className = 'tag-menu-head';
  head.textContent = ac.callsign;
  const title = document.createElement('div');
  title.className = 'tag-menu-field';
  title.textContent = spec.title;
  const now = document.createElement('div');
  now.className = 'tag-menu-value';
  now.textContent = spec.format(current);
  const list = document.createElement('div');
  list.className = 'tag-menu-list';
  let currentBtn = null;
  for (const v of items) {
    if (typeof v === 'object') {
      const g = document.createElement('div');
      g.className = 'tag-menu-group';
      g.textContent = v.group;
      list.appendChild(g);
      continue;
    }
    const btn = document.createElement('button');
    btn.textContent = spec.format(v);
    if (v === nearest) {
      btn.classList.add('current');
      currentBtn = btn;
    }
    btn.addEventListener('click', () => {
      const applied = labelPanel.commandFromTag(ac, kind, v);
      if (kind === 'speed' && applied !== null && applied !== v) {
        toast(`${ac.callsign} unable ${v} kt at ${fmtFl(ac.flightLevel)}: speed ${applied} kt`, 'warn');
      }
      if (kind === 'mach' && applied !== null && applied !== v) {
        toast(`${ac.callsign} unable Mach .${v} at ${fmtFl(ac.flightLevel)}: Mach .${applied}`, 'warn');
      }
      if (kind === 'rate' && applied !== null && applied !== v) {
        toast(`${ac.callsign} unable ${v * 100} ft/min: best rate ${applied * 100} ft/min`, 'warn');
      }
      closeTagMenu();
    });
    list.appendChild(btn);
  }
  el.append(head, title, now, list);
  pane.appendChild(el);

  // accanto alla label, a sinistra (a destra se non c'è spazio), senza coprirla
  const w = el.offsetWidth;
  const box = labelBlock(ac) ?? { x0: x, x1: x, y0: y };
  const left = box.x0 - w - 8 >= 4 ? box.x0 - w - 8 : box.x1 + 8;
  el.style.left = `${Math.max(4, Math.min(pane.clientWidth - w - 4, left))}px`;
  el.style.top = `${Math.max(4, Math.min(pane.clientHeight - el.offsetHeight - 4, box.y0 - 30))}px`;
  if (currentBtn) list.scrollTop = currentBtn.offsetTop - list.clientHeight / 2 + currentBtn.offsetHeight / 2;
  tagMenu = { el, ac, kind };
}

// Il cursore cambia sopra i valori cliccabili della label; l'aereo sotto il mouse (traccia o label) ha la
// label evidenziata in grigio e completa.
canvas.addEventListener('mouseleave', () => {
  cursor = null;
  hoveredAc = null;
  setHovered(null);
});
canvas.addEventListener('mousemove', (ev) => {
  cursor = cssPoint(ev);
  if (!sim || dragState) return;
  const { x, y } = cursor;
  canvas.style.cursor = tagFieldAt(x, y) ? 'pointer' : '';
  // anche qui la label ha la precedenza sulle tracce degli altri aerei che copre
  hoveredAc = labelAt(x, y) ?? findTrackAt(makeTransform(canvas), x, y);
  setHovered(hoveredAc);
});

document.querySelectorAll('#speed-buttons button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!sim) return;
    sim.timeMultiplier = parseFloat(btn.dataset.mult);
    document.querySelectorAll('#speed-buttons button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// --- menu Radar: vettore velocità, zoom e spostamento della mappa --------------

// Il cursore dello zoom è logaritmico: gli stessi passi raddoppiano o dimezzano l'ingrandimento.
const zoomToSlider = (z) => (100 * Math.log(z / ZOOM_RANGE[0])) / Math.log(ZOOM_RANGE[1] / ZOOM_RANGE[0]);
const sliderToZoom = (v) => ZOOM_RANGE[0] * (ZOOM_RANGE[1] / ZOOM_RANGE[0]) ** (v / 100);

function syncRadarMenu() {
  const zoomPct = `${Math.round(radarView.zoom * 100)}%`;
  $('zoom-range').value = String(Math.round(zoomToSlider(radarView.zoom)));
  $('zoom-value').textContent = zoomPct;
  $('vector-value').textContent = `${radarView.vectorMin} min`;
  $('vector-range').value = String(radarView.vectorMin);
  const { tagMinFL: lo, tagMaxFL: hi } = radarView;
  $('tagfl-min').value = String(lo);
  $('tagfl-max').value = String(hi);
  // il cursore minimo sta sopra quando i due sono in fondo a destra, altrimenti non si potrebbe più spostare
  $('tagfl-min').style.zIndex = lo > TAG_FL_RANGE[1] - 50 ? '3' : '';
  const span = TAG_FL_RANGE[1] - TAG_FL_RANGE[0];
  $('tagfl-fill').style.left = `${((lo - TAG_FL_RANGE[0]) / span) * 100}%`;
  $('tagfl-fill').style.right = `${((TAG_FL_RANGE[1] - hi) / span) * 100}%`;
  const filtered = lo > TAG_FL_RANGE[0] || hi < TAG_FL_RANGE[1];
  const range = filtered ? `${fmtFl(lo)}–${hi >= TAG_FL_RANGE[1] ? 'max' : fmtFl(hi)}` : 'tutti';
  $('tagfl-value').textContent = range;
  $('tagfl-short').textContent = filtered ? `${fmtFl(lo)}–${hi >= TAG_FL_RANGE[1] ? 'max' : fmtFl(hi)}` : 'tutti';
  $('tag-btn').classList.toggle('filtered', filtered);
}

// Filtro dei livelli delle etichette: due cursori sulla stessa barra, sempre almeno 10 FL fra i due.
function setTagFilter(lo, hi) {
  radarView.tagMinFL = Math.max(TAG_FL_RANGE[0], Math.min(lo, TAG_FL_RANGE[1] - 10));
  radarView.tagMaxFL = Math.min(TAG_FL_RANGE[1], Math.max(hi, radarView.tagMinFL + 10));
  syncRadarMenu();
}
$('tagfl-min').addEventListener('input', (ev) => {
  setTagFilter(Math.min(Number(ev.target.value), radarView.tagMaxFL - 10), radarView.tagMaxFL);
});
$('tagfl-max').addEventListener('input', (ev) => {
  const hi = Math.max(Number(ev.target.value), radarView.tagMinFL + 10);
  radarView.tagMaxFL = Math.min(TAG_FL_RANGE[1], hi);
  syncRadarMenu();
});
// Filtro di partenza: i livelli del settore con 500 ft di margine sopra e sotto, così si vede anche il
// traffico appena fuori dai limiti verticali (FL195-FL305 diventa FL190-FL310).
const SECTOR_FILTER_MARGIN_FL = 5;

function setSectorTagFilter() {
  const s = airspace.sector;
  if (!s) return;
  setTagFilter(s.floorFL - SECTOR_FILTER_MARGIN_FL, Math.min(s.ceilingFL + SECTOR_FILTER_MARGIN_FL, TAG_FL_RANGE[1]));
}
$('tagfl-sector').addEventListener('click', setSectorTagFilter);
$('tagfl-all').addEventListener('click', () => setTagFilter(...TAG_FL_RANGE));

// Cursore del vettore velocità, nella barra in basso.
$('vector-range').min = String(VECTOR_RANGE[0]);
$('vector-range').max = String(VECTOR_RANGE[1]);
$('vector-range').addEventListener('input', (ev) => {
  radarView.vectorMin = Number(ev.target.value);
  syncRadarMenu();
});
$('zoom-range').addEventListener('input', (ev) => {
  zoomTo(canvas, sliderToZoom(Number(ev.target.value)));
  syncRadarMenu();
});
$('zoom-in').addEventListener('click', () => {
  zoomTo(canvas, radarView.zoom * 1.25);
  syncRadarMenu();
});
$('zoom-out').addEventListener('click', () => {
  zoomTo(canvas, radarView.zoom / 1.25);
  syncRadarMenu();
});
// Deconflitta i tag una volta sola, allo stato attuale: non resta attivo.
$('tags-deconflict').addEventListener('click', () => {
  if (sim) deconflictTags(canvas, sim.aircraft);
});
$('view-reset').addEventListener('click', () => {
  resetView();
  syncRadarMenu();
});

// Trackpad: strisciando con due dita la mappa si sposta, pizzicando (ctrlKey) si ingrandisce attorno al cursore.
canvas.addEventListener('wheel', (ev) => {
  if (!sim) return;
  ev.preventDefault();
  const unit = ev.deltaMode === 1 ? 16 : 1;
  closeTagMenu();
  if (ev.ctrlKey) {
    const { x, y } = cssPoint(ev);
    zoomTo(canvas, radarView.zoom * Math.exp(-ev.deltaY * unit * 0.01), x, y);
    syncRadarMenu();
  } else {
    panBy(canvas, -ev.deltaX * unit, -ev.deltaY * unit);
  }
}, { passive: false });

// Due dita premute sul trackpad (clic secondario), tasto destro o centrale: trascinando si sposta la mappa.
let panState = null;
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('mousedown', (ev) => {
  if (!sim || ev.button === 0) return;
  ev.preventDefault();
  panState = cssPoint(ev);
});
window.addEventListener('mousemove', (ev) => {
  if (!panState) return;
  if ((ev.buttons & 6) === 0) {
    panState = null;
    return;
  }
  const p = cssPoint(ev);
  panBy(canvas, p.x - panState.x, p.y - panState.y);
  panState = p;
});
window.addEventListener('mouseup', (ev) => {
  if (ev.button !== 0) panState = null;
});

syncRadarMenu();

$('pause-btn').addEventListener('click', () => {
  if (!sim || sim.gameOver) return;
  sim.paused = !sim.paused;
  $('pause-btn').textContent = sim.paused ? 'Riprendi' : 'Pausa';
});

// Punti sulla mappa: tutti, solo quelli di uscita del settore (COP) o solo i triangoli senza nome.
function setMapPoints(mode) {
  radarView.mapPoints = mode;
  document.querySelectorAll('#map-points button').forEach((b) => b.classList.toggle('active', b.dataset.points === mode));
  try {
    localStorage.setItem('mapPoints', mode);
  } catch { /* niente da salvare */ }
}
document.querySelectorAll('#map-points button').forEach((btn) => {
  btn.addEventListener('click', () => setMapPoints(btn.dataset.points));
});
try {
  const saved = localStorage.getItem('mapPoints');
  setMapPoints(['all', 'cop', 'symbols'].includes(saved) ? saved : 'all');
} catch {
  setMapPoints('all');
}

// Menu a tendina della barra in basso (Tag e Mappa): si aprono verso l'alto, uno alla volta, e si chiudono con
// un clic fuori, ripremendo il pulsante o con Esc.
const POPUPS = [['tag-btn', 'tag-menu'], ['map-btn', 'map-menu']];
const popupOpen = () => POPUPS.some(([, menu]) => !$(menu).classList.contains('hidden'));
function showPopup(menuId) {
  for (const [btn, menu] of POPUPS) {
    const open = menu === menuId;
    $(menu).classList.toggle('hidden', !open);
    $(btn).setAttribute('aria-expanded', String(open));
    $(btn).classList.toggle('active', open);
  }
}
for (const [btn, menu] of POPUPS) {
  $(btn).addEventListener('click', () => showPopup($(menu).classList.contains('hidden') ? menu : null));
}
document.addEventListener('mousedown', (ev) => {
  if (popupOpen() && !ev.target.closest('.tool-pop')) showPopup(null);
});

// Zone non attive sulla mappa: visibili o nascoste (quelle in procinto di attivarsi restano).
function setInactiveAreas(show) {
  radarView.inactiveAreas = show;
  $('areas-inactive').setAttribute('aria-pressed', String(show));
  try {
    localStorage.setItem('inactiveAreas', show ? 'on' : 'off');
  } catch { /* niente da salvare */ }
}
$('areas-inactive').addEventListener('click', () => setInactiveAreas(!radarView.inactiveAreas));
try {
  setInactiveAreas(localStorage.getItem('inactiveAreas') !== 'off');
} catch {
  setInactiveAreas(true);
}

// SID e STAR delle piste in uso sulla mappa: ciascuna si accende e si spegne dal menu Mappa.
function setProcedures(kind, show) {
  radarView[kind] = show;
  $(`map-${kind}`).setAttribute('aria-pressed', String(show));
  try {
    localStorage.setItem(`map-${kind}`, show ? 'on' : 'off');
  } catch { /* niente da salvare */ }
}
for (const [kind, def] of [['stars', true], ['sids', false]]) {
  $(`map-${kind}`).addEventListener('click', () => setProcedures(kind, !radarView[kind]));
  try {
    const saved = localStorage.getItem(`map-${kind}`);
    setProcedures(kind, saved ? saved === 'on' : def);
  } catch {
    setProcedures(kind, def);
  }
}

// --- ciclo principale ------------------------------------------------------

function updateHud() {
  $('hud-clock-cell').title = `In servizio da ${fmtTime(sim.simTime)}`;
  $('hud-assumed').textContent = String(sim.aircraft.filter((a) => a.control === 'assumed').length);
  const offered = sim.aircraft.filter((a) => a.control === 'offered').length;
  $('hud-offered').textContent = String(offered);
  $('hud-offered').parentElement.classList.toggle('active', offered > 0);
  $('hud-handoffs').textContent = String(sim.stats.handedOff);
  $('hud-strikes').innerHTML = Array.from({ length: MAX_STRIKES }, (_, i) =>
    `<span class="strike ${i < sim.strikes.length ? 'on' : ''}"></span>`).join('');
  // riepilogo visibile a menu chiuso
  const assumed = sim.aircraft.filter((a) => a.control === 'assumed').length;
  $('hud-clock').textContent = fmtClock(sim.clockS);
  $('sim-menu-info').textContent = `${fmtClock(sim.clockS)} UTC · ${sim.paused ? 'pausa' : `${sim.timeMultiplier}x`}`
    + ` · ${assumed} in contatto${offered ? ` · ${offered} da assumere` : ''}`
    + `${sim.strikes.length ? ` · ${sim.strikes.length} err.` : ''}`;
}

// --- zone: piano di attivazione del settore ---------------------------
// Le zone che riguardano il settore (vicine e con livelli sovrapposti), con lo stato del momento e le fasce
// orarie UTC: in allarme, attive, in attivazione entro 15 minuti, più tardi, oppure non più attive oggi.
let lastAreasKey = '';

function areaStatus(area, clock) {
  const w = currentOrNextWindow(sim.areaSchedule, area, clock);
  const active = isActiveAt(sim.areaSchedule, area, clock);
  const h24 = w && w[0] === -Infinity;
  const hhmm = (x) => fmtClock(x).replace(':', '');
  const until = h24 ? 'H24' : w ? `ACT –${hhmm(w[1])}` : '';
  if (area.alarm) return { rank: 0, cls: 'alarm', when: active ? `⚠ ${until}` : `⚠ ${hhmm(w[0])}–${hhmm(w[1])}` };
  if (active) return { rank: 1, cls: 'active', when: until };
  if (w && w[0] - clock <= PREACTIVE_S) return { rank: 2, cls: 'soon', when: `${hhmm(w[0])}–${hhmm(w[1])}` };
  if (w) return { rank: 3, cls: 'later', when: `${hhmm(w[0])}–${hhmm(w[1])}` };
  return { rank: 4, cls: 'off', when: '—' };
}

function updateAreasMenu() {
  const clock = sim.clockS;
  const rows = airspace.areas.filter((a) => sim.relevantAreas.has(a.id))
    .map((a) => ({ a, st: areaStatus(a, clock) }))
    .sort((p, q) => p.st.rank - q.st.rank || p.a.name.localeCompare(q.a.name, 'it', { numeric: true }));
  const key = rows.map(({ a, st }) => `${a.id}${st.cls}${st.when}`).join('|');
  if (key === lastAreasKey) return;
  lastAreasKey = key;
  const list = $('areas-list');
  list.innerHTML = '';
  for (const { a, st } of rows) {
    const row = document.createElement('div');
    row.className = `area-row ${st.cls}`;
    row.title = `${a.name}: ${AREA_KINDS[a.kind]}, ${areaBand(a)}`;
    row.innerHTML = '<span class="area-name"></span><span class="area-band"></span><span class="area-when"></span>';
    row.querySelector('.area-name').textContent = a.name;
    row.querySelector('.area-band').textContent = areaBand(a);
    row.querySelector('.area-when').textContent = st.when;
    list.appendChild(row);
  }
  if (!rows.length) list.innerHTML = '<div class="muted small">Nessuna zona vicina ai livelli del settore.</div>';
  const active = rows.filter((r) => r.st.rank <= 1).length;
  const next = rows.filter((r) => r.st.rank === 2 || r.st.rank === 3)
    .sort((p, q) => currentOrNextWindow(sim.areaSchedule, p.a, clock)[0] - currentOrNextWindow(sim.areaSchedule, q.a, clock)[0])[0];
  $('areas-menu-info').textContent = `${active} ACT${next ? ` · ${next.a.name} ${fmtClock(currentOrNextWindow(sim.areaSchedule, next.a, clock)[0]).replace(':', '')}` : ''}`;
}

let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;

  // il ciclo si riprogramma sempre per primo: un errore imprevisto non deve mai bloccare il radar
  requestAnimationFrame(loop);
  if (!sim) return;
  try {
    sim.tick(dt);
    labelPanel.notifyIfRemoved(sim.aircraft);
    // il menu del tag si chiude se il volo non è più di nostra competenza o è uscito dal radar
    if (tagMenu && (!sim.aircraft.includes(tagMenu.ac) || tagMenu.ac.control !== 'assumed')) closeTagMenu();
    // le misure e le linee di prua di aerei usciti dal radar spariscono
    const present = (o) => !isAircraft(o) || sim.aircraft.includes(o);
    if (measures.length) measures = measures.filter((m) => present(m.a) && present(m.b));
    if (isAircraft(rbStart) && !sim.aircraft.includes(rbStart)) rbStart = null;
    if (cpas.length) cpas = cpas.filter((c) => sim.aircraft.includes(c.a) && sim.aircraft.includes(c.b));
    if (cpaFirst && !sim.aircraft.includes(cpaFirst)) cpaFirst = null;
    render(ctx, canvas, sim, {
      futureConflicts: [],
      stca: sim.stca,
      preview: labelPanel.preview,
      now,
      measures,
      measuring: tool === 'rb' && rbStart && cursor ? { from: rbStart, ...cursor } : null,
      cpas,
      cpaPick: tool === 'cpa' ? cpaFirst : null,
    });
    if (tutorial?.active) {
      tutorial.draw(ctx, canvas, makeTransform(canvas), now);
      tutorial.tick(now);
    }
    labelPanel.tick(now);
    updateHud();
    updateAreasMenu();
    updateRadioMessages();
  } catch (err) {
    console.error('Errore nel ciclo di simulazione', err);
  }
}

buildCentreTabs();
selectCentre(CENTRE.id);
resizeCanvas();
requestAnimationFrame(loop);
