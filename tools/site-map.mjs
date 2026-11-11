// Carta di sfondo del sito, disegnata dai dati del simulatore (renderer/data/chart.js):
//
//   node tools/site-map.mjs
//
// Costa, confini degli ACC e del Free Route, punti FRA: gli stessi del radar, in un SVG leggero
// (site/img/carta.svg) che la pagina mette, molto tenue, dietro a tutte le sezioni.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { COASTLINE, ACC_BOUNDARIES, FRA_BOUNDARY, FRA_POINTS } = await import(pathToFileURL(path.join(ROOT, 'renderer', 'data', 'chart.js')).href);

// proiezione equirettangolare centrata sull'Italia: abbastanza fedele a queste latitudini
const all = [...COASTLINE.flat(), ...ACC_BOUNDARIES.flat(), ...FRA_BOUNDARY.flat()];
const lats = all.map((p) => p[0]);
const lons = all.map((p) => p[1]);
const [latMin, latMax, lonMin, lonMax] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
const k = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
const SCALE = 100;   // unità SVG per grado di latitudine
const PAD = 20;
const X = (lon) => ((lon - lonMin) * k * SCALE + PAD).toFixed(1);
const Y = (lat) => ((latMax - lat) * SCALE + PAD).toFixed(1);
const W = ((lonMax - lonMin) * k * SCALE + PAD * 2).toFixed(0);
const H = ((latMax - latMin) * SCALE + PAD * 2).toFixed(0);

const line = (pts) => 'M' + pts.map(([la, lo]) => `${X(lo)} ${Y(la)}`).join('L');
const coast = COASTLINE.map(line).join('');
const acc = ACC_BOUNDARIES.map(line).join('');
const fra = FRA_BOUNDARY.map(line).join('');
// i punti FRA come piccoli triangoli, come sul radar
const tri = FRA_POINTS.map(([, la, lo]) => {
  const x = +X(lo), y = +Y(la);
  return `M${x.toFixed(1)} ${(y - 2.2).toFixed(1)}l1.9 3.3h-3.8z`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<path d="${fra}" fill="none" stroke="#6ec8ff" stroke-width="1.6" stroke-opacity=".55"/>
<path d="${acc}" fill="none" stroke="#7cfc9a" stroke-width="1.2" stroke-dasharray="6 5" stroke-opacity=".7"/>
<path d="${coast}" fill="none" stroke="#6ec8ff" stroke-width="1.1" stroke-opacity=".9"/>
<path d="${tri}" fill="none" stroke="#6ec8ff" stroke-width=".7" stroke-opacity=".7"/>
</svg>
`;
const out = path.join(ROOT, 'site', 'img', 'carta.svg');
fs.writeFileSync(out, svg);
console.log(`${path.relative(ROOT, out)}  ${W}x${H}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
