// Schermate per il README e per le pagine di download, prodotte dall'applicazione vera:
//
//   npx electron tools/screenshot.mjs
//
// Apre una finestra fuori schermo, avvia una sessione, aspetta che il settore si riempia e
// salva i PNG in docs/. Nessuna finestra compare sul desktop.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// eseguito così lo script non è un'applicazione impacchettata: app.getVersion() darebbe la versione
// di Electron, quindi la versione vera si legge dal package.json del progetto
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const OUT = path.join(ROOT, 'docs');
const WIDTH = 1500;
const HEIGHT = 950;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`${path.relative(ROOT, file)}  ${image.getSize().width}x${image.getSize().height}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    backgroundColor: '#050a10',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: [`--app-version=${VERSION}`],
    },
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await wait(1500);

  // 1. schermata iniziale: scelta del settore
  await shot(win, 'schermata-iniziale');

  // 2. una sessione in corso: si lascia girare finché il settore è a regime
  await win.webContents.executeJavaScript(`
    document.querySelector('.sector-card').click();
    document.getElementById('setup-start').click();
  `);
  await wait(9000);
  await win.webContents.executeJavaScript(`
    document.getElementById('sim-menu').open = true;
  `);
  await wait(500);
  await shot(win, 'radar');

  // 3. la modalità guidata, alla prima lezione
  await win.webContents.executeJavaScript(`
    document.getElementById('change-sector').click();
    document.getElementById('tutorial-cta').click();
    document.getElementById('tutorial-start').click();
  `);
  await wait(2500);
  await win.webContents.executeJavaScript(`
    document.getElementById('coach-next').click();
  `);
  await wait(1200);
  await shot(win, 'tutorial');

  app.quit();
});
