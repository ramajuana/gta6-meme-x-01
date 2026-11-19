// make-meme.mjs — builds meme.png for the gta6-meme-x-01 entry.
//
// Everything here is Node 22 standard library only (node:fs, node:zlib).
// It draws the meme from scratch on a software canvas: a Vice City sunset,
// the make.fun mark (downloaded from https://make.fun/press/) as the sun,
// a hand-drawn make.fun ghost lounging on a beach towel, palm silhouettes,
// and big bitmap-font captions. It also contains a small PNG decoder (to read
// the mark) and a PNG encoder (to write the finished meme).
//
//   node tools/make-meme.mjs
//   -> writes meme.png in the repository root (1024 x 1024).

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// CRC32 (PNG chunks) and a tiny PNG encoder (filter 0 on every row).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// A small PNG decoder: 8-bit, colour types 2 (RGB) and 6 (RGBA), all filters.
// ---------------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth ${bitDepth} colourType ${colourType}`);
  }
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      recon[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = recon[x * channels];
      out[o + 1] = recon[x * channels + 1];
      out[o + 2] = recon[x * channels + 2];
      out[o + 3] = channels === 4 ? recon[x * channels + 3] : 255;
    }
    prev = recon;
  }
  return { data: out, width, height };
}

// ---------------------------------------------------------------------------
// Software canvas: RGBA buffer with alpha compositing and shape primitives.
// ---------------------------------------------------------------------------

function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

class Canvas {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.buf = Buffer.alloc(width * height * 4); // starts transparent black
  }

  setPixel(x, y, r, g, b, a = 255) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    if (a >= 255) {
      this.buf[o] = r;
      this.buf[o + 1] = g;
      this.buf[o + 2] = b;
      this.buf[o + 3] = 255;
      return;
    }
    const sa = a / 255;
    const da = this.buf[o + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    this.buf[o] = Math.round((r * sa + this.buf[o] * da * (1 - sa)) / outA);
    this.buf[o + 1] = Math.round((g * sa + this.buf[o + 1] * da * (1 - sa)) / outA);
    this.buf[o + 2] = Math.round((b * sa + this.buf[o + 2] * da * (1 - sa)) / outA);
    this.buf[o + 3] = Math.round(outA * 255);
  }

  fillRect(x, y, w, h, rgb, a = 255) {
    const [r, g, b] = rgb;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w));
    const y1 = Math.min(this.h, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.setPixel(xx, yy, r, g, b, a);
    }
  }

  fillCircle(cx, cy, rad, rgb, a = 255) {
    const [r, g, b] = rgb;
    const x0 = Math.max(0, Math.floor(cx - rad));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= rad * rad) this.setPixel(x, y, r, g, b, a);
      }
    }
  }

  // Even-odd scanline polygon fill. points: [[x, y], ...]
  fillPolygon(points, rgb, a = 255) {
    const [r, g, b] = rgb;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let y = Math.max(0, Math.ceil(minY)); y <= Math.min(this.h - 1, Math.floor(maxY)); y++) {
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.ceil(xs[i])); x <= Math.min(this.w - 1, Math.floor(xs[i + 1])); x++) {
          this.setPixel(x, y, r, g, b, a);
        }
      }
    }
  }

  // Thick line as a chain of circles (cheap and smooth enough for trunks).
  drawThickLine(x1, y1, x2, y2, rad, rgb, a = 255) {
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1)) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.fillCircle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, rad, rgb, a);
    }
  }

  // Vertical gradient band.
  vGradient(y0, y1, stops) {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++) {
      const t = (y - y0) / (y1 - y0);
      let i = 0;
      while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
      const [t0, c0] = stops[i];
      const [t1, c1] = stops[i + 1];
      const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
      const rgb = [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f));
      this.fillRect(0, y, this.w, 1, rgb);
    }
  }

  // Bilinear-resampled blit of a decoded PNG, alpha-composited.
  blitImage(img, dx, dy, dw, dh) {
    for (let y = 0; y < dh; y++) {
      const sy = ((y + 0.5) / dh) * img.height - 0.5;
      const y0 = Math.max(0, Math.floor(sy));
      const y1 = Math.min(img.height - 1, y0 + 1);
      const fy = Math.min(1, Math.max(0, sy - y0));
      for (let x = 0; x < dw; x++) {
        const sx = ((x + 0.5) / dw) * img.width - 0.5;
        const x0 = Math.max(0, Math.floor(sx));
        const x1 = Math.min(img.width - 1, x0 + 1);
        const fx = Math.min(1, Math.max(0, sx - x0));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (const [xx, yy, wgt] of [
          [x0, y0, (1 - fx) * (1 - fy)],
          [x1, y0, fx * (1 - fy)],
          [x0, y1, (1 - fx) * fy],
          [x1, y1, fx * fy],
        ]) {
          const o = (yy * img.width + xx) * 4;
          r += img.data[o] * wgt;
          g += img.data[o + 1] * wgt;
          b += img.data[o + 2] * wgt;
          a += img.data[o + 3] * wgt;
        }
        this.setPixel(dx + x, dy + y, Math.round(r), Math.round(g), Math.round(b), Math.round(a));
      }
    }
  }
}

// Star polygon points: n-pointed star centred at (cx, cy).
function starPoints(cx, cy, points, outerR, innerR, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? outerR : innerR;
    const ang = rot + (i * Math.PI) / points;
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Bitmap font: 5x7 glyphs, drawn as scaled blocks. Only the glyphs the meme
// needs, plus the full alphabet/digits for safety.
// ---------------------------------------------------------------------------

const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#..##', '#.#.#', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
};

function textWidth(text, scale) {
  return text.length * 6 * scale - scale;
}

// Draws text centred on cx at top y, in fill colour with a black outline.
function drawText(canvas, text, cx, y, scale, fillRgb) {
  const w = textWidth(text, scale);
  let x = Math.round(cx - w / 2);
  const outline = Math.max(2, Math.round(scale * 0.45));
  const black = [0, 0, 0];
  // Collect the filled pixels first, then outline them, then fill.
  const pixels = [];
  let gx = x;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === '#') {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              pixels.push([gx + col * scale + dx, y + row * scale + dy]);
            }
          }
        }
      }
    }
    gx += 6 * scale;
  }
  for (const [px, py] of pixels) {
    canvas.fillRect(px - outline, py - outline, outline * 2 + 1, outline * 2 + 1, black);
  }
  for (const [px, py] of pixels) canvas.setPixel(px, py, ...fillRgb);
}

// ---------------------------------------------------------------------------
// Scene pieces.
// ---------------------------------------------------------------------------

// make.fun's ghost, drawn from the mark: white body with a thick black
// outline, two black four-pointed sparkle eyes, a little round hand holding
// a magenta coin with a white star. (cx, bottomY) is the ghost's base;
// height is its full height in pixels.
function drawGhost(canvas, cx, bottomY, height) {
  const black = [25, 20, 25];
  const white = [255, 255, 255];
  const magenta = hexRgb('#c41c83');
  const topY = bottomY - height;
  const R = height * 0.36; // half-width of the body
  const midY = topY + height * 0.45;

  const bodyPoints = (grow) => {
    const pts = [];
    const ccx = cx;
    const ccy = midY;
    const rr = R * grow;
    // Head arc, left to right over the top.
    for (let a = Math.PI; a >= 0; a -= Math.PI / 24) {
      pts.push([ccx + Math.cos(a) * rr, ccy - Math.sin(a) * rr * 1.05]);
    }
    // Right side down to the wavy hem.
    pts.push([ccx + rr, bottomY - height * 0.10 * grow]);
    // Three scallops along the hem, bulging down.
    const hemY = bottomY - height * 0.10 * grow;
    const bump = height * 0.055 * grow;
    for (let s = 0; s < 3; s++) {
      const x0 = ccx + rr - (s * 2 * rr) / 3;
      const x1 = ccx + rr - ((s + 1) * 2 * rr) / 3;
      for (let t = 0; t <= 8; t++) {
        const f = t / 8;
        pts.push([x0 + (x1 - x0) * f, hemY + Math.sin(f * Math.PI) * bump]);
      }
    }
    // Left side back up to the head arc.
    pts.push([ccx - rr, ccy]);
    return pts;
  };

  canvas.fillPolygon(bodyPoints(1.07), black);
  canvas.fillPolygon(bodyPoints(1.0), white);

  // Sparkle eyes (four-pointed stars).
  const eyeR = height * 0.085;
  const eyeY = topY + height * 0.30;
  canvas.fillPolygon(starPoints(cx - R * 0.42, eyeY, 4, eyeR, eyeR * 0.28), black);
  canvas.fillPolygon(starPoints(cx + R * 0.42, eyeY - height * 0.01, 4, eyeR, eyeR * 0.28), black);

  // Little round hand on the right side, holding the star coin.
  const handX = cx + R * 0.98;
  const handY = topY + height * 0.62;
  canvas.fillCircle(handX, handY, height * 0.055, black);
  canvas.fillCircle(handX, handY, height * 0.038, white);
  const coinX = cx + R * 1.28;
  const coinY = topY + height * 0.66;
  canvas.fillCircle(coinX, coinY, height * 0.105, black);
  canvas.fillCircle(coinX, coinY, height * 0.088, magenta);
  canvas.fillPolygon(starPoints(coinX, coinY, 5, height * 0.062, height * 0.026), white);
}

// A palm silhouette: curved trunk with drooping fronds.
function drawPalm(canvas, baseX, baseY, height, lean, flip) {
  const dark = [22, 16, 34];
  const topX = baseX + lean;
  const topY = baseY - height;
  // Trunk: circles along a quadratic curve, tapering, overlapping so the
  // trunk reads as one solid line rather than a chain of beads.
  const steps = 110;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * baseX + 2 * (1 - t) * t * (baseX + lean * 0.2) + t * t * topX;
    const y = (1 - t) * (1 - t) * baseY + 2 * (1 - t) * t * (baseY - height * 0.55) + t * t * topY;
    canvas.fillCircle(x, y, 13 - 8 * t, dark);
  }
  // Fronds: long drooping leaves fanning from the crown.
  const crownX = topX;
  const crownY = topY;
  const frondAngles = flip
    ? [-160, -135, -105, -75, -45, -15, 10]
    : [160, 135, 105, 75, 45, 15, -10];
  for (const deg of frondAngles) {
    const a = (deg * Math.PI) / 180;
    const len = height * 0.42;
    const tipX = crownX + Math.cos(a) * len;
    const tipY = crownY + Math.sin(a) * len * 0.55 + height * 0.16;
    const midX = crownX + Math.cos(a) * len * 0.55;
    const midY = crownY + Math.sin(a) * len * 0.55 * 0.5 + height * 0.05;
    const wdt = height * 0.035;
    const px = -Math.sin(a);
    const py = Math.cos(a);
    canvas.fillPolygon(
      [
        [crownX + px * wdt, crownY + py * wdt],
        [midX + px * wdt * 0.7, midY + py * wdt * 0.7],
        [tipX, tipY],
        [midX - px * wdt * 0.7, midY - py * wdt * 0.7],
        [crownX - px * wdt, crownY - py * wdt],
      ],
      dark,
    );
  }
  // Coconuts under the crown.
  canvas.fillCircle(crownX - 12, crownY + 16, 9, dark);
  canvas.fillCircle(crownX + 10, crownY + 20, 8, dark);
}

// Deterministic pseudo-random (LCG) for sand speckles.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Compose the meme.
// ---------------------------------------------------------------------------

function build() {
  const canvas = new Canvas(W, H);

  // Sky: Vice City sunset — deep purple down to warm gold at the horizon.
  canvas.vGradient(0, 620, [
    [0, hexRgb('#2b1055')],
    [0.45, hexRgb('#7b1e6e')],
    [0.75, hexRgb('#c41c83')],
    [0.92, hexRgb('#ff7b3d')],
    [1, hexRgb('#ffd166')],
  ]);

  // The sun IS make.fun's mark: the magenta disc with the ghost inside,
  // pasted large so the ghost stays recognisable at 480 px.
  const mark = decodePng(readFileSync(join(ROOT, 'assets', 'mark-1024.png')));
  // Sanity: the mark's corners must be transparent (the disc floats on it).
  const cornerAlpha = mark.data[3];
  if (cornerAlpha !== 0) console.error('warning: mark corner is not transparent, alpha =', cornerAlpha);
  canvas.blitImage(mark, 712 - 145, 350 - 145, 290, 290);

  // Palm silhouettes framing the scene.
  drawPalm(canvas, 70, 640, 380, 90, false);
  drawPalm(canvas, 960, 640, 400, -100, true);

  // Ocean band with a few white wave dashes.
  canvas.vGradient(620, 770, [
    [0, hexRgb('#0e7490')],
    [1, hexRgb('#155e75')],
  ]);
  const waveWhite = [255, 255, 255];
  for (let row = 0; row < 3; row++) {
    const y = 648 + row * 38;
    for (let x = 20; x < W - 40; x += 90) {
      const wobble = Math.sin((x + row * 47) / 90) * 6;
      canvas.fillRect(x + row * 13, y + wobble, 46, 4, waveWhite, 200);
    }
  }

  // Sand.
  canvas.vGradient(770, H, [
    [0, hexRgb('#f2d8a7')],
    [1, hexRgb('#e0aa6e')],
  ]);
  const rng = makeRng(1337);
  const speckle = hexRgb('#c98f56');
  for (let i = 0; i < 260; i++) {
    canvas.fillCircle(20 + rng() * (W - 40), 790 + rng() * (H - 810), 2, speckle, 90);
  }

  // Big captions: the joke, readable at 480 px.
  const white = [255, 255, 255];
  drawText(canvas, 'WAITED 13 YEARS', W / 2, 44, 10, white);
  drawText(canvas, 'FOR GTA 6', W / 2, 138, 10, white);

  // Beach towel (magenta / white stripes) with the ghost lounging on it.
  const towelX = 140;
  const towelY = 890;
  const towelW = 380;
  const towelH = 95;
  const towelMagenta = hexRgb('#c41c83');
  for (let i = 0; i < 6; i++) {
    canvas.fillRect(towelX + (i * towelW) / 6, towelY, towelW / 6, towelH, i % 2 === 0 ? towelMagenta : white);
  }
  canvas.fillRect(towelX, towelY, towelW, 5, [25, 20, 25]);
  canvas.fillRect(towelX, towelY + towelH - 5, towelW, 5, [25, 20, 25]);

  // The ghost, sitting on the towel, coin in hand.
  drawGhost(canvas, 330, 972, 240);

  // Wooden sign stuck in the sand: the wait, dated.
  const signX = 620;
  const signY = 820;
  const signW = 330;
  const signH = 110;
  const wood = hexRgb('#8b5a2b');
  const woodLight = hexRgb('#a9713f');
  const woodDark = [60, 35, 15];
  canvas.fillRect(770, signY + signH, 26, 62, wood);
  canvas.fillRect(signX, signY, signW, signH, woodDark);
  canvas.fillRect(signX + 6, signY + 6, signW - 12, signH - 12, woodLight);
  drawText(canvas, 'RESERVED', signX + signW / 2, signY + 20, 4, [25, 20, 25]);
  drawText(canvas, 'SINCE 2013', signX + signW / 2, signY + 62, 4, [25, 20, 25]);

  writeFileSync(join(ROOT, 'meme.png'), encodePng(canvas.buf, W, H));
  console.log('wrote meme.png (1024x1024)');
}

build();
