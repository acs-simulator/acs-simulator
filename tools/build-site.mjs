// Assembla il sito in _site/:  npm run site
//
//   _site/index.html   pagina di presentazione (site/)
//   _site/img/         schermate (site/img/)
//   _site/play/        il simulatore giocabile nel browser: una copia di renderer/
//
// Il simulatore non viene duplicato nel repository: si copia a ogni costruzione, quindi il sito
// e il programma da scaricare usano sempre lo stesso codice. Lo stesso script gira in locale e
// nella pubblicazione automatica (.github/workflows/sito.yml).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'site'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'renderer'), path.join(OUT, 'play'), { recursive: true });
// senza questo file GitHub Pages passa i contenuti per Jekyll, che ignora le cartelle che iniziano per "_"
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const count = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
const size = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .reduce((n, e) => n + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0);
console.log(`_site/: ${count(OUT)} file, ${(size(OUT) / 1024 / 1024).toFixed(1)} MB`);
