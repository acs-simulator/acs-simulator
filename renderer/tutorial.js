// Modalità guidata: lezioni passo per passo sul simulatore vero, non su una finta copia.
// Ogni lezione apre una sessione normale (stesso motore, stesse regole, stesso radar) ma con il traffico
// "scritto": nessun volo compare da solo, li fa comparire la lezione quando servono, con le caratteristiche
// che quel passo vuole insegnare (livellato, in discesa verso il settore inferiore, in conflitto, dentro una
// zona che si attiva...). I voli restano veri: profilo, prestazioni, coordinamento e allarmi sono quelli
// della simulazione, quindi quello che si impara qui vale tale e quale nelle sessioni libere.
//
// Struttura:
//   LESSONS    elenco delle lezioni; ogni lezione ha dei passi
//   passo      { title, text, goal, hint, arm(), done(), focus(), onEvent(), leave() }
//              arm()  prepara la situazione (fa comparire i voli, attiva una zona, scatena l'avaria)
//              done() viene interrogato a ogni fotogramma: quando è vero il passo è superato
//              focus() dice cosa evidenziare: un elemento dell'interfaccia, una traccia, un tag, un punto
//   Tutorial   il motore: riquadro dell'istruttore, evidenziazioni, progressi, suoni

import { Aircraft, predictConflicts, OURS } from './sim.js';
import { makeOursPlan, advancePlan } from './traffic.js';
import { airspace, waypoint } from './airspace.js';
import { radarView, labelBlock, tagVisible } from './radar.js';
import { addCell } from './weather.js';
import { EMERGENCY_TYPES } from './emergency.js';

const fl = (v) => `FL${String(Math.round(v)).padStart(3, '0')}`;
const $ = (id) => document.getElementById(id);

// --- traffico su misura -----------------------------------------------------

// Un volo di nostra competenza con le caratteristiche volute: si pescano piani veri dai flussi finché
// uno non soddisfa `want`, poi lo si fa comparire già in viaggio, in modo che ci venga offerto fra offerIn
// secondi. assume: lo si mette subito in contatto, come se l'hand-on fosse già stato fatto.
// want: un filtro, oppure un elenco di filtri sempre meno esigenti (il primo che dà un volo vince): così
// una lezione non resta mai senza traffico perché il settore non aveva il volo perfetto.
export function spawnFlight(sim, { offerIn = 45, want = null, tries = 400, assume = false } = {}) {
  for (const filter of Array.isArray(want) ? want : [want]) {
    for (let i = 0; i < tries; i++) {
      const plan = makeOursPlan({ evolvingBias: 0 });
      if (!plan) continue;
      const near = advancePlan(plan, offerIn);
      if (!near) continue;
      near.areaChecked = true;   // le zone attive le decide la lezione, non il generatore
      if (filter && !filter(new Aircraft(near), sim)) continue;
      const ac = sim._trySpawnOurs(near);
      if (!ac) continue;
      if (assume) {
        ac.control = 'offered';
        ac.offeredAt = sim.simTime;
        sim.handOn(ac);
      }
      return ac;
    }
  }
  return null;
}

// Traffico di contorno (giallo) attorno al settore: serve a non far sembrare il radar vuoto.
export function fillBackground(sim, n) {
  for (let i = 0, placed = 0; i < n * 4 && placed < n; i++) {
    if (sim.spawnOther(true)) placed++;
  }
}

// Avanti veloce senza disegnare: la lezione porta la situazione dove serve (il volo vicino al suo punto
// d'uscita, il conflitto ormai vicino) in pochi millisecondi. stop: si ferma appena è vero.
export function warp(sim, maxS, stop = null) {
  const wasPaused = sim.paused;
  const mult = sim.timeMultiplier;
  sim.paused = false;
  sim.timeMultiplier = 1;
  let t = 0;
  while (t < maxS) {
    sim.tick(2);
    t += 2;
    if (stop && stop()) break;
  }
  sim.paused = wasPaused;
  sim.timeMultiplier = mult;
  return t;
}

// Punto a nm miglia davanti al volo lungo la sua rotta (non lungo la prua: la rotta gira).
export function aheadOnRoute(ac, nm) {
  let prev = { x: ac.x, y: ac.y };
  let left = nm;
  for (const id of ac.route) {
    const wp = waypoint(id);
    if (!wp) continue;
    const d = Math.hypot(wp.x - prev.x, wp.y - prev.y);
    if (d >= left) {
      const k = left / Math.max(d, 0.001);
      return { x: prev.x + (wp.x - prev.x) * k, y: prev.y + (wp.y - prev.y) * k };
    }
    left -= d;
    prev = { x: wp.x, y: wp.y };
  }
  return prev;
}

const alive = (sim, ac) => !!ac && sim.aircraft.includes(ac);
const ours = (sim, ac) => alive(sim, ac) && OURS.has(ac.control);

// --- lezioni ----------------------------------------------------------------

const SECTOR = 'NWA';   // NW ALTO: Tirreno e Toscana, passaggi lunghi e uscite di ogni tipo
const CENTRE = 'roma';

// filtri usati dai passi
const levelOverflight = (minStayS = 480) => (ac, sim) => ac.exitKind === 'lateral' && ac.entryKind === 'lateral'
  && ac.entryFt === ac.requestedExitFL * 100 && sim._timeToExit(ac) > minStayS;
// la stessa richiesta con due ripieghi: se il settore non ha un volo che resta così a lungo se ne prende
// uno che resta meno, e in ultima istanza un sorvolo livellato qualsiasi
const levelFlight = (minStayS) => [levelOverflight(minStayS), levelOverflight(minStayS * 0.6), levelOverflight(180)];
const descending = [
  (ac) => ac.exitKind === 'bottom' && ac.entryKind === 'lateral',
  (ac) => ac.exitKind === 'bottom',
];

export const LESSONS = [
  // ---------------------------------------------------------------- 1
  {
    id: 'radar',
    title: 'Il radar e il settore',
    subtitle: 'Che cosa stai guardando',
    learned: ['Che cos\'è un settore di ACC e dove sono i suoi confini',
      'Come leggere una traccia, la scia e il tag',
      'Spostare, ingrandire e ricentrare la vista'],
    background: 8,
    steps: [
      {
        freeze: true,
        title: 'Benvenuto a Roma ACC',
        text: `Sei un <b>controllore d'area</b>. Il tuo lavoro non è far atterrare gli aerei: è prendere in
          carico i voli che entrano nel tuo settore, tenerli separati fra loro e consegnarli all'ente
          successivo al livello e nel punto concordati.<br><br>
          Dieci lezioni, una decina di minuti l'una. Si lavora sul simulatore vero: qui però nessun errore
          chiude la partita, e io ti dico sempre cosa fare.`,
      },
      {
        freeze: true,
        title: 'Il tuo settore',
        text: `La linea continua più marcata è il confine del settore <b>NW ALTO</b> di Roma ACC: Toscana
          costiera, Arcipelago e Tirreno fino alla Corsica, da <b>FL305 in su</b>.<br><br>
          I puntini con il nome sono i <b>punti FRA</b> su cui volano gli aerei; quelli <b>cerchiati</b> sono
          i <b>COP</b>, i punti di coordinamento da cui i voli escono verso i settori vicini. Le linee sottili
          sono la costa e i confini degli altri settori.`,
        focus: () => ({ sector: true }),
      },
      {
        title: 'Muovi la vista',
        text: `La vista è tua: il traffico non si ferma, ma puoi guardare dove vuoi.<br>
          <b>Pizzica</b> o usa i tasti <b>+</b> e <b>−</b> in basso per lo zoom, trascina con <b>due dita</b>
          per spostare la mappa, e il <b>mirino</b> riporta tutto al centro del settore.`,
        goal: 'Ingrandisci la vista, poi premi il mirino per ricentrare',
        hint: 'I comandi dello zoom sono nella barra in basso, a destra del cursore “Vettore”.',
        focus: () => ({ dom: '.tool-zoom' }),
        done: (c) => {
          if (Math.abs(radarView.zoom - 1) > 0.02 || radarView.panX !== 0 || radarView.panY !== 0) c.mem.zoomed = true;
          return c.mem.zoomed && radarView.zoom === 1 && radarView.panX === 0 && radarView.panY === 0;
        },
      },
      {
        title: 'Le tracce',
        text: `Ogni aereo è un <b>punto</b> con dietro la <b>scia</b> delle posizioni precedenti, una ogni
          12 secondi: più i puntini sono distanziati, più il volo è veloce.<br><br>
          Accanto c'è il <b>tag</b> (l'etichetta) collegato da una linea guida. Questi voli sono
          <b class="c-yellow">gialli</b>: non sono tuoi, li sta controllando qualcun altro.`,
        goal: 'Passa il mouse sopra una traccia o sopra un tag',
        hint: 'Avvicina il cursore a uno dei puntini gialli: il tag diventa grigio e si apre con tutti i campi.',
        focus: (c) => {
          const ac = c.sim.aircraft.find((a) => a.control === 'other' && tagVisible(a));
          return ac ? { ac } : null;
        },
        done: (c) => !!c.api.hovered(),
      },
      {
        freeze: true,
        title: 'L\'orologio e il ritmo',
        text: `In alto a destra c'è il menu <b>Simulazione</b>: l'ora UTC, quanti voli hai in contatto, quanti
          te ne hanno appena passato e gli <b>errori di coordinamento</b> (al terzo la partita finisce — qui no).<br><br>
          Lì dentro puoi mettere in <b>pausa</b> e accelerare il tempo fino a <b>8x</b>: comodo quando il settore
          è tranquillo.`,
        goal: 'Apri il menu Simulazione',
        hint: 'È la prima riga della colonna di destra, sotto il nome del settore.',
        focus: () => ({ dom: '#sim-menu' }),
        done: () => $('sim-menu').open,
      },
    ],
  },

  // ---------------------------------------------------------------- 2
  {
    id: 'handon',
    title: 'Prendere i voli in carico',
    subtitle: 'Giallo, magenta, verde',
    learned: ['I tre colori del traffico e cosa significano',
      'Fare l\'hand-on con un clic sul tag',
      'Leggere il piano di volo e la rotta di un volo selezionato'],
    background: 7,
    steps: [
      {
        freeze: true,
        title: 'Tre colori, tre situazioni',
        text: `<b class="c-yellow">Giallo</b>: non è tuo. Lo vedi perché ti passa vicino, ma lo controlla
          un altro settore.<br>
          <b class="c-magenta">Magenta</b>: l'ente precedente te lo ha <b>passato</b> e aspetta che tu lo
          prenda in carico.<br>
          <b class="c-green">Verde</b>: è <b>in contatto</b> con te. Solo su questi puoi dare istruzioni.`,
      },
      {
        title: 'Un volo per te',
        text: `Eccone uno in arrivo da un settore vicino. Appena diventa <b>magenta</b> è tuo da prendere:
          un <b>clic sul tag</b> fa l'<b>hand-on</b> e il volo passa in verde.`,
        goal: 'Aspetta che il volo diventi magenta e clicca il suo tag',
        hint: 'Il clic va sul rettangolo dell\'etichetta, non sul puntino della traccia: cliccando la traccia il tag ruota soltanto.',
        arm: (c) => {
          c.mem.ac = spawnFlight(c.sim, { offerIn: 12, want: levelFlight(600) });
          if (c.mem.ac) c.api.centreOn(c.mem.ac);
          return !!c.mem.ac;
        },
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => c.mem.ac?.control === 'assumed',
        success: 'Hand-on fatto: il volo è in contatto con te.',
      },
      {
        freeze: true,
        title: 'Adesso è tuo',
        text: (c) => `<b>${c.mem.ac?.callsign ?? 'Il volo'}</b> è verde: sei tu il responsabile della sua
          separazione finché non lo passerai all'ente successivo.<br><br>
          Il tag è anche <b>selezionato</b>: la traccia è cerchiata e sul radar vedi la sua <b>rotta</b>
          in celeste, con i punti che toccherà. Un clic sulla mappa vuota (o <b>Esc</b>) deseleziona.`,
        focus: (c) => (alive(c.sim, c.mem.ac) ? { ac: c.mem.ac } : null),
      },
      {
        title: 'Guarda la rotta',
        text: `Se il volo non è selezionato, cliccane di nuovo il tag: la rotta celeste serve per capire
          <b>da dove arriva e dove andrà</b>, cioè se ti crea problemi con qualcun altro.`,
        goal: 'Tieni selezionato il volo e guarda dove esce dal settore',
        hint: 'Clicca il tag verde: la rotta compare e il punto d\'uscita è quello cerchiato sul confine.',
        done: (c) => c.api.selected() === c.mem.ac,
      },
    ],
  },

  // ---------------------------------------------------------------- 3
  {
    id: 'label',
    title: 'La label integrata',
    subtitle: 'Tutto quello che l\'etichetta ti dice',
    learned: ['I campi della label da livellato e in salita o discesa',
      'Ruotare e spostare i tag per non farli sovrapporre',
      'Accendere il vettore velocità'],
    background: 7,
    steps: [
      {
        freeze: true,
        title: 'Le righe del tag',
        text: `Su un volo <b>livellato</b> il tag ha tre righe:<br>
          <b>1</b> nominativo · <b>2</b> livello attuale e prossimo punto di rotta (EFX) ·
          <b>3</b> velocità e scia.<br><br>
          Col <b>mouse sopra</b> compaiono anche la prua letta da bordo (<b>HDG</b>), il livello autorizzato
          (<b>ALV</b>) e il settore successivo (<b>NXT</b>). I dati in <b>ciano</b> arrivano dall'aereo.`,
        arm: (c) => {
          c.mem.ac = spawnFlight(c.sim, { offerIn: 2, assume: true, want: levelFlight(700) });
          if (c.mem.ac) c.api.centreOn(c.mem.ac);
          return !!c.mem.ac;
        },
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
      },
      {
        title: 'Aprilo col mouse',
        text: `Il tag compatto serve a non riempire il radar; quando ti serve tutto, basta andarci sopra.`,
        goal: (c) => `Tieni il mouse sul tag di ${c.mem.ac?.callsign ?? 'quel volo'} e leggi HDG, ALV e NXT`,
        hint: 'Il riquadro diventa grigio e i campi vuoti si leggono in minuscolo (efx, nxt, xfl, coo).',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => {
          if (c.api.hovered() === c.mem.ac) c.mem.hover = (c.mem.hover ?? 0) + 1;
          return (c.mem.hover ?? 0) > 40;
        },
      },
      {
        title: 'Sposta il tag',
        text: `I tag possono coprirsi a vicenda: qui non si sistemano da soli, come su una console vera.<br>
          Un <b>clic sulla traccia</b> ruota il tag di 45° in senso orario; puoi anche <b>trascinarlo</b> dove
          vuoi. Nel menu <b>Tag</b> in basso, <b>Deconflitta</b> li sistema tutti una volta sola.`,
        goal: 'Clicca sulla traccia (il puntino) per ruotare il suo tag',
        hint: 'Il bersaglio è il puntino della posizione, non l\'etichetta.',
        arm: (c) => { c.mem.angle = c.mem.ac?.tagAngle ?? null; return true; },
        focus: (c) => (alive(c.sim, c.mem.ac) ? { ac: c.mem.ac } : null),
        done: (c) => alive(c.sim, c.mem.ac) && c.mem.ac.tagAngle !== c.mem.angle,
      },
      {
        title: 'Il vettore velocità',
        text: `Un <b>doppio clic sul nominativo</b> accende lo "spadino": la linea che mostra dove sarà il volo
          fra i minuti scelti con il cursore <b>Vettore</b> in basso. È il modo più rapido per vedere se due
          traiettorie si incrociano.`,
        goal: 'Doppio clic sul nominativo per accendere il vettore',
        hint: 'Due clic rapidi proprio sul nominativo scritto nella prima riga del tag.',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => !!c.mem.ac?.showVector,
        success: 'Vettore acceso: si spegne con un altro doppio clic.',
      },
      {
        freeze: true,
        title: 'In salita o in discesa',
        text: `Quando un volo <b>evolve</b> il tag cambia: accanto al livello compare una <b>freccia ↑↓</b> e
          il <b>rateo</b> (VR, in centinaia di piedi al minuto: 15 = 1500 ft/min), e sotto il livello
          autorizzato (<b>ALV</b>).<br><br>
          Se il pilota ha impostato a bordo un livello diverso da quello che gli hai dato, compare anche
          <b>SLB</b> e tutti e due diventano <b>arancioni</b>: è il tuo controllo che l'istruzione sia stata
          capita.`,
      },
    ],
  },

  // ---------------------------------------------------------------- 4
  {
    id: 'clearances',
    title: 'Dare le istruzioni',
    subtitle: 'Livello, prua, diretto, velocità',
    learned: ['Autorizzare un livello dal campo ALV del tag',
      'Vettorare con HDG e far riprendere la navigazione propria',
      'Dare un diretto con EFX e assegnare una velocità'],
    background: 6,
    steps: [
      {
        freeze: true,
        title: 'Si comanda dal tag',
        text: `Su un volo in contatto i campi <b>ALV</b> (livello autorizzato), <b>HDG</b> (prua),
          <b>EFX</b> (prossimo punto), <b>SPD</b> (velocità) e <b>VR</b> (rateo) sono <b>cliccabili</b>: si apre
          l'elenco dei valori e scegliendone uno l'istruzione parte subito. Il pilota collaziona e la esegue.<br><br>
          Attenzione: su un volo livellato <b>ALV</b> e <b>HDG</b> compaiono solo <b>col mouse sul tag</b>.
          Ci si arriva così: mouse sul tag, poi clic sul campo.`,
        arm: (c) => {
          c.mem.ac = spawnFlight(c.sim, { offerIn: 2, assume: true, want: levelFlight(900) });
          if (!c.mem.ac) return false;
          c.api.centreOn(c.mem.ac);
          c.mem.fl0 = c.mem.ac.clearedFL;
          return true;
        },
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
      },
      {
        title: 'Un nuovo livello',
        text: (c) => `${c.mem.ac?.callsign ?? 'Il volo'} è livellato a ${fl(c.mem.fl0 ?? 350)}. Autorizzalo a
          un livello diverso: tieni il <b>mouse sul tag</b> e clicca <b>ALV</b>, il livello autorizzato, al
          centro della terza riga.<br><br>
          Ricordati della <b>semicircolare italiana</b>: rotta 090°–269° livelli <b>dispari</b>,
          270°–089° livelli <b>pari</b>.`,
        goal: 'Clicca ALV e autorizza un altro livello',
        hint: 'ALV è il numero di tre cifre al centro della terza riga del tag, accanto alla velocità: compare quando il mouse è sul tag. L\'elenco va di 10 in 10.',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => alive(c.sim, c.mem.ac) && c.mem.ac.clearedFL !== c.mem.fl0,
        success: 'Autorizzato: guarda la freccia e il rateo (VR) comparire nel tag.',
      },
      {
        title: 'Vettoramento',
        text: `Per separare due voli spesso basta una <b>prua</b>. Clicca <b>HDG</b> nel tag (compare passandoci
          sopra) e scegli una prua: il volo lascia la rotta e la mantiene finché non gli dici altro. La prua
          assegnata resta sempre scritta nel tag.`,
        goal: 'Assegna una prua con HDG',
        hint: 'Passa il mouse sul tag: HDG compare a destra, sulla riga del livello. L\'elenco va di 5 in 5.',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => c.mem.ac?.mode === 'heading',
      },
      {
        title: 'Torna in rotta',
        text: `Un volo vettorato <b>non torna da solo</b>: finché non glielo dici prosegue dritto, e rischi di
          portarlo fuori dal settore lontano dal suo punto d'uscita.<br>
          Per rimetterlo in rotta clicca <b>EFX</b> e scegli un punto: è il <b>diretto a</b>.`,
        goal: 'Dai un diretto cliccando EFX e scegliendo un punto della rotta',
        hint: 'EFX è accanto al livello: in cima all\'elenco ci sono i punti della sua rotta, poi gli altri per distanza.',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => c.mem.ac?.mode === 'route',
        success: 'Rimesso in rotta.',
      },
      {
        title: 'La velocità',
        text: `<b>SPD</b> assegna la velocità: in nodi sotto FL250, in <b>Mach</b> da FL250 in su (è così che
          si parla in crociera). Serve soprattutto per <b>spaziare</b> due voli sulla stessa rotta senza
          vettorarli.`,
        goal: 'Assegna una velocità (o un Mach) con SPD',
        hint: 'SPD è sulla terza riga del tag, a sinistra.',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => c.mem.ac?.speedMode === 'assigned',
        success: 'Velocità assegnata.',
      },
    ],
  },

  // ---------------------------------------------------------------- 5
  {
    id: 'handoff',
    title: 'Passare i voli',
    subtitle: 'L\'hand-off e il livello d\'uscita',
    learned: ['Uscita laterale: punto di coordinamento e livello richiesto',
      'Uscita verticale: portare il volo al livello di trasferimento e passarlo mentre ci arriva',
      'Hand-off con la barra spaziatrice; cosa conta come errore'],
    background: 6,
    steps: [
      {
        freeze: true,
        title: 'Ogni volo ha un\'uscita concordata',
        text: `Prendere in carico un volo significa impegnarsi a <b>consegnarlo</b> come è stato coordinato:
          in un <b>punto</b> preciso e a un <b>livello</b> preciso.<br><br>
          Col mouse sul tag, <b>NXT</b> è l'ente successivo e <b>COO</b> il livello d'uscita dal settore.
          Se il livello che hai autorizzato non rispetta il COO, il COO diventa <b>arancione</b>.`,
        arm: (c) => {
          c.mem.ac = spawnFlight(c.sim, { offerIn: 2, assume: true, want: levelFlight(420) });
          if (!c.mem.ac) return false;
          c.api.centreOn(c.mem.ac);
          return true;
        },
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
      },
      {
        title: 'Uscita laterale: il COP',
        text: (c) => {
          const ac = c.mem.ac;
          return `${ac?.callsign ?? 'Questo volo'} resta livellato: uscirà <b>lateralmente</b> dal suo punto di
            coordinamento <b>${ac?.exitFix ?? '—'}</b> (cerchiato sul radar) a <b>${fl(ac?.requestedExitFL ?? 350)}</b>,
            verso <b>${ac?.nextUnit ?? 'il settore vicino'}</b>.<br><br>
            Lo porto io vicino al confine: poi lo passerai tu.`;
        },
        focus: (c) => (c.mem.ac?.exitFix ? { fix: c.mem.ac.exitFix } : null),
        arm: (c) => {
          const ac = c.mem.ac;
          if (!ours(c.sim, ac)) return true;
          warp(c.sim, 900, () => !ours(c.sim, ac) || c.sim._timeToExit(ac) < 150);
          c.api.centreOn(ac);
          return true;
        },
      },
      {
        title: 'Passalo',
        text: `Seleziona il volo con un clic sul tag e premi la <b>barra spaziatrice</b>: è l'hand-off.<br>
          Si fa <b>poco prima</b> del confine, non dopo: un volo che esce dal settore ancora in contatto con te
          è un <b>errore</b>, come passarlo a un livello diverso da quello richiesto.`,
        goal: 'Seleziona il volo e premi la barra spaziatrice',
        hint: 'Prima un clic sul tag (la traccia si cerchia), poi spazio.',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => c.mem.ac?.control === 'transferred',
        success: 'Hand-off corretto: il volo è dell\'ente successivo.',
      },
      {
        freeze: true,
        title: 'Uscita verticale',
        text: `L'altro caso è quello dei voli che <b>attraversano</b> il tuo strato: scendono verso un
          aeroporto o salgono in crociera. Non escono da un punto: escono da un <b>livello</b>.<br><br>
          Chi <b>scende</b> sotto il tuo limite inferiore va autorizzato al <b>livello di trasferimento</b>
          (il livello valido più vicino al limite, qui <b>${fl(310)}</b>) e passato al settore inferiore
          <b>mentre ci sta arrivando</b>. Nel tag lo leggi come <b>X310 ↓OVM</b>.`,
        arm: (c) => {
          c.mem.dsc = spawnFlight(c.sim, { offerIn: 20, want: descending });
          if (c.mem.dsc) c.api.centreOn(c.mem.dsc);
          return !!c.mem.dsc;
        },
        focus: (c) => (alive(c.sim, c.mem.dsc) ? { tag: c.mem.dsc } : null),
      },
      {
        title: 'Prendilo e fallo scendere',
        text: (c) => {
          const ac = c.mem.dsc;
          return `<b>${ac?.callsign ?? 'Questo volo'}</b> è in discesa verso ${ac?.destination ?? 'la sua destinazione'}:
            deve lasciarti a <b>${fl(ac?.requestedExitFL ?? 310)}</b> per <b>${ac?.nextUnit ?? 'il settore inferiore'}</b>.<br>
            Fai l'hand-on e autorizzalo a quel livello: mouse sul tag, poi clic su <b>ALV</b>.`;
        },
        goal: (c) => `Hand-on e autorizzazione a ${fl(c.mem.dsc?.requestedExitFL ?? 310)}`,
        hint: 'Prima un clic sul tag magenta; poi, col mouse sul tag, un clic su ALV e scegli il valore d\'uscita.',
        focus: (c) => (alive(c.sim, c.mem.dsc) ? { tag: c.mem.dsc } : null),
        done: (c) => c.mem.dsc?.control === 'assumed' && c.mem.dsc.clearedFL === c.mem.dsc.requestedExitFL,
      },
      {
        title: 'Passalo mentre scende',
        text: `Quando mancano meno di <b>2000 ft</b> al livello di trasferimento il <b>livello nel tag diventa
          arancione</b>: è il momento dell'hand-off. Non aspettare che si livelli, e non aspettare il confine:
          qui si passa <b>in verticale</b>.`,
        goal: 'Aspetta il livello arancione e premi la barra spaziatrice',
        hint: 'Se non lo vedi ancora, accelera il tempo a 4x dal menu Simulazione.',
        focus: (c) => (alive(c.sim, c.mem.dsc) ? { tag: c.mem.dsc } : null),
        done: (c) => c.mem.dsc?.control === 'transferred',
        success: 'Trasferimento verticale corretto.',
      },
    ],
  },

  // ---------------------------------------------------------------- 6
  {
    id: 'separation',
    title: 'Separazione e conflitti',
    subtitle: '5 miglia o 1000 piedi',
    learned: ['La separazione minima e come si perde',
      'Gli strumenti CPA e R&B',
      'Risolvere un conflitto con il livello o con una prua'],
    background: 6,
    steps: [
      {
        freeze: true,
        title: 'La regola',
        text: `Due voli sono separati se hanno almeno <b>5 NM</b> di distanza <b>oppure</b> almeno
          <b>1000 ft</b> di differenza di quota. Se perdi tutte e due le cose insieme, è una
          <b>perdita di separazione</b>: nelle sessioni normali la partita finisce lì.<br><br>
          Il mestiere è tutto qui: vedere l'incrocio <b>prima</b> che diventi un problema.`,
        arm: (c) => {
          c.mem.ac = spawnFlight(c.sim, { offerIn: 2, assume: true, want: levelFlight(1100) });
          if (!c.mem.ac) return false;
          // altri due voli nostri: un settore con un aereo solo non è un settore, e più traiettorie
          // danno al conflitto che arriverà più modi per innestarsi
          for (let i = 0; i < 2; i++) {
            spawnFlight(c.sim, { offerIn: 2 + i * 15, assume: true, want: levelFlight(900) });
          }
          c.api.centreOn(c.mem.ac);
          return true;
        },
      },
      {
        title: 'Misura: lo strumento CPA',
        text: `<b>CPA</b> (tasto <b>C</b> o pulsante in basso) risponde alla domanda "questi due si toccano?":
          clicca su due aerei e ti dice la <b>distanza minima</b>, fra <b>quanti minuti</b> e con che
          <b>separazione verticale</b> — per esempio <b>14 NM 13 MIN 6000 FT</b>, in rosso se sotto i minimi.<br><br>
          Accanto c'è <b>R&amp;B</b> (tasto <b>R</b>): due clic qualsiasi, e leggi distanza e rilevamento.`,
        goal: 'Accendi CPA e clicca due aerei',
        hint: 'Premi C, poi un clic su una traccia e un clic su un\'altra. Un clic sull\'etichetta della misura la cancella.',
        focus: () => ({ dom: '#tool-cpa' }),
        done: (c) => c.api.cpas().length > 0,
        success: 'Misura fatta: resta sul radar finché non la cancelli.',
      },
      {
        title: 'Arriva traffico in conflitto',
        text: `Il settore vicino ti sta passando un volo che incrocia uno dei tuoi. Hai qualche minuto per
          accorgertene: prendilo in carico e guarda dove va.`,
        goal: 'Prendi in carico il traffico magenta',
        hint: 'Clic sul tag magenta. Se non lo vedi, è appena fuori dal confine.',
        arm: (c) => {
          const sim = c.sim;
          // il conflitto lo costruisce la simulazione stessa (stesso meccanismo delle sessioni normali):
          // fra i candidati si tiene quello che ci verrebbe offerto prima, poi si va avanti veloce fino
          // a poco dopo l'offerta. Il ritardo di comparsa è parte della geometria del conflitto: non si tocca.
          for (let round = 0; round < 7; round++) {
            // servono alcuni voli nostri che restino abbastanza a lungo: sono i possibili bersagli del
            // conflitto, e con uno solo spesso non c'è nessun flusso che gli passa addosso
            const targets = () => sim.aircraft.filter((a) => OURS.has(a.control) && a.requestedExitFL !== null
              && a.mode === 'route' && sim._timeToExit(a) > 420).length;
            for (let g = 0; g < 4 && targets() < 3; g++) {
              if (!spawnFlight(sim, { offerIn: 2 + g * 20, assume: g === 0, want: levelFlight(900) })) break;
            }
            let best = null;
            for (let i = 0; i < 40; i++) {
              const p = sim._planConflict();
              if (p && (!best || p.offerAt < best.offerAt)) best = p;
            }
            if (best) {
              sim.pendingConflicts.push(best);
              warp(sim, Math.max(0, best.offerAt - sim.simTime) + 120,
                () => sim.aircraft.some((a) => a.plannedConflict && a.control !== 'inbound'));
              const intruder = sim.aircraft.find((a) => a.plannedConflict);
              if (intruder) {
                c.mem.intruder = intruder;
                c.mem.targetId = intruder.plannedConflict.targetId;
                c.api.centreOn(intruder);
                return true;
              }
            }
            sim.pendingConflicts = [];
            warp(sim, 60);
          }
          return false;
        },
        focus: (c) => (alive(c.sim, c.mem.intruder) ? { tag: c.mem.intruder } : null),
        done: (c) => c.mem.intruder?.control === 'assumed',
      },
      {
        title: 'Risolvilo',
        text: (c) => {
          const a = c.mem.intruder;
          const b = c.sim.aircraft.find((x) => x.id === c.mem.targetId);
          return `<b>${a?.callsign ?? '—'}</b> e <b>${b?.callsign ?? '—'}</b> perderanno la separazione.
            Scegli tu come: un <b>livello</b> diverso a uno dei due (il modo più solido) oppure una
            <b>prua</b> che lo porti dietro all'altro.<br><br>
            Controlla con il <b>CPA</b> che la soluzione funzioni davvero: il conflitto è risolto quando non è
            più previsto entro cinque minuti.`;
        },
        goal: 'Separa i due voli',
        hint: 'Un clic su ALV e 10 livelli sopra o sotto risolve quasi sempre; con una prua, girane uno di 30°-40° verso la coda dell\'altro.',
        arm: (c) => {
          const sim = c.sim;
          c.mem.intruder = sim.aircraft.find((x) => x.plannedConflict) ?? c.mem.intruder;
          c.mem.targetId = c.mem.intruder?.plannedConflict?.targetId ?? c.mem.targetId;
          const b = sim.aircraft.find((x) => x.id === c.mem.targetId);
          c.mem.seq0 = (c.mem.intruder?.instrSeq ?? 0) + (b?.instrSeq ?? 0);
          return true;
        },
        focus: (c) => (alive(c.sim, c.mem.intruder) ? { ac: c.mem.intruder } : null),
        // risolto: nessuna perdita di separazione prevista entro cinque minuti, dopo averla vista o dopo
        // aver dato un'istruzione a uno dei due
        done: (c) => {
          const sim = c.sim;
          const a = c.mem.intruder;
          const b = sim.aircraft.find((x) => x.id === c.mem.targetId);
          if (!ours(sim, a) || !b) return true;
          const pair = predictConflicts([a, b]).length > 0;
          if (pair) c.mem.sawConflict = true;
          const acted = a.instrSeq + b.instrSeq !== c.mem.seq0;
          return !pair && (c.mem.sawConflict || acted);
        },
        success: 'Conflitto risolto.',
      },
      {
        freeze: true,
        title: 'Quando è tardi: STCA',
        text: `Se la separazione sta per perdersi <b>entro un minuto</b> scatta l'<b>STCA</b>: una linea rossa
          lampeggiante fra le due tracce, con i secondi che mancano. A quel punto si interviene subito, con la
          manovra più rapida.<br><br>
          Meglio non arrivarci: l'STCA è una rete di sicurezza, non uno strumento di lavoro.`,
      },
    ],
  },

  // ---------------------------------------------------------------- 7
  {
    id: 'areas',
    title: 'Zone attive',
    subtitle: 'Spazi riservati da evitare',
    learned: ['Leggere il piano delle zone e i loro orari',
      'L\'asterisco rosso e l\'allarme di prossimità',
      'Vettorare o cambiare livello per evitare una zona attiva'],
    background: 6,
    steps: [
      {
        freeze: true,
        title: 'P, R, D, TSA, TRA',
        text: `Attorno al settore ci sono spazi riservati: zone <b>proibite</b>, <b>regolamentate</b>,
          <b>pericolose</b> e aree per attività militari. Si <b>attivano e disattivano</b> durante il turno,
          con orari che trovi nel menu <b>Zone attive</b> a destra.<br><br>
          Una zona <b>attiva</b> è grigia sul radar e non si attraversa: o la aggiri, o passi sopra o sotto.`,
        focus: () => ({ dom: '#areas-menu' }),
      },
      {
        title: 'Un volo ci sta andando dentro',
        text: `Quando rotta e livello autorizzato portano un tuo volo dentro una zona attiva, la zona diventa
          <b>rosso tenue</b> e accanto al nominativo compare un <b>asterisco rosso</b>: cliccandolo vedi dove e
          quando ci entrerebbe.`,
        goal: 'Prendi in carico il volo e trova l\'asterisco rosso nel tag',
        hint: 'Clic sul tag magenta per l\'hand-on; l\'asterisco è subito dopo il nominativo.',
        arm: (c) => {
          const sim = c.sim;
          const rel = airspace.areas.filter((a) => sim.relevantAreas.has(a.id));
          if (!rel.length) return false;
          const clock = sim.clockS;
          for (const a of rel) sim.areaSchedule.set(a.id, [[clock - 600, clock + 7200]]);
          for (let i = 0; i < 40; i++) {
            const ac = spawnFlight(sim, { offerIn: 25, tries: 60 });
            if (!ac) continue;
            const hit = sim._predictArea(ac, rel, { horizonS: 1500 });
            if (hit && hit.t > 300) {
              // resta attiva solo la zona che riguarda questo volo: il resto del cielo è libero
              for (const a of rel) if (a !== hit.area) sim.areaSchedule.set(a.id, []);
              c.mem.ac = ac;
              c.mem.area = hit.area;
              c.api.centreOn(ac);
              return true;
            }
            sim.aircraft = sim.aircraft.filter((x) => x !== ac);
          }
          for (const a of rel) sim.areaSchedule.set(a.id, []);
          return false;
        },
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => c.mem.ac?.control === 'assumed',
      },
      {
        title: 'Tienilo fuori',
        text: (c) => `<b>${c.mem.ac?.callsign ?? 'Il volo'}</b> entrerebbe in <b>${c.mem.area?.name ?? 'la zona'}</b>.
          Portalo fuori: una <b>prua</b> che la aggiri, un <b>diretto</b> a un punto oltre la zona, oppure un
          <b>livello</b> sopra o sotto la fascia della zona.<br><br>
          Entrarci è un <b>errore di coordinamento</b>, come un hand-off sbagliato.`,
        goal: 'Fai sparire la previsione d\'ingresso nella zona',
        hint: 'Guarda la fascia di livelli della zona nel menu Zone attive: a volte bastano 10 livelli più in alto.',
        focus: (c) => (c.mem.area ? { area: c.mem.area } : null),
        done: (c) => ours(c.sim, c.mem.ac) && !c.mem.ac.areaConflict && !c.mem.ac.apw,
        success: 'Zona evitata.',
      },
    ],
  },

  // ---------------------------------------------------------------- 8
  {
    id: 'weather',
    title: 'Meteo e richieste dei piloti',
    subtitle: 'Quando sono loro a chiedere',
    learned: ['Leggere le celle temporalesche e la loro sommità',
      'Autorizzare una deviazione per maltempo e il rientro in rotta',
      'Rispondere a una richiesta di livello'],
    background: 6,
    steps: [
      {
        freeze: true,
        title: 'I temporali sul radar',
        text: `Le celle convettive si vedono come macchie: <b>azzurre</b>, <b>ambra</b> o <b>viola</b> secondo
          l'intensità. Ognuna ha una <b>sommità</b>: chi vola sopra passa tranquillo, gli altri le vogliono
          stare lontani, 6-14 NM secondo quanto sono brutte.<br><br>
          I piloti <b>chiedono</b>, non decidono: se non rispondi in tempo deviano da soli e te lo comunicano.`,
        arm: (c) => {
          const sim = c.sim;
          c.mem.ac = spawnFlight(sim, { offerIn: 2, assume: true, want: levelFlight(900) });
          if (!c.mem.ac) return false;
          const ac = c.mem.ac;
          const p = aheadOnRoute(ac, 80);
          c.mem.cell = addCell(sim.weather, p.x, p.y, { topFL: ac.flightLevel + 40, intensity: 3, grown: 1 });
          c.api.centreOn(ac);
          return true;
        },
        focus: (c) => (c.mem.cell ? { point: c.mem.cell, r: 30 } : null),
      },
      {
        title: 'La richiesta',
        text: (c) => `<b>${c.mem.ac?.callsign ?? 'Il volo'}</b> ha una cella sulla rotta e sta per chiederti
          una deviazione. La sua chiamata compare fra i <b>messaggi dei piloti</b>, in alto a destra, e nel tag
          appare <b>REQ WX</b>.<br><br>
          Autorizzala dandogli la <b>prua che ha chiesto</b> (o un'altra che lo tenga fuori dalla cella):
          clicca <b>HDG</b> nel tag.`,
        goal: 'Aspetta la richiesta e autorizza la deviazione',
        hint: 'La prua chiesta è scritta nel messaggio del pilota: dagliela con HDG, o un diretto che aggiri la cella.',
        arm: (c) => {
          const sim = c.sim;
          // se il volo del passo precedente non c'è più (o non era mai comparso) se ne prepara un altro
          if (!ours(sim, c.mem.ac)) {
            c.mem.ac = spawnFlight(sim, { offerIn: 2, assume: true, want: levelFlight(600) });
            if (!c.mem.ac) return false;
            const p0 = aheadOnRoute(c.mem.ac, 70);
            c.mem.cell = addCell(sim.weather, p0.x, p0.y,
              { topFL: c.mem.ac.flightLevel + 40, intensity: 3, grown: 1 });
          }
          const ac = c.mem.ac;
          // si va avanti veloce fino alla chiamata del pilota; se la cella si è spostata, se ne mette
          // un'altra più vicina sulla rotta
          for (let i = 0; i < 4 && !ac.request; i++) {
            warp(sim, 240, () => !!ac.request);
            if (ac.request) break;
            const p = aheadOnRoute(ac, 55);
            c.mem.cell = addCell(sim.weather, p.x, p.y, { topFL: ac.flightLevel + 40, intensity: 3, grown: 1 });
          }
          c.api.centreOn(ac);
          return !!ac.request;
        },
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => {
          const ac = c.mem.ac;
          if (!ours(c.sim, ac)) return true;
          if (ac.request?.kind === 'deviation') {
            c.mem.asked = true;
            return ac.request.phase !== 'pending';
          }
          return !!c.mem.asked;
        },
        success: 'Deviazione autorizzata.',
      },
      {
        freeze: true,
        title: 'Il rientro',
        text: `Quando la cella è superata il pilota chiede di <b>rientrare in rotta</b> (<b>REQ DIRECT</b>):
          rispondi con un <b>diretto</b> dal campo EFX. Se non rispondi, dopo qualche minuto rientra da solo.<br><br>
          Un volo che ha deviato per maltempo può uscire anche lontano dal suo COP: il coordinamento si fa a
          voce e non conta come errore.`,
      },
      {
        title: 'Richiesta di livello',
        text: `L'altra richiesta tipica è il <b>cambio di livello di crociera</b> (<b>REQ LEVEL</b>): più alto
          per consumare meno, più basso per uscire da una zona di <b>turbolenza</b> riportata da un altro volo.<br><br>
          Qualunque livello tu dia chiude la richiesta. Puoi anche negarlo: basta non rispondere, e dopo un po'
          il pilota mantiene.`,
        goal: 'Aspetta la richiesta di livello e rispondi con ALV (mouse sul tag, poi clic sul valore)',
        hint: 'Controlla prima che il livello che dai non crei un conflitto con un altro volo.',
        arm: (c) => {
          const sim = c.sim;
          const asking = () => sim.aircraft.find((a) => a.request?.kind === 'level');
          for (let i = 0; i < 3 && !asking(); i++) {
            c.mem.lv = spawnFlight(sim, { offerIn: 2, assume: true, want: levelFlight(1200) });
            sim._levelAt = sim.simTime;
            warp(sim, 300, () => !!asking());
          }
          c.mem.asking = asking();
          if (c.mem.asking) c.api.centreOn(c.mem.asking);
          return !!c.mem.asking;
        },
        focus: (c) => (alive(c.sim, c.mem.asking) ? { tag: c.mem.asking } : null),
        done: (c) => {
          const asking = c.sim.aircraft.find((a) => a.request?.kind === 'level');
          if (asking) {
            c.mem.sawLevelReq = true;
            c.mem.asking = asking;
            return false;
          }
          return !!c.mem.sawLevelReq;
        },
        success: 'Richiesta chiusa.',
      },
    ],
  },

  // ---------------------------------------------------------------- 9
  {
    id: 'emergency',
    title: 'Emergenze',
    subtitle: 'MAYDAY e PAN PAN',
    learned: ['Riconoscere urgenza e pericolo e dare priorità',
      'Autorizzare la discesa e il dirottamento',
      'Che cosa cambia nel coordinamento con l\'ente successivo'],
    background: 6,
    steps: [
      {
        freeze: true,
        title: 'Due livelli di gravità',
        text: `<b>PAN PAN</b> è un'<b>urgenza</b>: a bordo c'è un problema serio ma la sicurezza non è in
          pericolo immediato (un malore, un guasto a un sistema).<br>
          <b>MAYDAY</b> è un <b>pericolo</b>: avaria motore, fumo, depressurizzazione. Quel volo ha la
          <b>precedenza su tutto</b>, zone riservate comprese.<br><br>
          Il tuo lavoro: dargli quello che chiede il prima possibile, e <b>togliergli di mezzo</b> il resto
          del traffico.`,
        arm: (c) => {
          const sim = c.sim;
          c.mem.ac = spawnFlight(sim, { offerIn: 2, assume: true, want: levelFlight(1200) });
          if (!c.mem.ac) return false;
          c.api.centreOn(c.mem.ac);
          return true;
        },
      },
      {
        title: 'La chiamata',
        text: `Ascolta: la chiamata del pilota resta <b>in alto a destra</b> finché il volo è tuo, e nel tag
          compare la sigla dell'avaria. Leggila tutta: dice <b>cosa</b> è successo, <b>che livello</b> vuole e
          se vuole <b>dirottare</b> su un altro aeroporto.`,
        arm: (c) => {
          const sim = c.sim;
          const ac = c.mem.ac;
          if (!ours(sim, ac)) return false;
          warp(sim, 120);
          const type = EMERGENCY_TYPES.find((t) => t.id === 'engine') ?? null;
          c.mem.e = sim.declareEmergencyOn(ac, type);
          return !!c.mem.e;
        },
        focus: () => ({ dom: '#radio-msgs' }),
        done: (c) => c.api.selected() === c.mem.ac,
        goal: 'Seleziona il volo in emergenza',
        hint: 'Un clic sul suo tag, oppure un clic sul messaggio del pilota in alto a destra.',
      },
      {
        title: 'Dagli quello che chiede',
        text: (c) => `Autorizza subito la <b>discesa</b> al livello che ha chiesto
          (${fl(c.mem.e?.targetFL ?? 140)}): mouse sul tag, poi clic su <b>ALV</b>.<br><br>
          Non aspettare di aver sistemato gli altri voli: prima l'autorizzazione, poi il resto del traffico si
          sposta attorno a lui. Se non rispondi, un'avaria grave <b>scende lo stesso</b>, senza autorizzazione.`,
        goal: (c) => `Autorizza la discesa a ${fl(c.mem.e?.targetFL ?? 140)} o più in basso`,
        hint: 'ALV è il livello autorizzato, al centro della terza riga del tag; in discesa è già sempre visibile.',
        focus: (c) => (alive(c.sim, c.mem.ac) ? { tag: c.mem.ac } : null),
        done: (c) => c.mem.ac?.emergency?.phase === 'cleared' || c.mem.ac?.emergency?.phase === 'own',
        success: 'Discesa autorizzata.',
      },
      {
        freeze: true,
        title: 'Il trasferimento',
        text: `Un volo in emergenza si passa <b>a voce</b> all'ente successivo: il livello d'uscita e il punto
          non contano più, e un hand-off "sbagliato" <b>non è un errore</b>.<br><br>
          Caso a parte: l'<b>avaria radio</b> (7600). Il volo non ti sente più: mantiene livello e rotta per
          sette minuti, poi riprende il piano di volo. A te resta il compito di <b>svuotargli la strada</b>.`,
      },
    ],
  },

  // ---------------------------------------------------------------- 10
  {
    id: 'exam',
    title: 'Turno di prova',
    subtitle: 'Dieci minuti da solo',
    scripted: false,
    difficulty: 'facile',
    learned: ['Tenere il settore con traffico vero', 'Lavorare senza farsi guidare'],
    stars: (c) => {
      const h = c.sim?.stats.handedOff ?? 0;
      const m = c.tut.mistakes;
      return m === 0 && h >= 8 ? 3 : m <= 1 && h >= 5 ? 2 : 1;
    },
    steps: [
      {
        freeze: true,
        title: 'Adesso tocca a te',
        text: `Traffico vero, difficoltà bassa, nessun suggerimento: circa <b>5 voli in contatto</b> alla volta.<br><br>
          <b>Obiettivo</b>: dieci minuti di servizio con <b>8 hand-off corretti</b> e <b>nessun errore</b>.
          Qui gli errori non chiudono la partita, ma te li conto.<br><br>
          Promemoria: hand-on con un clic sul tag magenta, istruzioni cliccando i campi del tag, hand-off con
          la <b>barra spaziatrice</b>, <b>H</b> apre il riepilogo dei comandi.`,
      },
      {
        title: 'Turno in corso',
        text: `Buon lavoro. Il riepilogo resta qui sotto.`,
        exam: true,
        durationS: 600,
        targetHandoffs: 8,
        arm: (c) => {
          c.mem.t0 = c.sim.simTime;
          c.api.setSpeed(1);
          return true;
        },
        tasks: (c) => {
          const left = Math.max(0, 600 - (c.sim.simTime - (c.mem.t0 ?? 0)));
          const m = Math.floor(left / 60);
          const s = String(Math.floor(left % 60)).padStart(2, '0');
          return [
            { text: `Tempo rimasto ${m}:${s}`, done: left <= 0 },
            { text: `Hand-off corretti ${c.sim.stats.handedOff} / 8`, done: c.sim.stats.handedOff >= 8 },
            { text: `Errori ${c.tut.mistakes} / 0`, done: c.tut.mistakes === 0, bad: c.tut.mistakes > 0 },
          ];
        },
        done: (c) => c.sim.simTime - (c.mem.t0 ?? 0) >= 600,
      },
    ],
  },
];

// --- progressi ---------------------------------------------------------------

const PROGRESS_KEY = 'atc-tutorial-progress';

// done: lezioni completate · stars: stelle per lezione · sound: suoni sì/no
// current: la lezione lasciata a metà e il passo raggiunto, per riprendere da lì al prossimo avvio
export function loadProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}');
    const cur = raw.current;
    const lesson = cur && LESSONS.find((l) => l.id === cur.id);
    const current = lesson && Number.isInteger(cur.step) && cur.step > 0 && cur.step < lesson.steps.length
      ? { id: cur.id, step: cur.step, mistakes: cur.mistakes | 0, hintsUsed: cur.hintsUsed | 0, skipped: cur.skipped | 0 }
      : null;
    return { done: Array.isArray(raw.done) ? raw.done : [], stars: raw.stars ?? {}, sound: raw.sound !== false, current };
  } catch {
    return { done: [], stars: {}, sound: true, current: null };
  }
}

// la lezione lasciata a metà, se c'è: { index, step, of }
export function resumePoint(progress) {
  const cur = progress.current;
  if (!cur) return null;
  const index = LESSONS.findIndex((l) => l.id === cur.id);
  return index < 0 ? null : { index, step: cur.step, of: LESSONS[index].steps.length };
}

function saveProgress(p) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch { /* spazio non disponibile: i progressi restano solo in questa sessione */ }
}

// --- suoni -------------------------------------------------------------------

let audioCtx = null;

function tone(freqs, { gain = 0.05, dur = 0.09 } = {}) {
  try {
    audioCtx ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    freqs.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t0 = audioCtx.currentTime + i * dur;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    });
  } catch { /* senza audio il tutorial funziona lo stesso */ }
}

const SOUNDS = {
  step: [520],
  ok: [660, 990],
  lesson: [660, 880, 1320],
  oops: [240, 180],
};

// --- motore ------------------------------------------------------------------

const PULSE = (now) => 0.5 + 0.5 * Math.sin(now / 320);

export class Tutorial {
  // api: ponte verso app.js (stato dell'interfaccia e comandi che solo lui può dare)
  constructor(api) {
    this.api = api;
    this.progress = loadProgress();
    this.lessonIndex = -1;
    this.lesson = null;
    this.stepIndex = 0;
    this.step = null;
    this.mem = {};
    this.stepStart = 0;
    this.hintShown = false;
    this.celebrateUntil = 0;
    this.collapsed = false;
    this.mistakes = 0;
    this.hintsUsed = 0;
    this.skipped = 0;
    this._wire();
  }

  get active() {
    return this.lesson !== null;
  }

  get sim() {
    return this.api.sim();
  }

  // --- interfaccia del riquadro ---------------------------------------------

  _wire() {
    $('coach-next').addEventListener('click', () => this.next());
    $('coach-skip').addEventListener('click', () => this.skip());
    $('coach-quit').addEventListener('click', () => this.api.exitToList());
    $('coach-min').addEventListener('click', () => this.toggleCollapsed());
    $('coach-hint-btn').addEventListener('click', () => this.showHint(true));
    $('coach-sound').addEventListener('click', () => {
      this.progress.sound = !this.progress.sound;
      saveProgress(this.progress);
      this._syncSound();
      if (this.progress.sound) this.sound('step');
    });
    this._syncSound();
    window.addEventListener('keydown', (ev) => {
      if (!this.active) return;
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
      if (typing) return;
      if (ev.key === 'Enter' || ev.key === 'ArrowRight') {
        if (!$('coach-next').classList.contains('hidden')) {
          ev.preventDefault();
          this.next();
        }
      } else if (ev.key === 't' || ev.key === 'T') {
        this.toggleCollapsed();
      }
    });
  }

  _syncSound() {
    const b = $('coach-sound');
    b.setAttribute('aria-pressed', String(this.progress.sound));
    b.classList.toggle('off', !this.progress.sound);
    b.textContent = this.progress.sound ? '♪' : '♪̸';
  }

  sound(name) {
    if (this.progress.sound) tone(SOUNDS[name] ?? SOUNDS.step);
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    $('coach').classList.toggle('collapsed', this.collapsed);
    $('coach-min').textContent = this.collapsed ? '+' : '–';
  }

  // --- svolgimento ----------------------------------------------------------

  // resume: se la lezione era stata lasciata a metà, si riparte dal passo raggiunto
  start(lessonIndex, { resume = true } = {}) {
    this.lessonIndex = lessonIndex;
    this.lesson = LESSONS[lessonIndex];
    this.mem = {};
    this.mistakes = 0;
    this.hintsUsed = 0;
    this.skipped = 0;
    this.collapsed = false;
    $('coach').classList.remove('hidden', 'collapsed');
    $('coach-min').textContent = '–';
    $('lesson-done').classList.add('hidden');
    this._buildDots();
    const cur = this.progress.current;
    if (resume && cur && cur.id === this.lesson.id) this._resume(cur);
    else this._enter(0);
  }

  // Riprende una lezione dal passo salvato. I passi già fatti si ripercorrono in silenzio, come se
  // si premesse "Salta" su ciascuno: ognuno prepara la situazione per il successivo, e il passo
  // raggiunto trova il traffico e le zone come li aveva lasciati la volta prima.
  _resume(cur) {
    this._replaying = true;
    // un passo che non si riesce a preparare passa da solo al successivo: si prosegue da dove è arrivato
    let i = 0;
    while (this.active && i < cur.step) {
      this._enter(i);
      i = this.stepIndex + 1;
    }
    this._replaying = false;
    if (!this.active) return;
    this.mistakes = cur.mistakes;
    this.hintsUsed = cur.hintsUsed;
    this.skipped = cur.skipped;
    this._enter(cur.step);
    this.api.toast(`Riprendi da dove eri: passo ${cur.step + 1} di ${this.lesson.steps.length}`, 'info');
  }

  stop() {
    this.lesson = null;
    this.step = null;
    this._clearDomFocus();
    $('coach').classList.add('hidden');
    $('coach-warp').classList.add('hidden');
  }

  get ctx() {
    return { sim: this.sim, api: this.api, mem: this.mem, tut: this };
  }

  _buildDots() {
    const dots = $('coach-dots');
    dots.innerHTML = '';
    this.lesson.steps.forEach(() => {
      const d = document.createElement('span');
      d.className = 'coach-dot';
      dots.appendChild(d);
    });
  }

  _syncDots() {
    [...$('coach-dots').children].forEach((d, i) => {
      d.classList.toggle('done', i < this.stepIndex);
      d.classList.toggle('now', i === this.stepIndex);
    });
  }

  _enter(index) {
    if (index >= this.lesson.steps.length) {
      this.finishLesson();
      return;
    }
    const prev = this.step;
    if (prev?.leave) {
      try { prev.leave(this.ctx); } catch (err) { console.error('tutorial: leave', err); }
    }
    this.stepIndex = index;
    this.step = this.lesson.steps[index];
    this.stepStart = performance.now();
    this.hintShown = false;
    this.celebrateUntil = 0;
    this._taskKey = null;
    this._clearDomFocus();

    const step = this.step;
    // il passo prepara la situazione: pausa durante la preparazione, così l'avanti veloce non si vede
    const sim = this.sim;
    if (sim) sim.paused = true;
    let ok = true;
    if (step.arm) {
      $('coach-warp').classList.remove('hidden');
      try {
        ok = step.arm(this.ctx) !== false;
      } catch (err) {
        console.error('tutorial: arm', err);
        ok = false;
      }
      $('coach-warp').classList.add('hidden');
    }
    if (sim) sim.paused = !!step.freeze;
    this.api.syncPause();
    if (!ok) {
      if (!this._replaying) this.api.toast('Non sono riuscito a preparare questa situazione: passo al punto successivo', 'warn');
      this._enter(index + 1);
      return;
    }
    if (this._replaying) return;
    this._checkpoint();
    this.sound('step');
    this._render();
  }

  // il punto raggiunto resta salvato: chiudendo il gioco a metà lezione si riprende da qui
  _checkpoint() {
    this.progress.current = this.stepIndex > 0
      ? { id: this.lesson.id, step: this.stepIndex, mistakes: this.mistakes, hintsUsed: this.hintsUsed, skipped: this.skipped }
      : (this.progress.current?.id === this.lesson.id ? null : this.progress.current);
    saveProgress(this.progress);
  }

  _text(v) {
    return typeof v === 'function' ? v(this.ctx) : v;
  }

  _render() {
    const step = this.step;
    const n = this.lesson.steps.length;
    $('coach-lesson').textContent = `${this.lessonIndex + 1}. ${this.lesson.title}`;
    $('coach-step').textContent = `passo ${this.stepIndex + 1} di ${n}`;
    $('coach-title').textContent = this._text(step.title) ?? '';
    $('coach-text').innerHTML = this._text(step.text) ?? '';
    this._syncDots();

    const goal = this._text(step.goal);
    $('coach-goal').classList.toggle('hidden', !goal);
    $('coach-goal-text').innerHTML = goal ?? '';
    $('coach-goal').classList.remove('done');
    $('coach-hint').classList.add('hidden');
    $('coach-hint-btn').classList.toggle('hidden', !step.hint);
    $('coach-tasks').classList.toggle('hidden', !step.tasks);

    const manual = !step.done;
    $('coach-next').classList.toggle('hidden', !manual);
    $('coach-skip').classList.toggle('hidden', manual);
    $('coach-next').textContent = this.stepIndex === n - 1 ? 'Finisci ▸' : 'Avanti ▸';
  }

  showHint(byUser = false) {
    if (!this.step?.hint || this.hintShown) return;
    this.hintShown = true;
    if (byUser) this.hintsUsed++;
    const el = $('coach-hint');
    el.innerHTML = `<b>Suggerimento.</b> ${this._text(this.step.hint)}`;
    el.classList.remove('hidden');
    $('coach-hint-btn').classList.add('hidden');
  }

  next() {
    if (!this.active) return;
    this._enter(this.stepIndex + 1);
  }

  skip() {
    if (!this.active) return;
    this.skipped++;
    this.api.toast('Passo saltato', 'info');
    this._enter(this.stepIndex + 1);
  }

  _complete() {
    if (this.celebrateUntil) return;
    this.sound('ok');
    this.celebrateUntil = performance.now() + 900;
    $('coach-goal').classList.add('done');
    const s = this._text(this.step.success);
    if (s) this.api.toast(`✓ ${s}`, 'ok');
  }

  // Chiamato a ogni fotogramma dal ciclo principale.
  tick(now) {
    if (!this.active || !this.step) return;
    const step = this.step;
    this._topUpBackground(now);

    if (step.tasks) {
      const tasks = step.tasks(this.ctx) ?? [];
      const ul = $('coach-tasks');
      const key = tasks.map((t) => `${t.text}${t.done}${t.bad}`).join('|');
      if (key !== this._taskKey) {
        this._taskKey = key;
        ul.innerHTML = '';
        for (const t of tasks) {
          const li = document.createElement('li');
          li.className = t.done ? 'done' : t.bad ? 'bad' : '';
          li.textContent = t.text;
          ul.appendChild(li);
        }
      }
    }

    if (this.celebrateUntil) {
      if (now >= this.celebrateUntil) {
        this.celebrateUntil = 0;
        this._enter(this.stepIndex + 1);
      }
      return;
    }

    if (step.done) {
      let ok = false;
      try {
        ok = !!step.done(this.ctx);
      } catch (err) {
        console.error('tutorial: done', err);
      }
      if (ok) {
        this._complete();
        return;
      }
      const elapsed = (now - this.stepStart) / 1000;
      if (step.hint && !this.hintShown && elapsed > (step.hintAfter ?? 30)) this.showHint(false);
    }
  }

  // Il traffico di contorno non viene rigenerato (il traffico lo decide la lezione): ogni tanto se ne
  // rimette uno, così il radar attorno al settore non si svuota durante una lezione lunga.
  _topUpBackground(now) {
    const sim = this.sim;
    const want = this.lesson?.background ?? 0;
    if (!want || !sim || sim.paused || !sim.scripted) return;
    if (now < (this._bgAt ?? 0)) return;
    this._bgAt = now + 6000;
    if (sim.aircraft.filter((a) => a.control === 'other').length < want) sim.spawnOther();
  }

  // Eventi della simulazione: nel tutorial gli errori non chiudono la partita, li spiego e basta.
  onSimEvent(ev) {
    if (!this.active) return;
    if (this.step?.onEvent) {
      try { this.step.onEvent(this.ctx, ev); } catch (err) { console.error('tutorial: onEvent', err); }
    }
    const coach = {
      missed: 'Il volo è uscito dal settore mentre era ancora in contatto con te: l\'hand-off va fatto poco prima del confine.',
      handoff: 'Hand-off al livello sbagliato: il livello d\'uscita è quello che leggi come COO nel tag.',
      offpoint: 'Il volo è uscito lontano dal suo punto di coordinamento: rimettilo in rotta prima del confine.',
      'area-infringement': 'Sei entrato in una zona attiva: vanno aggirate o scavalcate.',
    };
    const kind = ev.type === 'handoff' && ev.correct ? null : ev.type;
    if (kind && coach[kind] && !ev.emergency) {
      this.mistakes++;
      this.sound('oops');
      this.api.toast(`Istruttore: ${coach[kind]}`, 'warn');
    }
  }

  // Perdita di separazione o terzo errore: nel tutorial si continua.
  onGameOver(over) {
    this.mistakes++;
    this.sound('oops');
    const sim = this.sim;
    if (!sim) return;
    sim.gameOver = null;
    sim.strikes = [];
    if (over.reason === 'separation') {
      this.api.toast('Istruttore: separazione persa. In una sessione normale la partita finirebbe qui — '
        + 'intervieni prima, con un livello o una prua.', 'error');
    } else {
      this.api.toast('Istruttore: tre errori di coordinamento. Continuiamo, ma guarda il COO prima di ogni hand-off.', 'error');
    }
  }

  // --- disegno sul radar -----------------------------------------------------

  _clearDomFocus() {
    document.querySelectorAll('.tutorial-target').forEach((el) => el.classList.remove('tutorial-target'));
  }

  _focus() {
    if (!this.step?.focus) return null;
    try {
      return this.step.focus(this.ctx);
    } catch (err) {
      console.error('tutorial: focus', err);
      return null;
    }
  }

  draw(ctx, canvas, t, now) {
    if (!this.active) return;
    const f = this._focus();
    // l'elemento dell'interfaccia da guardare resta evidenziato anche a riquadro ridotto
    const domSel = f?.dom ?? null;
    if (domSel !== this._domSel) {
      this._clearDomFocus();
      this._domSel = domSel;
      if (domSel) document.querySelector(domSel)?.classList.add('tutorial-target');
    }
    if (!f || this.collapsed) return;

    const pulse = PULSE(now);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(110, 200, 255, ${0.45 + 0.45 * pulse})`;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -now / 60;

    if (f.ac && this.sim?.aircraft.includes(f.ac)) {
      const p = t.toPx(f.ac.x, f.ac.y);
      const r = 16 + 6 * pulse;
      ctx.beginPath();
      ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (f.tag && this.sim?.aircraft.includes(f.tag)) {
      const b = labelBlock(f.tag);
      if (b) {
        const pad = 4 + 2 * pulse;
        ctx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
      } else {
        const p = t.toPx(f.tag.x, f.tag.y);
        ctx.beginPath();
        ctx.arc(p.px, p.py, 18 + 6 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (f.fix) {
      const wp = waypoint(f.fix);
      if (wp) {
        const p = t.toPx(wp.x, wp.y);
        ctx.beginPath();
        ctx.arc(p.px, p.py, 14 + 6 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (f.point) {
      const p = t.toPx(f.point.x, f.point.y);
      ctx.beginPath();
      ctx.arc(p.px, p.py, (f.r ?? 20) * t.scale * 0.6 + 6 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (f.area?.polygon?.length) {
      ctx.beginPath();
      f.area.polygon.forEach((q, i) => {
        const p = t.toPx(q.x, q.y);
        if (i === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      });
      ctx.closePath();
      ctx.stroke();
    }
    if (f.sector) {
      ctx.lineWidth = 3;
      ctx.beginPath();
      airspace.polygon.forEach((q, i) => {
        const p = t.toPx(q.x, q.y);
        if (i === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- fine lezione ----------------------------------------------------------

  finishLesson() {
    const id = this.lesson.id;
    // tre stelle a chi fa tutto da solo, senza errori, suggerimenti né passi saltati
    const stars = this.lesson.stars
      ? this.lesson.stars(this.ctx)
      : this.mistakes === 0 && this.hintsUsed === 0 && this.skipped === 0 ? 3
        : this.mistakes <= 1 && this.skipped <= 1 ? 2 : 1;
    if (!this.progress.done.includes(id)) this.progress.done.push(id);
    this.progress.stars[id] = Math.max(this.progress.stars[id] ?? 0, stars);
    if (this.progress.current?.id === id) this.progress.current = null;
    saveProgress(this.progress);
    this.sound('lesson');

    const last = this.lessonIndex === LESSONS.length - 1;
    $('ld-badge').textContent = last ? 'TUTORIAL COMPLETATO' : 'LEZIONE COMPLETATA';
    $('ld-title').textContent = this.lesson.title;
    $('ld-sub').textContent = last
      ? 'Sai tutto quello che serve per tenere un settore: scegli dove vuoi lavorare.'
      : this.lesson.subtitle;
    $('ld-stars').innerHTML = [1, 2, 3].map((i) => `<span class="${i <= stars ? 'on' : ''}">★</span>`).join('');
    $('ld-learned').innerHTML = (this.lesson.learned ?? []).map((x) => `<li>${x}</li>`).join('');
    const sim = this.sim;
    $('ld-stats').innerHTML = `
      <div><span>Hand-off corretti</span><strong>${sim?.stats.handedOff ?? 0}</strong></div>
      <div><span>Errori</span><strong>${this.mistakes}</strong></div>
      <div><span>Suggerimenti</span><strong>${this.hintsUsed}</strong></div>`;
    $('ld-next').textContent = last ? 'Scegli un settore ▸' : 'Lezione successiva ▸';
    $('lesson-done').classList.remove('hidden');
    if (sim) sim.paused = true;
    this.api.syncPause();
    $('coach').classList.add('hidden');
    this.lesson = null;
    this.step = null;
    this._clearDomFocus();
    this._domSel = null;
  }
}
