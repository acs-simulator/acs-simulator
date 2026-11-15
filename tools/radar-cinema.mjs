// Video "cinematografico" del radar per la landing page, dal simulatore vero:
//
//   npx electron tools/radar-cinema.mjs
//
// Il simulatore gira a passo fisso (orologio finto: ogni fotogramma avanza di 1/30 s) a tutto schermo,
// senza pannelli, con un controllore automatico che prende in carico i voli magenta. Il radar si
// disegna a 1,5 volte (2880x1620) e ogni fotogramma passa da una "ripresa" ridotta a
// 1920x1080: la telecamera inquadra da vicino il settore e oscilla appena, i bordi sono sfocati, i
// tag hanno un leggero bagliore, sopra ci sono righe del monitor, vignettatura e una grana fissa
// (cambiarla a ogni fotogramma peggiorerebbe molto la compressione). Gli ultimi istanti si
// dissolvono nei primi e il moto della telecamera è periodico: il video gira in loop senza salti.
//
// Escono site/img/radar-cinema.mp4 (1080p) e radar-cinema-720.mp4 (per i telefoni), H.264, con il
// fotogramma di anteprima in site/img/radar-cinema.jpg.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const OUT = path.join(ROOT, 'site', 'img');
const W = 1920;              // finestra del simulatore (px CSS) e video principale
const H = 1080;
const DPR = 1.5;             // il radar si disegna a 2880x1620: anche inquadrato da vicino resta più grande del video
const FPS = 30;
const SECONDS = 12;          // durata del loop
const BLEND_S = 1.5;         // dissolvenza fra la fine e l'inizio
const SPEED = 8;             // come il pulsante 8x
const WARMUP_S = 150;        // secondi simulati prima di cominciare
const HAND_ON_AFTER_S = 25;  // un volo resta magenta per questo tempo simulato, poi lo si prende
const ZOOM = 1.3;            // quanto la telecamera è vicina al settore
const FOCUS = [0.47, 0.49];  // dove guarda la telecamera, in frazioni del radar (il settore NW Alto)
const VERSIONS = [           // [nome del file, larghezza, altezza, bit al secondo]
  ['radar-cinema.mp4', 1920, 1080, 6_500_000],
  ['radar-cinema-720.mp4', 1280, 720, 3_200_000],
];

// copia del simulatore: orologio finto, densità di pixel fissa, solo il radar a tutto schermo
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-cinema-'));
fs.cpSync(path.join(ROOT, 'renderer'), TMP, { recursive: true });
const HEAD = `<script>
  (() => {
    let now = performance.now();
    let queue = [];
    window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    window.__step = (ms) => { now += ms; const q = queue; queue = []; q.forEach((cb) => cb(now)); };
    Object.defineProperty(window, 'devicePixelRatio', { get: () => ${DPR} });
  })();
</script>
<style>#sidebar, #radar-tools, #radar-overlays, #coach, #coach-warp, #screen-guard { display: none !important; }</style>`;
const html = path.join(TMP, 'index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<head>', `<head>\n${HEAD}`));
fs.appendFileSync(path.join(TMP, 'app.js'), '\nwindow.__acs = { get sim() { return sim; } };\n');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#050a10',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: [`--app-version=${VERSION}`],
    },
  });
  win.setContentSize(W, H);
  await win.loadFile(html);
  await wait(1000);
  await win.webContents.executeJavaScript(`
    document.querySelector('.sector-card').click();
    document.getElementById('setup-start').click();
    window.dispatchEvent(new Event('resize'));
  `);
  await wait(500);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const FPS = ${FPS};
    const { insideLateral, waypoint } = await import('./airspace.js');
    const { distance } = await import('./geo.js');
    const sim = window.__acs.sim;
    sim._endGame = () => {};
    sim.timeMultiplier = ${SPEED};

    // controllore automatico, come in tools/harness.mjs
    const nearExit = (ac) => { const f = ac.exitFix ? waypoint(ac.exitFix) : null; return f ? distance(ac, f) < 6 : false; };
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
    const frameMs = 1000 / FPS;
    const stepSim = () => { control(); window.__step(frameMs); };
    for (let t = 0; t < ${WARMUP_S}; t += (frameMs / 1000) * ${SPEED}) stepSim();

    const radar = document.getElementById('radar');
    const SW = radar.width, SH = radar.height;       // radar a doppia risoluzione
    const W = ${W}, H = ${H};                         // video principale
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

    // --- materiali della ripresa, preparati una volta ---
    const edge = mk(480, 270), ectx = edge.getContext('2d');   // radar sfocato, solo ai bordi
    const glow = mk(240, 135), gctx = glow.getContext('2d');   // bagliore
    // maschera dei bordi: trasparente al centro (a fuoco), piena verso i bordi (sfocati)
    const edgeMask = mk(480, 270), emx = edgeMask.getContext('2d');
    const em = emx.createRadialGradient(240, 135, 70, 240, 135, 290);
    em.addColorStop(0, 'rgba(0,0,0,0)'); em.addColorStop(0.45, 'rgba(0,0,0,0.25)'); em.addColorStop(1, 'rgba(0,0,0,1)');
    emx.fillStyle = em; emx.fillRect(0, 0, 480, 270);
    // righe del monitor, vignettatura con un riflesso del vetro, grana: tutto fisso
    const over = mk(W, H), ox = over.getContext('2d');
    ox.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = 0; y < H; y += 3) ox.fillRect(0, y, W, 1);
    const vg = ox.createRadialGradient(W * 0.5, H * 0.5, H * 0.38, W * 0.5, H * 0.5, H * 1.05);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.72)');
    ox.fillStyle = vg; ox.fillRect(0, 0, W, H);
    const gl = ox.createLinearGradient(0, 0, W, H);
    gl.addColorStop(0, 'rgba(160,220,255,0.045)'); gl.addColorStop(0.35, 'rgba(160,220,255,0)'); gl.addColorStop(1, 'rgba(0,0,0,0.12)');
    ox.fillStyle = gl; ox.fillRect(0, 0, W, H);
    const grain = mk(W, H), grx = grain.getContext('2d'), img = grx.createImageData(W, H);
    for (let i = 0; i < img.data.length; i += 4) { const v = 128 + (Math.random() - 0.5) * 70; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    grx.putImageData(img, 0, 0);

    const out = mk(W, H), o = out.getContext('2d');
    o.imageSmoothingQuality = 'high';

    const L = Math.round(${SECONDS} * FPS);
    const F = Math.round(${BLEND_S} * FPS);

    // la ripresa: k è la posizione nel loop (0..L-1); il moto della telecamera è periodico
    function shoot(k) {
      const th = (k / L) * Math.PI * 2;
      const zoom = ${ZOOM} * (1 + 0.022 * Math.sin(th));
      const dx = 26 * Math.cos(th), dy = 14 * Math.sin(th);
      const rot = (0.35 * Math.sin(th) * Math.PI) / 180;
      const s = (zoom * W) / SW;               // dal radar a doppia risoluzione al video
      ectx.globalCompositeOperation = 'source-over';
      ectx.drawImage(radar, 0, 0, 480, 270);
      gctx.drawImage(edge, 0, 0, 240, 135);
      ectx.globalCompositeOperation = 'destination-in';
      ectx.drawImage(edgeMask, 0, 0);
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalCompositeOperation = 'source-over';
      o.globalAlpha = 1;
      o.fillStyle = '#04080d';
      o.fillRect(0, 0, W, H);
      o.save();
      o.translate(W / 2 + dx, H / 2 + dy);
      o.rotate(rot);
      o.scale(s, s);
      o.translate(-SW * ${FOCUS[0]}, -SH * ${FOCUS[1]});
      o.drawImage(radar, 0, 0);                // a fuoco
      o.drawImage(edge, 0, 0, SW, SH);         // bordi sfocati sopra
      o.globalCompositeOperation = 'lighter';
      o.globalAlpha = 0.26;
      o.drawImage(glow, 0, 0, SW, SH);         // bagliore
      o.restore();
      o.globalAlpha = 1;
      o.globalCompositeOperation = 'source-over';
      o.drawImage(over, 0, 0);
      o.globalCompositeOperation = 'overlay';
      o.globalAlpha = 0.05;
      o.drawImage(grain, 0, 0);
      o.globalAlpha = 1;
      o.globalCompositeOperation = 'source-over';
    }

    // --- registrazione: una tela per versione, tutte dallo stesso fotogramma ---
    const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4']
      .find((m) => MediaRecorder.isTypeSupported(m));
    const versions = ${JSON.stringify(VERSIONS)}.map(([name, w, h, bps]) => {
      const c = w === W ? out : mk(w, h);
      const stream = c.captureStream(0);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => { rec.onstop = r; });
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      return { name, c, cx, rec, chunks, stopped, track: stream.getVideoTracks()[0], scaled: c !== out };
    });

    // i primi F fotogrammi già ripresi si tengono da parte: alla fine si dissolvono nei successivi
    const head = [];
    for (let i = 0; i < F; i++) { stepSim(); shoot(i); head.push(await createImageBitmap(out)); }

    let poster = null, next = performance.now(), slow = 0;
    const emit = async () => {
      for (const v of versions) {
        if (v.scaled) v.cx.drawImage(out, 0, 0, v.c.width, v.c.height);
        v.track.requestFrame();
      }
      next += 1000 / FPS;
      const waitMs = next - performance.now();
      if (waitMs < 0) slow++;
      await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
    };
    versions.forEach((v) => v.rec.start(1000));
    for (let k = F; k < L; k++) {
      stepSim();
      shoot(k);
      await emit();
      if (k === Math.round(L * 0.45)) poster = out.toDataURL('image/jpeg', 0.84).split(',')[1];
    }
    for (let i = 0; i < F; i++) {
      stepSim();
      shoot(i);
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.globalAlpha = (i + 1) / F;
      o.drawImage(head[i], 0, 0);
      o.globalAlpha = 1;
      await emit();
    }
    versions.forEach((v) => v.rec.stop());
    const files = [];
    for (const v of versions) {
      await v.stopped;
      const bytes = new Uint8Array(await new Blob(v.chunks, { type: mime }).arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      files.push([v.name, btoa(s)]);
    }
    return JSON.stringify({ mime, radar: [SW, SH], files, poster, slow });
  })()`);

  const { mime, radar, files, poster, slow } = JSON.parse(result);
  for (const [name, data] of files) {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`${path.relative(ROOT, file)}  ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);
  }
  fs.writeFileSync(path.join(OUT, 'radar-cinema.jpg'), Buffer.from(poster, 'base64'));
  console.log(`${mime} · radar ${radar.join('x')} · fotogrammi in ritardo ${slow}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.quit();
});
