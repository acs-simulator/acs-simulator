// Geometria di base sul piano locale in miglia nautiche (x verso est, y verso sud).

export function normalizeDeg(d) {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
}

export function angleDiff(target, current) {
  return normalizeDeg(target - current + 180) - 180;
}

export function bearing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Proiezione equirettangolare centrata sul settore: sulle dimensioni di un settore ACC
// l'errore di scala resta nell'ordine del 2-3%.
export function makeProjection(lat0, lon0) {
  const kx = 60 * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (lat, lon) => ({ x: (lon - lon0) * kx, y: -(lat - lat0) * 60 }),
    toLatLon: (x, y) => ({ lat: lat0 - y / 60, lon: lon0 + x / kx }),
  };
}

// poly: array di {x, y}
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return Math.abs(s) / 2;
}

export function polygonCentroid(poly) {
  const n = poly.length;
  return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
}

export function boundingBox(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
}

export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolygon(p, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, distanceToSegment(p, poly[j], poly[i]));
  }
  return best;
}

// Intersezione fra i segmenti ab e cd: restituisce {t, u, x, y} oppure null.
export function segmentIntersection(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: a.x + t * rx, y: a.y + t * ry };
}
