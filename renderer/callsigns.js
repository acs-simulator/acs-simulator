// Nominativi radio realistici: designatori ICAO e nominativi radiotelefonici reali delle compagnie
// (ICAO Doc 8585), scelti in base agli aeroporti di partenza e arrivo del volo.
// Il numero di volo è generato: non corrisponde a voli reali in orario.
import { AIRLINES, AIRLINES_BY_REGION } from './world.js';

const FALLBACK = ['RYR', 'EZY', 'WZZ', 'ITY'];

function randomFlightNumber(airline) {
  // i vettori low cost usano spesso numeri a 3-4 cifre, le compagnie di bandiera anche a 3
  const max = ['RYR', 'EZY', 'WZZ', 'VLG'].includes(airline) ? 9899 : 2999;
  return String(100 + Math.floor(Math.random() * (max - 100)));
}

function airlineFor(icao) {
  return AIRLINES_BY_REGION[icao?.slice(0, 2)] ?? null;
}

export function generateCallsign(origin, destination) {
  const fromOrigin = airlineFor(origin);
  const fromDest = airlineFor(destination);
  const pool = Math.random() < 0.6 ? fromOrigin ?? fromDest : fromDest ?? fromOrigin;
  const list = pool ?? FALLBACK;
  const airline = list[Math.floor(Math.random() * list.length)];
  const number = randomFlightNumber(airline);
  return {
    callsign: `${airline}${number}`,
    spoken: `${AIRLINES[airline]} ${number.split('').join(' ')}`,
  };
}
