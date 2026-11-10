#!/usr/bin/env python3
"""Genera renderer/data/procedures.js: SID, STAR e piste degli aeroporti italiani della simulazione.

Fonti (scaricate a ogni esecuzione, AIRAC corrente):
  - IVAO Italia, settore Aurora (github.com/ivao-italy/it-aurora-sector):
      Include/IT/<icao>.str   STAR: designatore, piste, sequenza dei fix
      Include/IT/<icao>.sid   SID: designatore, piste, eventuale transizione e punto finale
      Include/IT/NAVAIDS/*    coordinate di fix, VOR e NDB
      Include/IT/OTHER/itrw.rw soglie e prue delle piste
  - VATITA, mappe TopSky (github.com/vatsim-italy/VATITA-GNG-Files, Plugins/Topsky/TopSkyMaps.txt):
      vincoli di livello sui punti iniziali delle STAR (pubblicati solo per LIRF).

I dati derivano dall'AIP Italia (ENAV) come trascritti dalle due divisioni virtuali; le SID nelle fonti
hanno solo designatore e punto finale (niente tracciato intermedio), le STAR la sequenza completa dei fix.

Uso:  python3 tools/procedures/build_procedures.py [--refresh] [--cache DIR]
      i file scaricati restano in tools/procedures/.cache (fonti consultabili anche offline);
      --refresh li riscarica (nuovo AIRAC).
"""
import argparse
import json
import math
import os
import re
import sys
import urllib.request

IVAO = 'https://raw.githubusercontent.com/ivao-italy/it-aurora-sector/master/SectorFiles/Include/IT'
TOPSKY = 'https://raw.githubusercontent.com/vatsim-italy/VATITA-GNG-Files/HEAD/Plugins/Topsky/TopSkyMaps.txt'

# aeroporti italiani della simulazione (renderer/world.js) con la configurazione piste più usata:
# arr/dep = piste in uso per arrivi e partenze nella configurazione prevalente; la simulazione usa quella
# opposta in una parte delle sessioni (vento contrario).
AIRPORTS = {
    'LIRF': {'arr': ['16L', '16R'], 'dep': ['25'], 'alt': {'arr': ['34L', '34R'], 'dep': ['25']}},
    'LIRA': {'arr': ['15'], 'dep': ['15']},
    'LIRN': {'arr': ['24'], 'dep': ['24']},
    'LIRI': {'arr': ['05'], 'dep': ['05']},
    'LIRP': {'arr': ['03R'], 'dep': ['03L']},
    'LIRQ': {'arr': ['05'], 'dep': ['05']},
    'LIRZ': {'arr': ['01'], 'dep': ['01']},
    'LIBP': {'arr': ['22'], 'dep': ['22']},
    'LIEE': {'arr': ['32'], 'dep': ['32']},
    'LIEO': {'arr': ['05'], 'dep': ['05']},
    'LIEA': {'arr': ['20'], 'dep': ['20']},
    'LICJ': {'arr': ['25'], 'dep': ['20']},
    'LICC': {'arr': ['08'], 'dep': ['08']},
    'LICT': {'arr': ['31L'], 'dep': ['31L']},
    'LICA': {'arr': ['28'], 'dep': ['28']},
    'LICR': {'arr': ['15'], 'dep': ['15']},
    'LIMC': {'arr': ['35L', '35R'], 'dep': ['35L', '35R']},
    'LIML': {'arr': ['35'], 'dep': ['35']},
    'LIME': {'arr': ['28'], 'dep': ['28']},
    'LIMF': {'arr': ['36'], 'dep': ['36']},
    'LIMZ': {'arr': ['21'], 'dep': ['21']},
    'LIMJ': {'arr': ['28'], 'dep': ['28']},
    'LIPX': {'arr': ['04'], 'dep': ['04']},
    'LIPO': {'arr': ['32'], 'dep': ['32']},
    'LSZA': {'arr': ['01'], 'dep': ['01']},
    'LIPZ': {'arr': ['04R'], 'dep': ['04R']},
    'LIPE': {'arr': ['12'], 'dep': ['12']},
    'LIBD': {'arr': ['07'], 'dep': ['07']},
    'LIBR': {'arr': ['31'], 'dep': ['31']},
}

NAVAID_FILES = ['NAVAIDS/itfix.fix', 'NAVAIDS/APT.fix', 'NAVAIDS/secsi.fix', 'NAVAIDS/ESTERNI.fix',
                'NAVAIDS/MIL.fix', 'NAVAIDS/VFR_NASCOSTI.fix', 'NAVAIDS/itvor.vor', 'NAVAIDS/itndb.ndb']
MAX_FIX_NM = 160      # un fix di procedura sta entro questa distanza dal suo aeroporto
SID_PREFIX_NM = 90    # nomi abbreviati delle SID (SOSA5A, IRK7A): fix con quel prefisso entro questa distanza
SID_ALIASES = {'SIV': 'SOSIV'}  # abbreviazioni che non sono l'inizio del nome (LIRF SIV5A-SOV1E = SOSIV 5A)


def fetch(url, cache):
    path = os.path.join(cache, url.rsplit('/', 1)[-1] if 'TopSky' in url else url.split('/IT/', 1)[-1].replace('/', '_'))
    if not os.path.exists(path):
        with urllib.request.urlopen(url) as r:
            data = r.read()
        with open(path, 'wb') as f:
            f.write(data)
    with open(path, encoding='latin-1') as f:
        return f.read()


def dms(s):
    m = re.match(r'([NSEW])(\d{3})\.(\d{2})\.(\d{2})\.(\d+)', s.strip())
    if not m:
        return None
    h, d, mi, se, frac = m.groups()
    v = int(d) + int(mi) / 60 + float(f'{se}.{frac}') / 3600
    return -v if h in 'SW' else v


def nm(a, b):
    lat = math.radians((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * 60, (a[1] - b[1]) * 60 * math.cos(lat))


def load_navaids(cache):
    db = {}  # nome -> [(lat, lon, tipo)]
    for f in NAVAID_FILES:
        kind = 'vor' if f.endswith('.vor') else 'ndb' if f.endswith('.ndb') else 'fix'
        for line in fetch(f'{IVAO}/{f}', cache).splitlines():
            if line.startswith('//') or ';' not in line:
                continue
            p = line.split(';')
            coords = [dms(x) for x in p[1:5]]
            coords = [c for c in coords if c is not None]
            if len(coords) < 2:
                continue
            name = p[0].strip()
            entry = (round(coords[0], 5), round(coords[1], 5), kind)
            if entry not in db.setdefault(name, []):
                db[name].append(entry)
    return db


def num(s):
    try:
        return float(s)
    except ValueError:
        return 0.0


def load_runways(cache):
    rw = {}
    for line in fetch(f'{IVAO}/OTHER/itrw.rw', cache).splitlines():
        p = line.split(';')
        if len(p) < 11 or p[1] == 'MAPS':
            continue
        icao, r1, r2 = p[0], p[1], p[2]
        a = (dms(p[7]), dms(p[8]))
        b = (dms(p[9]), dms(p[10]))
        if None in a or None in b:
            continue
        rwys = rw.setdefault(icao, {})
        rwys[r1] = {'thr': [round(a[0], 5), round(a[1], 5)], 'end': [round(b[0], 5), round(b[1], 5)],
                    'hdg': num(p[5]), 'elev': int(num(p[3]))}
        rwys[r2] = {'thr': [round(b[0], 5), round(b[1], 5)], 'end': [round(a[0], 5), round(a[1], 5)],
                    'hdg': num(p[6]), 'elev': int(num(p[4]))}
    return rw


class Resolver:
    """Coordinate dei fix di un aeroporto: fra gli omonimi quello più vicino all'aeroporto."""

    def __init__(self, db, ref):
        self.db, self.ref, self.used = db, ref, {}
        self.missing = set()

    def fix(self, name):
        cands = [c for c in self.db.get(name, []) if nm(c, self.ref) <= MAX_FIX_NM]
        if not cands:
            self.missing.add(name)
            return None
        c = min(cands, key=lambda c: nm(c, self.ref))
        self.used[name] = [c[0], c[1]]
        return name

    def prefix(self, pre):
        """Fix il cui nome inizia con pre (i designatori abbreviati delle SID): prima un VOR/NDB con quel
        nome esatto, poi il fix di 5 lettere più vicino all'aeroporto."""
        if pre in SID_ALIASES:
            return self.fix(SID_ALIASES[pre])
        exact = [c for c in self.db.get(pre, []) if nm(c, self.ref) <= SID_PREFIX_NM]
        if exact:
            return self.fix(pre)
        best = None
        for name, cands in self.db.items():
            if not name.startswith(pre) or len(name) != 5:
                continue
            for c in cands:
                d = nm(c, self.ref)
                if d <= SID_PREFIX_NM and (best is None or d < best[0]):
                    best = (d, name)
        if not best:
            self.missing.add(pre + '*')
            return None
        return self.fix(best[1])


def runways(field):
    return [r for r in field.replace('/', ':').split(':') if re.match(r'^\d{2}[LRC]?$', r)]


STAR_NAME = re.compile(r'^([A-Z]{2,5})(\d[A-Z])$')
SID_PART = re.compile(r'^([A-Z]{2,5})(\d[A-Z])$')


def parse_stars(icao, text, res):
    stars = []
    cur = None
    for raw in text.splitlines() + ['']:
        line = raw.strip()
        p = [x.strip() for x in line.split(';')]
        header = len(p) > 3 and p[0] == icao
        if header or not line:
            if cur and len(cur['fixes']) >= 2:
                stars.append(cur)
            cur = None
        if header:
            m = STAR_NAME.match(p[2])
            if 'MAPS' in p[1] or not m:
                continue
            cur = {'code': p[2], 'rwy': runways(p[1]), 'fixes': [], 'suffix': m.group(2), 'pre': m.group(1)}
            continue
        if cur is None or not line:
            continue
        name = p[0].lstrip('/').strip()
        if not re.match(r'^[A-Z0-9]{2,5}$', name):
            continue  # punto anonimo (coordinate) o riga non riconosciuta
        if cur['fixes'] and cur['fixes'][-1] == name:
            continue
        if res.fix(name):
            cur['fixes'].append(name)
    out = []
    seen = set()
    for s in stars:
        first = s['fixes'][0]
        if not first.startswith(s['pre']):
            # designatore che non comincia dal primo fix (raro): si cerca il fix con quel prefisso
            idx = next((i for i, f in enumerate(s['fixes']) if f.startswith(s['pre'])), None)
            if idx is None:
                continue
            s['fixes'] = s['fixes'][idx:]
            first = s['fixes'][0]
        key = (first + s['suffix'], tuple(s['rwy']))
        if key in seen:
            continue
        seen.add(key)
        out.append({'id': f"{first} {s['suffix']}", 'rwy': s['rwy'], 'fixes': s['fixes']})
    return out


def parse_sids(icao, text, res):
    sids = []
    seen = set()
    for raw in text.splitlines():
        line = raw.split('//')[0].strip()
        p = [x.strip() for x in line.split(';')]
        if len(p) < 3 or p[0] != icao:
            continue
        parts = re.split(r'[-\s]+', p[2])
        m1 = SID_PART.match(parts[0])
        if not m1:
            continue
        first = res.prefix(m1.group(1))
        if not first:
            continue
        sid = {'id': f'{first} {m1.group(2)}', 'rwy': runways(p[1]), 'fixes': [first]}
        if len(parts) > 1:
            m2 = SID_PART.match(parts[1])
            final = p[6] if len(p) > 6 and p[6] else None
            final = res.fix(final) if final else (res.prefix(m2.group(1)) if m2 else None)
            if not m2 or not final:
                continue
            sid['transition'] = f'{final} {m2.group(2)}'
            if final != first:
                sid['fixes'].append(final)
        key = (sid['id'], sid.get('transition'), tuple(sid['rwy']))
        if key in seen:
            continue
        seen.add(key)
        sids.append(sid)
    return sids


def star_levels(topsky):
    """Vincoli di livello (FL) sui fix delle STAR dalle mappe TopSky: {icao: {pista: {fix: {min,max}}}}."""
    out = {}
    icao = rwys = None
    for line in topsky.splitlines():
        if line.startswith('MAP:'):
            m = re.match(r'MAP:(\w{4}) STARs .*?([\d/LRC ]+)$', line)
            icao = m.group(1) if m else None
            rwys = runways(m.group(2).strip().replace(' ', ':')) if m else None
        elif icao and line.startswith('TEXT:'):
            p = line.split(':')
            m = re.match(r'^(\d{2,3})([+-]?)(?:-(\d{2,3}))?$', p[2])
            if not m:
                continue
            hi, sign, lo = m.groups()
            c = {'min': int(lo), 'max': int(hi)} if lo else {'min': int(hi)} if sign == '+' \
                else {'max': int(hi)} if sign == '-' else {'min': int(hi), 'max': int(hi)}
            for r in rwys:
                out.setdefault(icao, {}).setdefault(r, {})[p[1]] = c
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(os.path.dirname(__file__), '.cache'))
    ap.add_argument('--refresh', action='store_true', help='riscarica le fonti ignorando la cache')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', '..', 'renderer', 'data', 'procedures.js'))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    if args.refresh:
        for name in os.listdir(args.cache):
            os.remove(os.path.join(args.cache, name))

    db = load_navaids(args.cache)
    rwdb = load_runways(args.cache)
    levels = star_levels(fetch(TOPSKY, args.cache))

    fixes = {}
    procs = {}
    report = []
    for icao, cfg in AIRPORTS.items():
        rw = rwdb.get(icao, {})
        if not rw:
            print(f'{icao}: piste mancanti', file=sys.stderr)
            continue
        ref = tuple(sum(r['thr'][i] for r in rw.values()) / len(rw) for i in (0, 1))
        res = Resolver(db, ref)
        stars = parse_stars(icao, fetch(f'{IVAO}/{icao.lower()}.str', args.cache), res)
        sids = parse_sids(icao, fetch(f'{IVAO}/{icao.lower()}.sid', args.cache), res)
        lv = levels.get(icao, {})
        for s in stars:
            c = next((lv[r][s['fixes'][0]] for r in s['rwy'] if r in lv and s['fixes'][0] in lv[r]), None)
            if c:
                s['level'] = c
        for name, c in res.used.items():
            old = fixes.get(name)
            if old and nm(old, c) > 1:
                print(f'{icao}: omonimo {name} a {nm(old, c):.0f} NM, tengo il primo', file=sys.stderr)
                continue
            fixes[name] = c
        procs[icao] = {
            'runways': {k: rw[k] for k in sorted(rw)},
            'config': {k: cfg[k] for k in ('arr', 'dep')},
            **({'altConfig': cfg['alt']} if 'alt' in cfg else {}),
            'sids': sids,
            'stars': stars,
        }
        report.append(f'{icao}: {len(sids)} SID, {len(stars)} STAR'
                      + (f"  (fix non trovati: {' '.join(sorted(res.missing))})" if res.missing else ''))

    def js(v):
        return json.dumps(v, separators=(',', ':'))

    lines = [
        '// SID, STAR e piste degli aeroporti italiani della simulazione (AIP Italia, AIRAC corrente),',
        '// trascritti dal settore Aurora di IVAO Italia (github.com/ivao-italy/it-aurora-sector) e, per i livelli',
        '// sui punti iniziali delle STAR, dalle mappe TopSky di VATITA (github.com/vatsim-italy/VATITA-GNG-Files).',
        '// File generato da tools/procedures/build_procedures.py: non modificare a mano.',
        '//',
        '// PROC_FIXES: nome -> [lat, lon] di tutti i fix usati dalle procedure.',
        '// PROCEDURES[icao]:',
        '//   runways  pista -> { thr: soglia [lat, lon], end: soglia opposta, hdg: prua vera, elev: ft }',
        '//   config   piste in uso nella configurazione prevalente (arr/dep); altConfig, se c\'è, per il vento opposto',
        '//   sids     { id: "SOSAK 5A", rwy: [...], fixes: [primo fix, punto finale], transition?: "ESINO 8H" }',
        '//            le fonti hanno solo designatore e punto finale: il tracciato va dalla pista ai fix elencati',
        '//   stars    { id: "VALMA 3A", rwy: [...], fixes: [punto iniziale ... ultimo fix], level?: { min, max } FL }',
        '',
        f'export const PROC_FIXES = {{',
    ]
    for name in sorted(fixes):
        lines.append(f'  {json.dumps(name)}: {js(fixes[name])},')
    lines.append('};')
    lines.append('')
    lines.append('export const PROCEDURES = {')
    for icao, p in procs.items():
        lines.append(f'  {icao}: {{')
        lines.append(f"    runways: {js(p['runways'])},")
        lines.append(f"    config: {js(p['config'])},")
        if 'altConfig' in p:
            lines.append(f"    altConfig: {js(p['altConfig'])},")
        lines.append('    sids: [')
        for s in p['sids']:
            lines.append(f'      {js(s)},')
        lines.append('    ],')
        lines.append('    stars: [')
        for s in p['stars']:
            lines.append(f'      {js(s)},')
        lines.append('    ],')
        lines.append('  },')
    lines.append('};')
    with open(args.out, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    print('\n'.join(report))
    print(f'{len(fixes)} fix -> {os.path.normpath(args.out)}')


if __name__ == '__main__':
    main()
