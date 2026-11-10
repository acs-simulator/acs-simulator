import { airspace, waypoint, inView, insideLateral, isFraPoint } from './airspace.js';
import { predictConflicts, SEP_HORIZONTAL_NM, SEP_VERTICAL_FT, STCA_S } from './sim.js';
import { isSemicircularLevel, isSouthbound } from './sectors.js';
import { angleDiff, bearing, distance, normalizeDeg } from './geo.js';
import { speedEnvelope } from './performance.js';
import { emergencyCall, emergencyStatus } from './emergency.js';
import { requestStatus, REQUEST_LABEL } from './requests.js';
import { areaBand } from './areas.js';

const CONTROL_LABELS = {
  assumed: 'IN CONTATTO',
  offered: 'DA ASSUMERE',
  inbound: 'NON IN CONTATTO',
  other: 'NON IN CONTATTO',
  transferred: 'TRASFERITO',
};

const KIND_LABELS = {
  overflight: 'Crociera',
  departure: 'In salita',
  arrival: 'In discesa',
};

const EXIT_LABELS = {
  lateral: 'COP',
  top: 'uscita dall\'alto, in salita',
  bottom: 'uscita dal basso, in discesa',
  star: 'inizio STAR',
};

const REFRESH_MS = 200;
const MESSAGE_MS = 3500;
const SVG_NS = 'http://www.w3.org/2000/svg';

const LIMITS = {
  heading: { min: 1, max: 360 },
  speed: { min: 160, max: 560 },
  fl: { min: 50, max: 450 },
};

const fmtHeading = (deg) => String(Math.round(normalizeDeg(deg)) % 360 || 360).padStart(3, '0');
const fmtFl = (fl) => `FL${String(Math.round(fl)).padStart(3, '0')}`;

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clampField(key, value) {
  if (key === 'heading') {
    const deg = Math.round(normalizeDeg(value));
    return deg === 0 ? 360 : deg;
  }
  const { min, max } = LIMITS[key];
  return Math.round(Math.max(min, Math.min(max, value)));
}

function polar(deg, r) {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.sin(rad) * r, y: -Math.cos(rad) * r };
}

// Etichetta del volo selezionato. I campi mostrano sempre i valori reali dell'aereo
// e si aggiornano in tempo reale finché il controllore non ne modifica uno:
// da quel momento il valore resta "in sospeso" (giallo) fino a quando viene impartito.
export class LabelPanel {
  constructor(root, sim) {
    this.sim = sim;
    this.aircraft = null;
    this.pickedRouteIndex = null;
    this.highlightWaypointId = null;
    this.dirty = { heading: false, speed: false, fl: false };
    this._lastRefresh = 0;
    this._routeKey = '';
    this._lastRoute = null;
    this._alertKey = null;
    this._msgTimer = null;

    const $ = (sel) => root.querySelector(sel);
    this.el = {
      panel: $('#label-panel'),
      callsign: $('#label-callsign'),
      spoken: $('#label-spoken'),
      badgeMode: $('#badge-mode'),
      badgeControl: $('#badge-control'),
      badgeKind: $('#badge-kind'),
      plan: $('#label-plan'),
      xferLevel: $('#xfer-level'),
      xferFix: $('#xfer-fix'),
      xferUnit: $('#xfer-unit'),
      xferCheck: $('#xfer-check'),
      handonBtn: $('#handon-btn'),
      handoffBtn: $('#handoff-btn'),
      controls: $('#label-controls'),
      alerts: $('#label-alerts'),
      last: $('#label-last'),
      msg: $('#label-msg'),
      hdgCurrent: $('#hdg-current'),
      hdgTarget: $('#hdg-target'),
      hdgTargetLabel: $('#hdg-target-label'),
      resumeNav: $('#resume-nav'),
      spdCurrent: $('#spd-current'),
      spdTarget: $('#spd-target'),
      spdTargetLabel: $('#spd-target-label'),
      spdHint: $('#spd-hint'),
      resumeSpeed: $('#resume-speed'),
      speedRange: $('#in-speed-range'),
      flCurrent: $('#fl-current'),
      flTarget: $('#fl-target'),
      flVertical: $('#fl-vertical'),
      flHint: $('#fl-hint'),
      routeList: $('#route-list'),
      wpSelect: $('#wp-select'),
      insertWp: $('#insert-wp'),
    };
    this.fields = {
      heading: $('#in-heading'),
      speed: $('#in-speed'),
      fl: $('#in-fl'),
    };

    this._buildDial($('#hdg-dial'));
    this._wireFields(root);
    this._wireActions(root);
  }

  setSimulation(sim) {
    this.deselect();
    this.sim = sim;
  }

  // Hand-off del volo selezionato: dal pulsante HAND-OFF o dalla barra spaziatrice sul radar. Restituisce true
  // se il volo è stato passato (anche al livello sbagliato, che conta come errore).
  handOffSelected() {
    if (!this.aircraft || this.aircraft.control !== 'assumed' || this.sim?.gameOver) return false;
    if (this.sim.handOff(this.aircraft) === null) return false;
    this._afterTransferAction();
    return true;
  }

  // un volo in avaria radio (7600) non riceve più istruzioni: resta solo l'hand-off, coordinato per telefono
  get canInstruct() {
    return this.aircraft?.control === 'assumed' && !this.sim?.gameOver && this.aircraft.emergency?.radio !== false;
  }

  // --- selezione -----------------------------------------------------------

  // Un clic sul tag seleziona il volo (traccia cerchiata e rotta sul radar); il pannello con le istruzioni
  // si apre solo con il doppio clic sul nominativo, cioè con openPanel.
  select(aircraft, openPanel = true) {
    if (aircraft === this.aircraft) {
      if (openPanel) this.el.panel.classList.remove('hidden');
      this.refresh();
      return;
    }
    if (this.aircraft) this.aircraft.selected = false;
    this.aircraft = aircraft;
    aircraft.selected = true;
    this.pickedRouteIndex = null;
    this.highlightWaypointId = null;
    this._routeKey = '';
    this._lastRoute = null;
    this._alertKey = null;
    for (const key of Object.keys(this.fields)) this._clean(key);
    this._hideMessage();
    this._buildWaypointOptions(aircraft);
    this.el.panel.classList.toggle('hidden', !openPanel);
    this.refresh();
  }

  deselect() {
    if (this.aircraft) this.aircraft.selected = false;
    this.aircraft = null;
    this.highlightWaypointId = null;
    this.el.panel.classList.add('hidden');
  }

  notifyIfRemoved(currentList) {
    if (this.aircraft && !currentList.includes(this.aircraft)) this.deselect();
  }

  // Punto cliccato sul radar mentre l'etichetta è aperta.
  pickWaypoint(id) {
    const ac = this.aircraft;
    if (!ac || !this.canInstruct || !isFraPoint(id)) return false;
    if (this.el.panel.classList.contains('hidden')) return false; // pannello chiuso: il volo è solo selezionato
    this._ensureOption(id);
    this.el.wpSelect.value = id;
    this.highlightWaypointId = id;
    this._updateInsertLabel();
    return true;
  }

  // Anteprima da disegnare sul radar: prua proposta e punto scelto.
  get preview() {
    if (!this.aircraft) return null;
    const heading = parseFloat(this.fields.heading.value);
    return {
      aircraftId: this.aircraft.id,
      heading: this.dirty.heading && !Number.isNaN(heading) ? heading : null,
      waypointId: this.highlightWaypointId,
    };
  }

  // --- aggiornamento -------------------------------------------------------

  tick(now) {
    if (this.aircraft && now - this._lastRefresh >= REFRESH_MS) this.refresh();
  }

  refresh() {
    const ac = this.aircraft;
    if (!ac) return;
    this._lastRefresh = performance.now();
    const el = this.el;

    el.callsign.textContent = ac.callsign;
    el.spoken.textContent = ac.spoken;
    el.badgeMode.textContent = ac.mode === 'heading' ? 'PRUA ASSEGNATA' : 'ROTTA PROPRIA';
    el.badgeMode.classList.toggle('heading', ac.mode === 'heading');
    el.badgeControl.textContent = ac.control === 'transferred' && ac.nextUnit
      ? `TRASFERITO A ${ac.nextUnit}`
      : CONTROL_LABELS[ac.control];
    el.badgeControl.dataset.control = ac.control;
    el.badgeKind.textContent = `${ac.type.icao}/${ac.type.wake} · ${KIND_LABELS[ac.kind]}`;
    const from = ac.prevUnit && ac.control !== 'other'
      ? ` · da ${ac.prevUnit}${ac.entryFix ? ` su ${ac.entryFix}` : ''}` : '';
    // SID e STAR del piano di volo (solo per gli aeroporti visibili sul radar)
    const sid = ac.flow?.sid ? ` ${ac.flow.sid.label}` : '';
    const star = ac.flow?.star ? ` ${ac.flow.star.label}` : '';
    el.plan.textContent = `${ac.origin}${sid} → ${star ? `${star.trim()} ` : ''}${ac.destination} · RFL${ac.rfl ?? '-'}${from}`;
    el.last.textContent = ac.lastInstruction ? `✓ ${ac.lastInstruction}` : 'Nessuna istruzione impartita';

    this._refreshTransfer(ac);
    this._refreshHeading(ac);
    this._refreshSpeed(ac);
    this._refreshLevel(ac);
    this._refreshRoute(ac);
    this._refreshAlerts(ac);
  }

  // Blocco hand-on / hand-off: livello e punto di uscita richiesti, ente successivo, verifica livello.
  _refreshTransfer(ac) {
    const el = this.el;
    const levelOk = ac.exitLevelOk;
    el.xferLevel.textContent = ac.requestedExitFL !== null ? fmtFl(ac.requestedExitFL) : '-';
    // uscita laterale su un punto di coordinamento; dall'alto o dal basso attraversando il limite del settore
    const { floorFL, ceilingFL } = airspace.sector;
    el.xferFix.textContent = ac.exitKind === 'top' ? `↑ oltre ${fmtFl(ceilingFL)}`
      : ac.exitKind === 'bottom' ? `↓ sotto ${fmtFl(floorFL)}`
        : ac.exitKind === 'star' ? `${ac.exitFix} (${ac.flow.star.label})`
          : ac.exitFix ?? '-';
    el.xferUnit.textContent = ac.nextUnit ? `${ac.nextUnit} · ${EXIT_LABELS[ac.exitKind]}` : '-';

    el.handonBtn.classList.toggle('hidden', ac.control !== 'offered');
    el.handoffBtn.classList.toggle('hidden', ac.control !== 'assumed');
    el.handoffBtn.classList.toggle('level-wrong', !levelOk && !ac.emergency);
    el.handoffBtn.textContent = levelOk || ac.emergency ? 'HAND-OFF' : 'HAND-OFF ⚠';
    el.controls.disabled = !this.canInstruct;

    const check = el.xferCheck;
    if (ac.control === 'offered') {
      check.textContent = 'Passato a te dal settore precedente: clicca HAND-ON o l\'aereo sul radar.';
      check.className = 'hint offered';
    } else if (ac.control === 'assumed' && ac.emergency) {
      // volo in emergenza: il trasferimento si coordina a voce, il livello non conta come errore
      check.textContent = ac.emergency.radio
        ? `${ac.emergency.label} · ${emergencyStatus(ac)}. Portalo a ${fmtFl(ac.requestedExitFL)} e passalo a `
          + `${ac.nextUnit}; il trasferimento si coordina a voce e non conta come errore.`
        : `${ac.emergency.label} · nessuna istruzione possibile. Mantiene ${fmtFl(ac.clearedFL)}, `
          + `passalo a ${ac.nextUnit} coordinando a voce.`;
      check.className = levelOk ? 'hint ok' : 'hint warn';
    } else if (ac.control === 'assumed') {
      const when = ac.verticalExit
        ? `hand-off a ${ac.nextUnit} mentre si avvicina a ${fmtFl(ac.requestedExitFL)}`
        : ac.exitKind === 'star'
          ? `hand-off a ${ac.nextUnit} prima di ${ac.exitFix}, inizio della STAR`
          : 'pronto per l\'hand-off';
      // livello d'uscita rivisto su richiesta del pilota: vale anche quello pianificato
      const revised = ac.altExitFL !== null ? ` (XFL rivisto, vale anche ${fmtFl(ac.altExitFL)})` : '';
      check.textContent = levelOk
        ? `✓ Autorizzato ${fmtFl(ac.clearedFL)}: ${when}${revised}`
        : `⚠ Autorizzato ${fmtFl(ac.clearedFL)}, richiesto ${fmtFl(ac.requestedExitFL)}${revised}: l'hand-off conterebbe come errore`;
      check.className = levelOk ? 'hint ok' : 'hint warn';
    } else if (ac.control === 'transferred') {
      check.textContent = `Non più in contatto: passato a ${ac.nextUnit}.`;
      check.className = 'hint';
    } else {
      check.textContent = 'Non in contatto: nessuna istruzione possibile.';
      check.className = 'hint';
    }
  }

  _syncField(key, value) {
    const input = this.fields[key];
    if (this.dirty[key] || document.activeElement === input) return;
    input.value = value;
    if (key === 'speed') this.el.speedRange.value = value;
  }

  _refreshHeading(ac) {
    const el = this.el;
    el.hdgCurrent.textContent = `${fmtHeading(ac.heading)}°`;
    if (ac.mode === 'heading') {
      const side = ac.turnDirection === 'left' ? '◄ ' : ac.turnDirection === 'right' ? '► ' : '';
      el.hdgTargetLabel.textContent = 'Assegnata';
      el.hdgTarget.textContent = `${side}${fmtHeading(ac.assignedHeading)}°`;
    } else if (ac.route.length > 0) {
      el.hdgTargetLabel.textContent = `Verso ${ac.route[0]}`;
      el.hdgTarget.textContent = `${fmtHeading(bearing(ac, waypoint(ac.route[0])))}°`;
    } else {
      el.hdgTargetLabel.textContent = 'In uscita';
      el.hdgTarget.textContent = '-';
    }
    el.resumeNav.disabled = ac.mode !== 'heading';
    this._syncField('heading', clampField('heading', ac.mode === 'heading' ? ac.assignedHeading : ac.heading));
    this._updateDial();
  }

  _refreshSpeed(ac) {
    const el = this.el;
    const diff = ac.assignedSpeed - ac.speed;
    const trend = Math.abs(diff) >= 2 ? (diff > 0 ? ' ▲' : ' ▼') : '';
    const own = ac.speedMode === 'own';
    el.spdCurrent.textContent = `${Math.round(ac.speed)}`;
    el.spdTargetLabel.textContent = own ? 'Propria' : 'Assegnata';
    el.spdTarget.textContent = `${Math.round(ac.assignedSpeed)}${trend}`;
    const { min, max } = speedEnvelope(ac.type, ac.altitude);
    el.spdHint.textContent = `${own ? 'Programma del pilota' : 'Velocità assegnata'} · a ${fmtFl(ac.flightLevel)} assegnabile ${min}–${max} kt`;
    el.resumeSpeed.disabled = own;
    this._syncField('speed', Math.round(ac.assignedSpeed));
  }

  _refreshLevel(ac) {
    const el = this.el;
    const diff = ac.assignedAltitude - ac.altitude;
    el.flCurrent.textContent = fmtFl(ac.flightLevel);
    el.flTarget.textContent = fmtFl(ac.assignedAltitude / 100);

    if (Math.abs(diff) >= 100) {
      // rateo alla quota attuale: in salita diminuisce salendo
      const fpm = Math.round(((diff > 0 ? ac.climbFtS : ac.descentFtS) * 60) / 50) * 50;
      el.flVertical.textContent =
        `${diff > 0 ? '↑ In salita' : '↓ In discesa'} ${fpm} ft/min · livella tra ${fmtDuration(Math.abs(diff) / (fpm / 60))}`;
    } else {
      el.flVertical.textContent = 'Livellato';
    }

    this._syncField('fl', Math.round(ac.assignedAltitude / 100));
    this._updateLevelHint();
  }

  // Suggerimenti sul livello proposto: regola semicircolare e traffico vicino allo stesso livello.
  _updateLevelHint() {
    const ac = this.aircraft;
    const hint = this.el.flHint;
    const fl = parseFloat(this.fields.fl.value);
    if (!ac || Number.isNaN(fl)) {
      hint.textContent = '';
      return;
    }
    // semicircolare italiana sulla rotta pianificata del volo
    const track = ac.levelTrack ?? bearing(ac, waypoint(ac.route[ac.exitIndex]) ?? ac);
    const rule = isSouthbound(track)
      ? `rotta ${fmtHeading(track)}° verso sud: livelli dispari`
      : `rotta ${fmtHeading(track)}° verso nord: livelli pari`;

    const busy = this.sim.aircraft
      .filter((o) => o !== ac && distance(o, ac) < 25)
      .filter((o) => Math.abs(o.altitude - fl * 100) < SEP_VERTICAL_FT || Math.abs(o.assignedAltitude - fl * 100) < SEP_VERTICAL_FT)
      .sort((a, b) => distance(a, ac) - distance(b, ac))[0];

    if (busy) {
      hint.textContent = `⚠ ${fmtFl(fl)} occupato da ${busy.callsign} a ${Math.round(distance(busy, ac))} nm`;
      hint.className = 'hint warn';
    } else if (isSemicircularLevel(fl, track)) {
      hint.textContent = `✓ Conforme alla semicircolare (${rule})`;
      hint.className = 'hint ok';
    } else {
      hint.textContent = `⚠ Non conforme alla semicircolare (${rule})`;
      hint.className = 'hint warn';
    }
  }

  // --- rotta ---------------------------------------------------------------

  _refreshRoute(ac) {
    const list = this.el.routeList;
    this._trackRouteShift(ac.route);

    // la lista si ricostruisce solo quando cambia la rotta: così i clic non vanno persi
    const exitIndex = ac.exitIndex;
    const key = `${ac.route.join('>')}|${this.pickedRouteIndex}|${exitIndex}`;
    if (key !== this._routeKey) {
      this._routeKey = key;
      list.innerHTML = '';
      ac.route.slice(0, exitIndex + 1).forEach((id, idx) => {
        // ultimo punto modificabile: il punto d'uscita, oppure (uscite dall'alto o dal basso) il primo punto oltre
        // il confine laterale, che non si rimuove ma non è un punto d'uscita
        const isLimit = idx === exitIndex;
        const isExit = isLimit && id === ac.exitFix;
        const li = document.createElement('li');
        li.dataset.idx = String(idx);
        if (isExit) li.classList.add('exit-fix');
        if (idx === this.pickedRouteIndex) li.classList.add('picked');
        li.innerHTML =
          `<span class="wp-name">${id}${isExit ? '<em>uscita</em>' : ''}</span>` +
          '<span class="wp-dist"></span><span class="wp-eta"></span>' +
          `<span class="wp-actions"><button data-action="direct" title="Diretto a ${id}">→</button>` +
          (isLimit ? '' : `<button data-action="remove" title="Rimuovi ${id}">✕</button>`) +
          '</span>';
        list.appendChild(li);
      });
      if (ac.destination && ac.route[ac.route.length - 1] === ac.destination && exitIndex < ac.route.length - 1) {
        const dest = document.createElement('li');
        dest.className = 'dest';
        dest.textContent = `… poi ${ac.destination} (altri enti)`;
        list.appendChild(dest);
      }
      this._updateInsertLabel();
    }

    let prev = ac;
    let cumulative = 0;
    list.querySelectorAll('li[data-idx]').forEach((li, idx) => {
      const wp = waypoint(ac.route[idx]);
      if (!wp) return;
      cumulative += distance(prev, wp);
      prev = wp;
      li.querySelector('.wp-dist').textContent = `${Math.round(cumulative)} nm`;
      li.querySelector('.wp-eta').textContent = fmtDuration((cumulative / Math.max(ac.speed, 1)) * 3600);
    });
    // in prua assegnata le ETA sono solo indicative (l'aereo non sta seguendo la rotta)
    list.classList.toggle('stale', ac.mode === 'heading');
  }

  // Quando l'aereo sorvola un punto, la selezione della riga scorre di conseguenza.
  _trackRouteShift(route) {
    const prev = this._lastRoute;
    if (
      prev && this.pickedRouteIndex !== null &&
      route.length === prev.length - 1 && route.join('>') === prev.slice(1).join('>')
    ) {
      this.pickedRouteIndex = this.pickedRouteIndex > 0 ? this.pickedRouteIndex - 1 : null;
    }
    this._lastRoute = [...route];
  }

  _insertIndex() {
    const exitIndex = this.aircraft.exitIndex;
    if (this.pickedRouteIndex === null) return exitIndex;
    return Math.min(this.pickedRouteIndex + 1, exitIndex);
  }

  _updateInsertLabel() {
    const ac = this.aircraft;
    const btn = this.el.insertWp;
    if (!ac || ac.route.length === 0) {
      btn.textContent = 'Rotta completata';
      btn.disabled = true;
      return;
    }
    const id = this.el.wpSelect.value;
    const idx = this._insertIndex();
    btn.disabled = !id || id === ac.exitFix;
    btn.textContent = idx > 0
      ? `Inserisci ${id} dopo ${ac.route[idx - 1]}`
      : `Inserisci ${id} prima di ${ac.route[idx]}`;
  }

  _buildWaypointOptions(ac) {
    const select = this.el.wpSelect;
    select.innerHTML = '';
    const addGroup = (label, ids) => {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        group.appendChild(opt);
      }
      select.appendChild(group);
    };
    const visible = airspace.waypoints.filter((w) => (inView(w, 80) || ac.route.includes(w.id)) && w.id !== ac.exitFix);
    if (ac.exitFix) addGroup('Uscita richiesta', [ac.exitFix]);
    addGroup('Punti di coordinamento del settore', visible.filter((w) => airspace.copIds.has(w.id)).map((w) => w.id).sort());
    addGroup('Punti FRA nel settore', visible.filter((w) => !airspace.copIds.has(w.id) && insideLateral(w)).map((w) => w.id).sort());
    addGroup('Altri punti FRA', visible.filter((w) => !airspace.copIds.has(w.id) && !insideLateral(w)).map((w) => w.id).sort());
    const first = ac.route.find((id) => isFraPoint(id));
    select.value = first ?? ac.exitFix ?? '';
    if (!select.value && select.options.length) select.selectedIndex = 0;
  }

  _ensureOption(id) {
    const select = this.el.wpSelect;
    if ([...select.options].some((o) => o.value === id)) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }

  // --- conflitti -----------------------------------------------------------

  _refreshAlerts(ac) {
    const items = [];
    for (const other of this.sim.aircraft) {
      if (other === ac) continue;
      if (distance(ac, other) < SEP_HORIZONTAL_NM && Math.abs(ac.altitude - other.altitude) < SEP_VERTICAL_FT) {
        items.push({ other, t: 0, now: true });
      }
    }
    for (const c of predictConflicts(this.sim.aircraft)) {
      const other = c.a === ac ? c.b : c.b === ac ? c.a : null;
      if (!other || items.some((i) => i.other === other)) continue;
      items.push({ other, t: c.timeToConflict, now: false });
    }
    // emergenza dichiarata dal volo e richiesta in attesa: sempre in cima agli avvisi
    if (ac.emergency) items.push({ emg: ac.emergency, t: -1, now: ac.emergency.phase === 'requested' });
    if (ac.request) items.push({ req: ac.request, t: -0.5, now: ac.request.phase === 'pending' });
    // zona attiva sulla rotta e al livello autorizzato del volo
    const zone = ac.areaConflict;
    if (zone) items.push({ area: zone.area, t: zone.t, now: zone.t === 0, apw: ac.apw === zone.area });
    else if (ac.apw) items.push({ area: ac.apw, t: 0, now: false, apw: true, near: true });
    items.sort((a, b) => a.t - b.t);
    for (const item of items) item.stca = !item.now && !item.emg && !item.req && (item.area ? item.apw : item.t <= STCA_S);

    const box = this.el.alerts;
    box.classList.toggle('hidden', items.length === 0);
    const key = items.map((i) => `${i.emg ? `emg${i.emg.phase}` : i.req ? `req${i.req.kind}${i.req.phase}` : i.other ? i.other.id : i.area.id}`
      + `${i.now ? '!' : i.stca ? '*' : ''}`).join(',');
    // ricostruisce anche se il numero di pulsanti non corrisponde (es. etichetta di un altro volo)
    if (key !== this._alertKey || box.children.length !== items.length) {
      this._alertKey = key;
      box.innerHTML = '';
      for (const item of items) {
        const btn = document.createElement('button');
        btn.className = item.now || item.stca ? 'alert-item now' : 'alert-item';
        if (item.req) {
          btn.title = `${REQUEST_LABEL[item.req.kind]}: si autorizza dando quanto chiesto`;
        } else if (item.emg) {
          btn.title = `${item.emg.label}: ${emergencyCall(item.emg)}`;
        } else if (item.other) {
          btn.dataset.id = String(item.other.id);
          btn.title = `Apri l'etichetta di ${item.other.callsign}`;
        } else {
          btn.title = `Zona ${item.area.name} attiva ${areaBand(item.area)}: vettora il volo attorno o cambia livello`;
        }
        btn.innerHTML = '<span class="alert-text"></span><span class="alert-time"></span>';
        box.appendChild(btn);
      }
    }
    box.querySelectorAll('.alert-item').forEach((btn, i) => {
      if (!items[i]) return;
      const { other, t, now, stca, area, near, emg, req } = items[i];
      if (req) {
        btn.querySelector('.alert-text').textContent = `✋ ${REQUEST_LABEL[req.kind]}`;
        btn.querySelector('.alert-time').textContent = requestStatus(ac);
        return;
      }
      if (emg) {
        btn.querySelector('.alert-text').textContent = `⚠ ${emg.label} · ${emergencyCall(emg)}`;
        btn.querySelector('.alert-time').textContent = emergencyStatus(ac);
        return;
      }
      if (area) {
        btn.querySelector('.alert-text').textContent = `⚠ ${near ? 'Vicino alla' : 'Nella'} zona ${area.name} ${areaBand(area)}`;
        btn.querySelector('.alert-time').textContent = now || near ? 'ORA' : `tra ${fmtDuration(t)}`;
        return;
      }
      btn.querySelector('.alert-text').textContent = now
        ? `⚠ Separazione persa con ${other.callsign}`
        : `⚠ ${stca ? 'STCA' : 'Conflitto'} con ${other.callsign} · ${fmtFl(other.flightLevel)}`;
      btn.querySelector('.alert-time').textContent = now ? 'ORA' : `tra ${fmtDuration(t)}`;
    });
  }

  // --- quadrante della prua -------------------------------------------------

  _buildDial(container) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '-60 -60 120 120');
    svg.setAttribute('class', 'dial');
    const make = (tag, attrs, cls) => {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      if (cls) node.setAttribute('class', cls);
      svg.appendChild(node);
      return node;
    };

    make('circle', { r: 55 }, 'dial-face');
    for (let d = 0; d < 360; d += 10) {
      const major = d % 30 === 0;
      const outer = polar(d, 55);
      const inner = polar(d, major ? 47 : 51);
      make('line', { x1: outer.x, y1: outer.y, x2: inner.x, y2: inner.y }, major ? 'dial-tick major' : 'dial-tick');
    }
    for (const [d, text] of [[0, '36'], [90, '09'], [180, '18'], [270, '27']]) {
      const p = polar(d, 37);
      make('text', { x: p.x, y: p.y + 3.5 }, 'dial-label').textContent = text;
    }

    this.dial = {
      svg,
      route: make('circle', { r: 3.5, cx: 0, cy: -55 }, 'dial-route'),
      target: make('line', { x1: 0, y1: 0, x2: 0, y2: -50 }, 'dial-target'),
      current: make('line', { x1: 0, y1: 0, x2: 0, y2: -42 }, 'dial-current'),
    };
    make('circle', { r: 3 }, 'dial-hub');
    container.appendChild(svg);

    let dragging = false;
    const setFromPointer = (ev) => {
      const rect = svg.getBoundingClientRect();
      const dx = ev.clientX - (rect.left + rect.width / 2);
      const dy = ev.clientY - (rect.top + rect.height / 2);
      const deg = normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
      this.fields.heading.value = clampField('heading', Math.round(deg / 5) * 5);
      this._markDirty('heading');
    };
    svg.addEventListener('pointerdown', (ev) => {
      if (!this.canInstruct) return;
      dragging = true;
      svg.setPointerCapture(ev.pointerId);
      setFromPointer(ev);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (dragging) setFromPointer(ev);
    });
    svg.addEventListener('pointerup', () => { dragging = false; });
    svg.addEventListener('pointercancel', () => { dragging = false; });
  }

  _updateDial() {
    const ac = this.aircraft;
    if (!ac) return;
    const setNeedle = (line, deg, r) => {
      const p = polar(deg, r);
      line.setAttribute('x2', p.x);
      line.setAttribute('y2', p.y);
    };
    setNeedle(this.dial.current, ac.heading, 42);

    const proposed = parseFloat(this.fields.heading.value);
    const showTarget = this.dirty.heading ? !Number.isNaN(proposed) : ac.mode === 'heading';
    this.dial.target.style.visibility = showTarget ? 'visible' : 'hidden';
    this.dial.target.classList.toggle('pending', this.dirty.heading);
    if (showTarget) setNeedle(this.dial.target, this.dirty.heading ? proposed : ac.assignedHeading, 50);

    const next = ac.route.length > 0 ? waypoint(ac.route[0]) : null;
    this.dial.route.style.visibility = next ? 'visible' : 'hidden';
    if (next) {
      const p = polar(bearing(ac, next), 55);
      this.dial.route.setAttribute('cx', p.x);
      this.dial.route.setAttribute('cy', p.y);
    }
  }

  // --- campi e istruzioni ---------------------------------------------------

  _markDirty(key) {
    this.dirty[key] = true;
    this.fields[key].classList.add('pending');
    if (key === 'heading') this._updateDial();
    if (key === 'fl') this._updateLevelHint();
  }

  _clean(key) {
    this.dirty[key] = false;
    this.fields[key].classList.remove('pending');
  }

  _wireFields(root) {
    for (const [key, input] of Object.entries(this.fields)) {
      input.addEventListener('input', () => {
        this._markDirty(key);
        if (key === 'speed') this.el.speedRange.value = input.value;
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          this._apply(key);
        } else if (ev.key === 'Escape') {
          // Esc nel campo annulla solo la modifica in sospeso
          ev.stopPropagation();
          this._clean(key);
          input.blur();
          this.refresh();
        }
      });
    }

    this.el.speedRange.addEventListener('input', () => {
      this.fields.speed.value = this.el.speedRange.value;
      this._markDirty('speed');
    });

    root.querySelectorAll('[data-step-for]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.stepFor;
        const input = this.fields[key];
        const base = parseFloat(input.value);
        const value = clampField(key, (Number.isNaN(base) ? 0 : base) + parseFloat(btn.dataset.step));
        input.value = value;
        if (key === 'speed') this.el.speedRange.value = value;
        this._markDirty(key);
      });
    });
  }

  _apply(key) {
    if (key === 'heading') this._applyHeading(null);
    else if (key === 'speed') this._applySpeed();
    else this._applyLevel();
  }

  _readField(key, errorText) {
    const value = parseFloat(this.fields[key].value);
    if (Number.isNaN(value)) {
      this._showMessage(errorText);
      return null;
    }
    return clampField(key, value);
  }

  _applyHeading(direction) {
    const ac = this.aircraft;
    if (!ac) return;
    const hdg = this._readField('heading', 'Inserisci una prua tra 001 e 360');
    if (hdg === null) return;
    const side = direction ?? (angleDiff(hdg, ac.heading) >= 0 ? 'right' : 'left');
    ac.setHeading(hdg, side);
    this._clean('heading');
    this._instruct(`Vira a ${side === 'right' ? 'destra' : 'sinistra'} prua ${fmtHeading(hdg)}`);
  }

  _applySpeed() {
    const ac = this.aircraft;
    if (!ac) return;
    const kt = this._readField('speed', 'Inserisci una velocità valida');
    if (kt === null) return;
    const applied = ac.setSpeed(kt);
    this._clean('speed');
    this._instruct(`Velocità ${applied} nodi`);
    if (applied !== kt) this._showMessage(`${ac.type.icao} a ${fmtFl(ac.flightLevel)} non può volare a ${kt} kt: velocità ${applied} kt`);
  }

  _applyLevel() {
    const ac = this.aircraft;
    if (!ac) return;
    const value = this._readField('fl', 'Inserisci un livello di volo valido');
    if (value === null) return;
    const fl = Math.round(value / 10) * 10; // i livelli sono multipli di 1000 ft
    const verb = fl * 100 > ac.altitude + 50 ? 'Sali a' : fl * 100 < ac.altitude - 50 ? 'Scendi a' : 'Mantieni';
    ac.setFlightLevel(fl);
    this._clean('fl');
    this._instruct(`${verb} ${fmtFl(fl)}`);
  }

  // Istruzione impartita dal menu a tendina aperto sul tag, anche senza aprire l'etichetta.
  // Restituisce il valore applicato (la velocità può essere limitata dalle prestazioni) oppure null.
  commandFromTag(ac, kind, value) {
    if (!ac || ac.control !== 'assumed' || this.sim?.gameOver || ac.noRadio) return null;
    let applied = value;
    let field = null; // campo dell'etichetta da riallineare, se è aperta su questo volo
    if (kind === 'fl') {
      const verb = value * 100 > ac.altitude + 50 ? 'Sali a' : value * 100 < ac.altitude - 50 ? 'Scendi a' : 'Mantieni';
      ac.setFlightLevel(value);
      ac.lastInstruction = `${verb} ${fmtFl(value)}`;
      field = 'fl';
    } else if (kind === 'speed') {
      applied = ac.setSpeed(value);
      ac.lastInstruction = `Velocità ${applied} nodi`;
      field = 'speed';
    } else if (kind === 'mach') {
      // value: Mach per cento (78 = Mach .78)
      const mach = ac.setMach(value / 100);
      if (mach === null) return null;
      applied = Math.round(mach * 100);
      ac.lastInstruction = `Mach .${String(applied).padStart(2, '0')}`;
      field = 'speed';
    } else if (kind === 'heading') {
      const side = angleDiff(value, ac.heading) >= 0 ? 'right' : 'left';
      ac.setHeading(value, side);
      ac.lastInstruction = `Vira a ${side === 'right' ? 'destra' : 'sinistra'} prua ${fmtHeading(value)}`;
      field = 'heading';
    } else if (kind === 'fix') {
      if (!ac.directTo(value)) return null;
      ac.lastInstruction = `Diretto a ${value}`;
      this._routeKey = '';
    } else if (kind === 'rate') {
      const climbing = ac.assignedAltitude > ac.altitude;
      applied = ac.setVerticalRate(value * 100);
      if (applied === null) return null;
      ac.lastInstruction = `${climbing ? 'Sali' : 'Scendi'} con ${applied} ft/min`;
      applied /= 100;
    }
    if (this.aircraft === ac) {
      if (field) this._clean(field);
      this._instruct(ac.lastInstruction);
    }
    return applied;
  }

  _afterTransferAction() {
    for (const key of Object.keys(this.fields)) this._clean(key);
    this._routeKey = '';
    this.refresh();
    this.el.last.classList.remove('flash');
    void this.el.last.offsetWidth;
    this.el.last.classList.add('flash');
  }

  _instruct(text) {
    this.aircraft.lastInstruction = text;
    this._hideMessage();
    this.refresh();
    this.el.last.classList.remove('flash');
    void this.el.last.offsetWidth; // riavvia l'animazione
    this.el.last.classList.add('flash');
  }

  _showMessage(text) {
    this.el.msg.textContent = text;
    this.el.msg.classList.remove('hidden');
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => this._hideMessage(), MESSAGE_MS);
  }

  _hideMessage() {
    clearTimeout(this._msgTimer);
    this.el.msg.classList.add('hidden');
  }

  _wireActions(root) {
    const $ = (sel) => root.querySelector(sel);

    $('#label-close').addEventListener('click', () => this.deselect());

    this.el.handonBtn.addEventListener('click', () => {
      if (this.aircraft && this.sim.handOn(this.aircraft)) this._afterTransferAction();
    });
    this.el.handoffBtn.addEventListener('click', () => this.handOffSelected());
    $('#hdg-apply').addEventListener('click', () => this._applyHeading(null));
    $('#hdg-left').addEventListener('click', () => this._applyHeading('left'));
    $('#hdg-right').addEventListener('click', () => this._applyHeading('right'));
    $('#set-speed').addEventListener('click', () => this._applySpeed());
    $('#set-fl').addEventListener('click', () => this._applyLevel());

    root.querySelectorAll('[data-turn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ac = this.aircraft;
        if (!ac) return;
        const delta = parseFloat(btn.dataset.turn);
        ac.turnBy(delta);
        this._clean('heading');
        this._instruct(
          `Vira a ${delta > 0 ? 'destra' : 'sinistra'} di ${Math.abs(delta)}° (prua ${fmtHeading(ac.assignedHeading)})`
        );
      });
    });

    this.el.resumeSpeed.addEventListener('click', () => {
      const ac = this.aircraft;
      if (!ac) return;
      ac.resumeOwnSpeed();
      this._clean('speed');
      this._instruct('Riprendi velocità propria');
    });

    this.el.resumeNav.addEventListener('click', () => {
      const ac = this.aircraft;
      if (!ac) return;
      ac.resumeOwnNavigation();
      this._clean('heading');
      this._instruct(ac.route.length > 0 ? `Riprendi navigazione propria verso ${ac.route[0]}` : 'Riprendi navigazione propria');
    });

    this.el.wpSelect.addEventListener('change', () => {
      this.highlightWaypointId = this.el.wpSelect.value;
      this._updateInsertLabel();
    });

    $('#direct-to').addEventListener('click', () => {
      const ac = this.aircraft;
      if (!ac) return;
      const id = this.el.wpSelect.value;
      if (!isFraPoint(id) || !ac.directTo(id)) {
        const limit = ac.exitFix
          ? `Il punto d'uscita ${ac.exitFix} non si può saltare`
          : `Oltre ${ac.route[ac.exitIndex]} la rotta è di altri enti`;
        this._showMessage(isFraPoint(id) ? limit : 'Scegli un punto valido');
        return;
      }
      this.pickedRouteIndex = null;
      this.highlightWaypointId = null;
      this._clean('heading');
      this._instruct(`Diretto a ${id}`);
    });

    this.el.insertWp.addEventListener('click', () => {
      const ac = this.aircraft;
      if (!ac || ac.route.length === 0) return;
      const id = this.el.wpSelect.value;
      const idx = this._insertIndex();
      if (!isFraPoint(id)) {
        this._showMessage('Scegli un punto valido');
        return;
      }
      if (ac.route[idx] === id || ac.route[idx - 1] === id) {
        this._showMessage(`${id} è già in quella posizione della rotta`);
        return;
      }
      ac.insertWaypoint(id, idx);
      const where = idx > 0 ? `dopo ${ac.route[idx - 1]}` : `prima di ${ac.route[idx + 1]}`;
      this.pickedRouteIndex = idx; // inserimenti successivi proseguono dopo il nuovo punto
      this.highlightWaypointId = null;
      this._instruct(`Inserito ${id} ${where}`);
    });

    // un solo gestore per tutte le righe della rotta (le righe vengono ricreate)
    this.el.routeList.addEventListener('click', (ev) => {
      const ac = this.aircraft;
      const li = ev.target.closest('li[data-idx]');
      if (!ac || !li || !this.canInstruct) return;
      const idx = Number(li.dataset.idx);
      const id = ac.route[idx];
      const action = ev.target.closest('button')?.dataset.action;

      if (action === 'direct') {
        if (!ac.directToRouteIndex(idx)) return;
        this.pickedRouteIndex = null;
        this._clean('heading');
        this._instruct(`Diretto a ${id}`);
      } else if (action === 'remove') {
        if (!ac.removeWaypointAt(idx)) return;
        this.pickedRouteIndex = null;
        this._instruct(`Cancellato ${id} dalla rotta`);
      } else {
        this.pickedRouteIndex = this.pickedRouteIndex === idx ? null : idx;
        this.refresh();
      }
    });

    this.el.alerts.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.alert-item');
      if (!btn) return;
      const other = this.sim.aircraft.find((a) => a.id === Number(btn.dataset.id));
      if (other) this.select(other);
    });
  }
}
