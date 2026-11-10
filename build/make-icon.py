#!/usr/bin/env python3
"""Icona dell'applicazione (build/icon.png, 1024x1024), da cui electron-builder ricava .icns e .ico.

Disegna uno schermo radar con i colori dell'interfaccia: fondo blu-nero, cerchi di distanza ciano,
una traccia verde con la scia e il tag collegato dalla linea guida. Nessuna dipendenza: il PNG viene
scritto a mano con zlib. Si rigenera con  python3 build/make-icon.py
"""
import math
import struct
import zlib

S = 1024
BG = (5, 11, 18)
PANEL = (10, 20, 32)
CYAN = (120, 170, 180)
GREEN = (124, 252, 154)
BLUE = (110, 200, 255)

buf = bytearray(S * S * 4)


def blend(x, y, rgb, a):
    if a <= 0 or x < 0 or y < 0 or x >= S or y >= S:
        return
    if a > 1:
        a = 1.0
    i = (y * S + x) * 4
    for k in range(3):
        buf[i + k] = int(buf[i + k] * (1 - a) + rgb[k] * a + 0.5)
    buf[i + 3] = int(buf[i + 3] * (1 - a) + 255 * a + 0.5)


def cover(d, half=0.75):
    """Copertura antialiasata da una distanza con segno (negativa = dentro)."""
    if d <= -half:
        return 1.0
    if d >= half:
        return 0.0
    return (half - d) / (2 * half)


def rounded_rect(x0, y0, x1, y1, r, rgb, a=1.0, width=None):
    """Rettangolo arrotondato pieno, oppure con un contorno spesso `width`."""
    for y in range(max(0, int(y0 - 2)), min(S, int(y1 + 3))):
        for x in range(max(0, int(x0 - 2)), min(S, int(x1 + 3))):
            dx = max(x0 + r - x, 0, x - (x1 - r))
            dy = max(y0 + r - y, 0, y - (y1 - r))
            d = math.hypot(dx, dy) - r
            c = cover(d) if width is None else cover(abs(d + width / 2) - width / 2)
            if c > 0:
                blend(x, y, rgb, c * a)


def ring(cx, cy, radius, width, rgb, a=1.0, start=None, end=None):
    lo = int(cy - radius - width), int(cy + radius + width + 2)
    for y in range(max(0, lo[0]), min(S, lo[1])):
        for x in range(max(0, int(cx - radius - width)), min(S, int(cx + radius + width + 2))):
            d = math.hypot(x - cx, y - cy) - radius
            c = cover(abs(d) - width / 2)
            if c <= 0:
                continue
            if start is not None:
                ang = math.degrees(math.atan2(x - cx, cy - y)) % 360
                if not (start <= ang <= end):
                    continue
            blend(x, y, rgb, c * a)


def disc(cx, cy, radius, rgb, a=1.0):
    for y in range(max(0, int(cy - radius - 2)), min(S, int(cy + radius + 3))):
        for x in range(max(0, int(cx - radius - 2)), min(S, int(cx + radius + 3))):
            c = cover(math.hypot(x - cx, y - cy) - radius)
            if c > 0:
                blend(x, y, rgb, c * a)


def line(x0, y0, x1, y1, width, rgb, a=1.0):
    vx, vy = x1 - x0, y1 - y0
    length = math.hypot(vx, vy)
    for y in range(max(0, int(min(y0, y1) - width - 2)), min(S, int(max(y0, y1) + width + 3))):
        for x in range(max(0, int(min(x0, x1) - width - 2)), min(S, int(max(x0, x1) + width + 3))):
            t = max(0.0, min(1.0, ((x - x0) * vx + (y - y0) * vy) / (length * length)))
            d = math.hypot(x - (x0 + vx * t), y - (y0 + vy * t)) - width / 2
            c = cover(d)
            if c > 0:
                blend(x, y, rgb, c * a)


# --- fondo: quadrato arrotondato con un alone al centro ------------------------
rounded_rect(0, 0, S - 1, S - 1, 210, BG)
cx = cy = S / 2
for r in range(430, 0, -10):
    disc(cx, cy, r, PANEL, 0.035)
rounded_rect(6, 6, S - 7, S - 7, 206, CYAN, 0.22, width=7)

# --- schermo radar: cerchi di distanza e croce centrale ------------------------
ring(cx, cy, 392, 6, CYAN, 0.55)
ring(cx, cy, 268, 4, CYAN, 0.30)
ring(cx, cy, 144, 4, CYAN, 0.22)
for a0 in (0, 90, 180, 270):
    rad = math.radians(a0)
    line(cx + math.sin(rad) * 128, cy - math.cos(rad) * 128,
         cx + math.sin(rad) * 160, cy - math.cos(rad) * 160, 7, CYAN, 0.45)

# --- settore di competenza: uno spicchio appena accennato ----------------------
ring(cx, cy, 392, 10, BLUE, 0.35, start=18, end=104)

# --- traccia in contatto: scia, punto, linea guida e tag -----------------------
hdg = math.radians(62)
tx, ty = cx - 118, cy + 86
for k, (rad, alpha) in enumerate(((118, 0.30), (84, 0.45), (50, 0.65))):
    disc(tx - math.sin(hdg) * rad, ty + math.cos(hdg) * rad, 11 + k * 2, GREEN, alpha)
disc(tx, ty, 26, GREEN)
line(tx, ty, tx + 150, ty - 150, 9, GREEN, 0.9)
rounded_rect(tx + 150, ty - 232, tx + 374, ty - 194, 8, GREEN, 0.95)
rounded_rect(tx + 150, ty - 176, tx + 306, ty - 144, 8, GREEN, 0.55)

# --- scrittura del PNG ---------------------------------------------------------
raw = bytearray()
for y in range(S):
    raw.append(0)
    raw.extend(buf[y * S * 4:(y + 1) * S * 4])


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
       + chunk(b'IEND', b''))

with open(__file__.replace('make-icon.py', 'icon.png'), 'wb') as f:
    f.write(png)
print(f'build/icon.png {S}x{S}, {len(png) // 1024} KB')
