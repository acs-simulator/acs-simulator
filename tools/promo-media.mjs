// Materiali per far conoscere il simulatore, generati dal simulatore vero:
//
//   npx electron tools/promo-media.mjs
//
//   site/img/social.jpg      1280×640, anteprima dei link (Open Graph, X, WhatsApp, Telegram) e
//                            "Social preview" del repository GitHub
//   dist/promo/verticale.*   video verticale 1080×1920 per Reels, TikTok e YouTube Shorts (MP4 se
//                            Chromium lo sa registrare, altrimenti WebM)
//   dist/promo/quadrato.jpg  immagine 1080×1080 per i post
//
// Il video usa lo stesso orologio finto e lo stesso controllore automatico di tools/radar-video.mjs:
// il radar gira in una finestra nascosta alta e stretta, un secondo canvas lo ricompone in verticale
// con titolo e indirizzo, e MediaRecorder registra quel canvas.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PROMO = path.join(ROOT, 'dist', 'promo');
const URL_TEXT = 'acs-simulator.github.io/acs-simulator';
const FPS = 30;
const SECONDS = 20;
const SPEED = 8;
const WARMUP_S = 150;
const HAND_ON_AFTER_S = 25;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(PROMO, { recursive: true });

// --- immagini statiche: una pagina HTML fotografata con capturePage ---
const CARD_CSS = `
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #050b12; overflow: hidden; }
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; color: #d7e6ea; position: relative; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .radar { position: absolute; inset: 0; background: url(radar.jpg) no-repeat; }
  .fade { position: absolute; inset: 0; }
  .text { position: absolute; display: flex; flex-direction: column; }
  .kicker { color: #7cfc9a; letter-spacing: 0.18em; font-weight: 600; }
  h1 { font-weight: 650; line-height: 1.04; letter-spacing: -0.02em; color: #fff; }
  h1 span { display: block; }
  p { color: rgba(215, 230, 234, 0.8); line-height: 1.35; }
  .tags { display: flex; flex-wrap: wrap; gap: 10px; }
  .tags span { border: 1px solid rgba(120, 170, 180, 0.45); padding: 6px 12px; color: #6ec8ff; background: rgba(10, 20, 32, 0.7); }
  .url { color: #ffd75e; }
`;
const cardHtml = (kind) => kind === 'social' ? `<!doctype html><meta charset="utf-8"><style>${CARD_CSS}
  .radar { background-size: 1400px auto; background-position: 200px -70px; }
  .fade { background: linear-gradient(90deg, #050b12 0%, #050b12 34%, rgba(5,11,18,0.82) 52%, rgba(5,11,18,0.1) 78%, rgba(5,11,18,0) 100%); }
  .text { left: 64px; top: 0; bottom: 0; width: 640px; justify-content: center; gap: 26px; }
  .kicker { font-size: 22px; }
  h1 { font-size: 66px; }
  p { font-size: 25px; max-width: 560px; }
  .tags { font-size: 18px; }
  .url { font-size: 20px; margin-top: 6px; }
</style><body><div class="radar"></div><div class="fade"></div>
<div class="text">
  <div class="kicker mono">ACS SIMULATOR</div>
  <h1><span>Controlla il cielo</span><span>da una sala radar</span></h1>
  <p>Il controllo del traffico aereo d'area sui settori reali di Roma ACC e Milano ACC.</p>
  <div class="tags mono"><span>GRATIS</span><span>NEL BROWSER</span><span>MAC · WIN · LINUX</span></div>
  <div class="url mono">${URL_TEXT}</div>
</div></body>` : `<!doctype html><meta charset="utf-8"><style>${CARD_CSS}
  .radar { background-size: 1900px auto; background-position: -370px -100px; }
  .fade { background: linear-gradient(180deg, rgba(5,11,18,0) 0%, rgba(5,11,18,0.1) 38%, rgba(5,11,18,0.88) 60%, #050b12 74%); }
  .text { left: 64px; right: 64px; bottom: 64px; gap: 24px; }
  .kicker { font-size: 26px; }
  h1 { font-size: 78px; }
  p { font-size: 30px; }
  .tags { font-size: 22px; }
  .url { font-size: 24px; }
</style><body><div class="radar"></div><div class="fade"></div>
<div class="text">
  <div class="kicker mono">ACS SIMULATOR</div>
  <h1><span>Sei tu</span><span>il controllore.</span></h1>
  <p>Roma ACC e Milano ACC, settori reali. Tutorial guidato, gratis, anche nel browser.</p>
  <div class="url mono">${URL_TEXT}</div>
</div></body>`;

async function card(kind, width, height, out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-card-'));
  fs.copyFileSync(path.join(ROOT, 'site', 'img', 'radar.jpg'), path.join(dir, 'radar.jpg'));
  fs.writeFileSync(path.join(dir, 'card.html'), cardHtml(kind));
  const win = new BrowserWindow({ width, height, show: false, useContentSize: true, enableLargerThanScreen: true,
    webPreferences: { zoomFactor: 1 } });
  await win.loadFile(path.join(dir, 'card.html'));
  await wait(400);
  const img = (await win.webContents.capturePage()).resize({ width, height, quality: 'best' });
  fs.writeFileSync(out, img.toJPEG(88));
  win.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${path.relative(ROOT, out)}  ${width}x${height}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

// --- video verticale ---
async function verticalVideo() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-promo-'));
  fs.cpSync(path.join(ROOT, 'renderer'), TMP, { recursive: true });
  const CLOCK = `<script>
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

  // finestra alta: il radar viene già quasi verticale
  const win = new BrowserWindow({
    width: 1240, height: 1700, show: false, useContentSize: true, enableLargerThanScreen: true,
    paintWhenInitiallyHidden: true, backgroundColor: '#050a10',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: true,
      backgroundThrottling: false, additionalArguments: [`--app-version=${VERSION}`],
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
      sim._endGame = () => {};
      sim.timeMultiplier = ${SPEED};
      const nearExit = (ac) => {
        const fix = ac.exitFix ? waypoint(ac.exitFix) : null;
        return fix ? distance(ac, fix) < 6 : false;
      };
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
      for (let t = 0; t < ${WARMUP_S}; t += (frameMs / 1000) * ${SPEED}) { control(); window.__step(frameMs); }

      const radar = document.getElementById('radar');
      // testi fuori dalle fasce coperte dai pulsanti di Reels e TikTok (circa 220 px sopra, 420 sotto)
      const W = 1080, H = 1920, TOP = 400, BOTTOM = 470;
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const g = out.getContext('2d');
      const sans = '-apple-system, "Segoe UI", system-ui, sans-serif';
      const mono = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      // il radar riempie la fascia centrale, ritagliato al centro
      const boxH = H - TOP - BOTTOM;
      const scale = Math.max(W / radar.width, boxH / radar.height);
      const sw = W / scale, sh = boxH / scale;
      const sx = (radar.width - sw) / 2, sy = (radar.height - sh) / 2;
      const draw = (t) => {
        g.fillStyle = '#050b12';
        g.fillRect(0, 0, W, H);
        g.drawImage(radar, sx, sy, sw, sh, 0, TOP, W, boxH);
        // sfumature sopra e sotto
        let gr = g.createLinearGradient(0, TOP, 0, TOP + 120);
        gr.addColorStop(0, '#050b12'); gr.addColorStop(1, 'rgba(5,11,18,0)');
        g.fillStyle = gr; g.fillRect(0, TOP, W, 120);
        gr = g.createLinearGradient(0, H - BOTTOM - 140, 0, H - BOTTOM);
        gr.addColorStop(0, 'rgba(5,11,18,0)'); gr.addColorStop(1, '#050b12');
        g.fillStyle = gr; g.fillRect(0, H - BOTTOM - 140, W, 140);
        // testi
        g.textBaseline = 'alphabetic';
        g.fillStyle = '#7cfc9a'; g.font = '600 30px ' + mono;
        g.fillText('ACS SIMULATOR', 64, 220);
        g.fillStyle = '#ffffff'; g.font = '650 76px ' + sans;
        g.fillText(t < 10 ? 'Tienili separati.' : 'Sei tu il controllore.', 64, 314);
        g.fillStyle = 'rgba(215,230,234,0.82)'; g.font = '400 34px ' + sans;
        g.fillText(t < 10 ? '5 miglia o 1000 piedi. Mai meno.' : 'Roma ACC e Milano ACC, settori reali.', 64, 368);
        g.fillStyle = '#ffffff'; g.font = '600 46px ' + sans;
        g.fillText('Gioca gratis nel browser', 64, H - 400);
        g.fillStyle = '#ffd75e'; g.font = '500 34px ' + mono;
        g.fillText('${URL_TEXT}', 64, H - 340);
      };

      const types = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9'];
      const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
      const stream = out.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.start(1000);
      let next = performance.now();
      let square = null;
      for (let i = 0; i < ${FPS * SECONDS}; i++) {
        control();
        window.__step(frameMs);
        draw(i / ${FPS});
        track.requestFrame();
        if (i === ${FPS * 12}) square = out.toDataURL('image/jpeg', 0.9).split(',')[1];
        next += frameMs;
        await new Promise((r) => setTimeout(r, Math.max(0, next - performance.now())));
      }
      rec.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return JSON.stringify({ radar: [radar.width, radar.height], mimeType, data: btoa(s), frame: square });
    })()
  `);
  const { radar, mimeType, data, frame } = JSON.parse(result);
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  const file = path.join(PROMO, `verticale.${ext}`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  // MediaRecorder scrive un MP4 frammentato senza durata, che Instagram e TikTok rifiutano:
  // su macOS lo si riscrive con avconvert (incluso nel sistema) in un MP4 H.264 normale
  if (ext === 'mp4' && process.platform === 'darwin') {
    const fixed = path.join(PROMO, 'verticale-avconvert.mp4');
    execFileSync('avconvert', ['--source', file, '--output', fixed, '--preset', 'Preset1920x1080', '--replace']);
    fs.renameSync(fixed, file);
  }
  fs.writeFileSync(path.join(PROMO, 'verticale-fotogramma.jpg'), Buffer.from(frame, 'base64'));
  console.log(`${path.relative(ROOT, file)}  1080x1920  ${mimeType}  radar ${radar.join('x')}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);
  win.destroy();
  fs.rmSync(TMP, { recursive: true, force: true });
}

// le finestre si chiudono una dopo l'altra: senza questo Electron uscirebbe alla prima
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  await card('social', 1280, 640, path.join(ROOT, 'site', 'img', 'social.jpg'));
  await card('square', 1080, 1080, path.join(PROMO, 'quadrato.jpg'));
  await verticalVideo();
  app.quit();
});
