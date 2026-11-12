// Controlli automatici prima di una pubblicazione:  npm test
//
//   1. il pacchetto è completo (licenza, crediti, icona, ponte verso l'esterno, metadati)
//   2. il link del sostegno è configurato (altrimenti il pulsante non comparirebbe)
//   3. le lezioni della modalità guidata sono ben formate
//   4. la simulazione è ancora in bilancio: carico nella fascia della difficoltà, nessun hand-off
//      sbagliato dal "controllore automatico", perdite di separazione fra voli altrui rare, tempo di calcolo
//      per passo sotto soglia
//
// Il punto 4 fa girare il banco di prova (tools/harness.mjs) con un seme fisso, quindi è ripetibile:
// se un cambiamento sposta il bilanciamento del traffico, qui si vede.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = path.join(ROOT, 'renderer');

let failed = 0;
let passed = 0;
let warned = 0;

// RELEASE=1 (lo impostano i controlli prima di una pubblicazione) rende fatali anche gli avvisi:
// in sviluppo sono solo promemoria, al momento di pubblicare no.
const STRICT = process.env.RELEASE === '1';

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FALLITO  ${name}${detail ? `\n           ${detail}` : ''}`);
  }
}

// Cose da sistemare prima di pubblicare, ma che non impediscono di lavorare.
function warn(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else if (STRICT) {
    failed++;
    console.log(`  FALLITO  ${name}${detail ? `\n           ${detail}` : ''}`);
  } else {
    warned++;
    console.log(`  da fare  ${name}${detail ? `\n           ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// --- 1. pacchetto -----------------------------------------------------------

section('Pacchetto');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const file of ['README.md', 'LICENSE', 'CREDITI.md', 'preload.js', 'main.js', 'build/icon.png']) {
  check(file, fs.existsSync(path.join(ROOT, file)), 'manca dalla cartella del progetto');
}
check('package.json: productName', !!pkg.productName);
check('package.json: version', /^\d+\.\d+\.\d+$/.test(pkg.version ?? ''), `trovato "${pkg.version}"`);
check('package.json: autore', !!(typeof pkg.author === 'string' ? pkg.author : pkg.author?.name));
check('package.json: configurazione di electron-builder', !!pkg.build?.appId && !!pkg.build?.files);
check('package.json: non pubblicabile su npm per sbaglio', pkg.private === true);
const icon = fs.existsSync(path.join(ROOT, 'build/icon.png')) && fs.statSync(path.join(ROOT, 'build/icon.png'));
check('icona di almeno 10 KB', icon && icon.size > 10_000);

// --- sito ----------------------------------------------------------------------

section('Sito');
for (const file of ['site/index.html', 'site/img/radar.jpg', 'renderer/favicon.png', '.github/workflows/sito.yml']) {
  check(file, fs.existsSync(path.join(ROOT, file)), 'manca dalla cartella del progetto');
}
const built = (await import('node:child_process')).spawnSync('node', ['tools/build-site.mjs'], { cwd: ROOT, encoding: 'utf8' });
check('il sito si assembla', built.status === 0, built.stderr);
check('_site/play contiene il simulatore', fs.existsSync(path.join(ROOT, '_site/play/index.html'))
  && fs.existsSync(path.join(ROOT, '_site/play/sim.js')));
const landing = fs.existsSync(path.join(ROOT, 'site/index.html')) ? fs.readFileSync(path.join(ROOT, 'site/index.html'), 'utf8') : '';
check('la pagina rimanda al simulatore e ai download', landing.includes('href="play/"') && landing.includes('/releases/latest'));

// --- 2. sostegno al progetto -------------------------------------------------

section('Sostegno al progetto');
const support = await import(`${R}/support.js`);
warn('link delle donazioni configurato', !!support.donateUrl,
  'metti il tuo nome utente in BUYMEACOFFEE_USER dentro renderer/support.js: senza, il pulsante non compare');
check('indirizzo del sostegno in https', !support.donateUrl || support.donateUrl.startsWith('https://'));
check('disclaimer presente', /valore operativo/i.test(support.DISCLAIMER));
check('fonti dei dati elencate', support.SOURCES.length >= 3);

// il processo principale deve autorizzare i domini usati dalla schermata delle informazioni
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const hosts = [...support.SOURCES.map((s) => s.url), support.donateUrl]
  .filter(Boolean)
  .map((u) => new URL(u).hostname);
for (const host of [...new Set(hosts)]) {
  const allowed = mainSrc.includes(`'${host}'`)
    || host.split('.').slice(-2).join('.') && mainSrc.includes(`'${host.split('.').slice(-2).join('.')}'`);
  check(`dominio autorizzato: ${host}`, allowed, 'aggiungilo a ALLOWED_HOSTS in main.js');
}

// --- 3. modalità guidata -----------------------------------------------------

section('Modalità guidata');
const { LESSONS } = await import(`${R}/tutorial.js`);
check('dieci lezioni', LESSONS.length === 10, `trovate ${LESSONS.length}`);
const ids = new Set();
let wellFormed = true;
let problem = '';
for (const [i, l] of LESSONS.entries()) {
  if (!l.id || ids.has(l.id)) {
    wellFormed = false;
    problem = `lezione ${i + 1}: identificativo mancante o ripetuto`;
    break;
  }
  ids.add(l.id);
  if (!l.title || !l.subtitle || !Array.isArray(l.steps) || !l.steps.length) {
    wellFormed = false;
    problem = `lezione ${i + 1} (${l.id}): titolo, sottotitolo o passi mancanti`;
    break;
  }
  for (const [k, step] of l.steps.entries()) {
    if (!step.title || !step.text) {
      wellFormed = false;
      problem = `lezione ${i + 1}, passo ${k + 1}: titolo o testo mancante`;
      break;
    }
    // un passo senza `done` si supera con "Avanti": allora non deve chiedere niente
    if (!step.done && step.goal) {
      wellFormed = false;
      problem = `lezione ${i + 1}, passo ${k + 1}: chiede un obiettivo ma non sa riconoscerlo`;
      break;
    }
  }
  if (!wellFormed) break;
}
check('lezioni ben formate', wellFormed, problem);

// --- 4. bilanciamento della simulazione --------------------------------------

section('Bilanciamento della simulazione (banco di prova, 2 ore per settore)');
const { measure } = await import(`${ROOT}/tools/harness.mjs`);
const { DIFFICULTY } = await import(`${R}/sector-model.js`);
const { CENTRES } = await import(`${R}/sectors.js`);

const CASES = [['roma', 'NWA'], ['roma', 'OVB'], ['milano', CENTRES[1].sectors[0].id]];
for (const [centre, id] of CASES) {
  const sector = CENTRES.find((c) => c.id === centre).sectors.find((s) => s.id === id);
  const target = DIFFICULTY[sector.difficulty].load;
  const r = measure(centre, id, 2, 7);
  const line = `carico ${r.load} (atteso ~${target}) · offerte/h ${r.offersPerH} · passaggio ${r.transitMin} min`
    + ` · hand-off ${r.handoffs} · perdite altrui/h ${r.othersLostPerH} · tick ${r.tickMsAvg} ms`;
  console.log(`  ${centre} ${id}: ${line}`);
  check(`${id}: carico vicino alla difficoltà`, r.load > target * 0.6 && r.load < target * 1.5,
    `carico ${r.load}, atteso fra ${(target * 0.6).toFixed(1)} e ${(target * 1.5).toFixed(1)}`);
  // il "controllore automatico" del banco di prova non è perfetto (emergenze e deviazioni per
  // maltempo gli cambiano il livello d'uscita sotto il naso): si controlla che resti un'eccezione
  const wrongRate = r.handoffs ? r.wrong / r.handoffs : 0;
  check(`${id}: hand-off corretti`, wrongRate < 0.1,
    `${r.wrong} sbagliati su ${r.handoffs} (${Math.round(wrongRate * 100)}%, soglia 10%)`);
  // gli altri settori risolvono i conflitti fra i loro voli: una perdita di separazione altrui è un'eccezione.
  // Su sei semi da tre ore la media è sotto 1 all'ora in NWA, OVB ed ESA, ma in due ore sono pochi eventi e
  // il conto oscilla (anche 2 all'ora in una prova sola): la soglia guarda le derive vere, non il caso
  check(`${id}: gli altri enti separano il loro traffico`, r.othersLostPerH <= 2.5,
    `${r.othersLostPerH} perdite di separazione all'ora fra voli non nostri (soglia 2,5)`);
  check(`${id}: calcolo fluido`, r.tickMsAvg < 5, `${r.tickMsAvg} ms per passo`);
}

// --- esito -------------------------------------------------------------------

const tail = `${passed} controlli superati, ${failed} falliti${warned ? `, ${warned} da sistemare prima di pubblicare` : ''}`;
console.log(`\n${failed ? '✗' : '✓'} ${tail}`);
if (warned) console.log('  (RELEASE=1 npm test rende fatali anche le voci "da fare")');
process.exit(failed ? 1 : 0);
