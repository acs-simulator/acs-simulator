// Illustrazioni della sala radar per il sito, disegnate in codice (tools/illustrations/sala.js):
//
//   npx electron tools/illustrations.mjs            tutte le scene
//   npx electron tools/illustrations.mjs turno      solo una
//
// Ogni scena si apre in una finestra nascosta e si salva in site/img/sala-<scena>.jpg. Sui monitor
// disegnati ci sono le schermate vere di docs/: rifare prima quelle (tools/screenshot.mjs) se cambiano.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site', 'img');
const SCENES = { turno: [2400, 1250], ascolto: [1800, 1200], sala: [2400, 900] };
const QUALITY = 80;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// scene grandi con molti livelli sfocati: senza questi il compositore salta dei pezzi
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '4096');
app.commandLine.appendSwitch('disable-gpu');

// le scene si aprono una alla volta: chiusa una finestra l'app non deve uscire
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const only = process.argv.slice(2).filter((a) => SCENES[a]);
  for (const name of only.length ? only : Object.keys(SCENES)) {
    const [w, h] = SCENES[name];
    const win = new BrowserWindow({
      width: w,
      height: h,
      useContentSize: true,
      enableLargerThanScreen: true,
      show: false,
      backgroundColor: '#03070b',
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    await win.loadFile(path.join(ROOT, 'tools', 'illustrations', 'sala.html'), { query: { scena: name } }).catch(() => {});
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('!!window.__ready')) break;
      await wait(100);
    }
    await wait(600);
    let image = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    if (image.getSize().width !== w) image = image.resize({ width: w, height: h, quality: 'best' });
    const file = path.join(OUT, `sala-${name}.jpg`);
    fs.writeFileSync(file, image.toJPEG(QUALITY));
    console.log(`${path.relative(ROOT, file)}  ${image.getSize().width}x${image.getSize().height}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    win.destroy();
  }
  app.quit();
});
