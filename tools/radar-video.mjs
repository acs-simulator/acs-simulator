// Video del radar per il sito, registrato dal simulatore vero:
//
//   npx electron tools/radar-video.mjs
//
// Il simulatore gira in una finestra nascosta con un orologio finto: ogni fotogramma avanza la
// simulazione di un passo fisso (1/30 s × velocità), così il movimento è regolare anche se la finestra
// non si vede. Un controllore automatico fa quello che farebbe chi gioca (come in tools/harness.mjs):
// prende in carico i voli magenta dopo qualche secondo, autorizza il livello d'uscita e li passa al
// settore successivo. Il canvas del radar si registra con MediaRecorder (WebM VP9) in
// site/img/radar.webm, col primo fotogramma in site/img/radar-video.jpg.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const OUT = path.join(ROOT, 'site', 'img');
const FPS = 30;
const SECONDS = 16;
const SPEED = 8;            // come il pulsante 8x del simulatore
const WARMUP_S = 150;       // secondi simulati prima di registrare, per avere già voli verdi e magenta
const HAND_ON_AFTER_S = 25; // un volo resta magenta per questo tempo simulato, poi lo si prende

// copia del simulatore con due aggiunte: l'orologio finto (prima di tutto) e l'accesso alla simulazione
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-video-'));
fs.cpSync(path.join(ROOT, 'renderer'), TMP, { recursive: true });
const CLOCK = `<script>
  // requestAnimationFrame non parte da solo: ogni chiamata a __step(ms) fa avanzare il tempo di ms
  (() => {
    let now = performance.now();
    let queue = [];
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    window.__step = (ms) => { now += ms; const q = queue; queue = []; q.forEach((cb) => cb(now)); };
  })();
</script>`;
const html = path.join(TMP, 'index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<head>', `<head>\n${CLOCK}`));
fs.appendFileSync(path.join(TMP, 'app.js'), '\nwindow.__acs = { get sim() { return sim; } };\n');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#050a10',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // la finestra è nascosta: senza questo i timer della registrazione andrebbero a scatti
      backgroundThrottling: false,
      additionalArguments: [`--app-version=${VERSION}`],
    },
  });
  await win.loadFile(html);
  await wait(1000);
  await win.webContents.executeJavaScript(`
    document.querySelector('.sector-card').click();
    document.getElementById('setup-start').click();
  `);
  await wait(500);

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const { insideLateral, waypoint } = await import('./airspace.js');
      const { distance } = await import('./geo.js');
      const sim = window.__acs.sim;
      sim._endGame = () => {};   // il video non deve finire su "partita finita"
      sim.timeMultiplier = ${SPEED};
      document.querySelectorAll('#speed-buttons button').forEach((b) => b.classList.toggle('active', b.dataset.mult === '${SPEED}'));

      const nearExit = (ac) => {
        const fix = ac.exitFix ? waypoint(ac.exitFix) : null;
        return fix ? distance(ac, fix) < 6 : false;
      };
      // il controllore automatico: hand-on con un po' di ritardo, livello d'uscita, hand-off al confine
      const control = () => {
        for (const ac of sim.aircraft) {
          if (ac.control === 'offered' && sim.simTime - (ac.offeredAt ?? sim.simTime) >= ${HAND_ON_AFTER_S}) sim.handOn(ac);
          if (ac.control !== 'assumed') continue;
          if (ac.requestedExitFL != null && ac.clearedFL !== ac.requestedExitFL) ac.setFlightLevel(ac.requestedExitFL);
          const ready = ac.wasInside && (ac.verticalExit
            ? Math.abs(ac.altitude - ac.requestedExitFL * 100) < 1200
            : (ac.wasLateral && !insideLateral(ac)) || nearExit(ac));
          if (ready) sim.handOff(ac);
        }
      };
      const frameMs = 1000 / ${FPS};

      // riscaldamento, senza registrare
      for (let t = 0; t < ${WARMUP_S}; t += (frameMs / 1000) * ${SPEED}) { control(); window.__step(frameMs); }

      const canvas = document.getElementById('radar');
      const poster = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 1_200_000 });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.start(1000);
      // un fotogramma ogni 1/30 s di tempo vero: i tempi del file restano regolari
      let next = performance.now();
      for (let i = 0; i < ${FPS * SECONDS}; i++) {
        control();
        window.__step(frameMs);
        track.requestFrame();
        next += frameMs;
        await new Promise((r) => setTimeout(r, Math.max(0, next - performance.now())));
      }
      rec.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const counts = {};
      for (const ac of sim.aircraft) counts[ac.control] = (counts[ac.control] ?? 0) + 1;
      return JSON.stringify({ size: [canvas.width, canvas.height], data: btoa(s), poster, counts });
    })()
  `);
  const { size, data, poster, counts } = JSON.parse(result);
  fs.writeFileSync(path.join(OUT, 'radar.webm'), Buffer.from(data, 'base64'));
  fs.writeFileSync(path.join(OUT, 'radar-video.jpg'), Buffer.from(poster, 'base64'));
  const mb = (fs.statSync(path.join(OUT, 'radar.webm')).size / 1024 / 1024).toFixed(1);
  console.log(`site/img/radar.webm  ${size[0]}x${size[1]}  ${mb} MB  voli a fine video: ${JSON.stringify(counts)}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.quit();
});
