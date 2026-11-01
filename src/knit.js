// Procedural knitted-yarn materials.
//
// One height field per stitch kind is painted once on a 512x512 tile, then turned into
// a normal map, an AO-baked grayscale albedo and a roughness map. Textures are cached and
// shared; each material clones them (clone shares the pixel data) to get its own repeat.
//
// Tile layout (stitches per tile), so callers can pick `repeat` for ~0.1 unit stitches:
//   stockinette 4 columns x 5 rows   rib 4 x 5 (2 knit + 2 purl columns)
//   garter      4 columns x 6 ridges seed 8 x 8
//   cable       8 columns x 8 rows (two 3-stitch cable columns + 1-stitch purl ditches, ropes cross every 4 rows)
//   boucle      ~7 curls across      strand: u runs along the strand, 2 plies-twists per tile
//
// Colorwork: yarnMaterial({ color, color2, pattern: 'stripe' | 'check' | 'fairisle' }) works on the
// stitch kinds that have a stitch grid (all but boucle and strand). The color map covers 4x4 base tiles
// on a 1024 canvas; every stitch cell gets color or color2 by the pattern and is multiplied by the
// grayscale stitch albedo, so color boundaries follow stitches. map.repeat = repeat / 4.
import * as THREE from 'three';

const SIZE = 512;
const N = SIZE * SIZE;
const wrap = (i) => i & (SIZE - 1);
const TAU = Math.PI * 2;

// ---------- small utilities ----------

function hash2(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1440670441)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const linearToSRGB = (c) => {
  c = clamp01(c);
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

// Periodic separable box blur.
function boxBlur(src, r, passes = 1) {
  let cur = src;
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(N);
    const out = new Float32Array(N);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += cur[y * SIZE + wrap(x + k)];
        tmp[y * SIZE + x] = s * inv;
      }
    }
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += tmp[wrap(y + k) * SIZE + x];
        out[y * SIZE + x] = s * inv;
      }
    }
    cur = out;
  }
  return cur;
}

// ---------- height field painting ----------

// top: yarn on the surface, base: broad underlying shape (added to top), bright: per-loop tone offset
const newField = () => ({
  top: new Float32Array(N),
  base: new Float32Array(N),
  bright: new Float32Array(N),
});

// Paint a plump, optionally plied yarn segment (a capsule) with wrap-around.
// Coordinates and radius are in pixels; lambda is the ply twist period along the segment in pixels.
function paintCapsule(f, ax, ay, bx, by, r, o = {}) {
  const {
    amp = 1, plies = 0, lambda = 40, phase = 0, plyDepth = 0.3,
    taper = true, base = false, bright = 0, exponent = 0.5,
  } = o;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  const x0 = Math.floor(Math.min(ax, bx) - r) - 1;
  const x1 = Math.ceil(Math.max(ax, bx) + r) + 1;
  const y0 = Math.floor(Math.min(ay, by) - r) - 1;
  const y1 = Math.ceil(Math.max(ay, by) + r) + 1;
  const target = base ? f.base : f.top;

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const qx = px + 0.5 - ax;
      const qy = py + 0.5 - ay;
      const s = len2 > 0 ? Math.min(1, Math.max(0, (qx * dx + qy * dy) / len2)) : 0;
      const ex = qx - s * dx;
      const ey = qy - s * dy;
      const d = Math.sqrt(ex * ex + ey * ey) / r;
      if (d >= 1) continue;

      let val = Math.pow(1 - d * d, exponent); // round cross-section
      if (taper) val *= 0.4 + 0.6 * Math.pow(Math.sin(Math.PI * s), 0.6); // ends dive under neighbours
      if (plies > 0) {
        // ply ridges wrap around the strand; the twist makes the grooves run diagonally
        const side = dx * qy - dy * qx >= 0 ? 1 : -1;
        const u = (plies * Math.asin(d) * side) / TAU + (s * len) / lambda + phase;
        const g = u - Math.floor(u) - 0.5;
        const ply = Math.sqrt(Math.max(0, 1 - 4 * g * g * 0.96));
        val *= 1 - plyDepth + plyDepth * ply;
      }
      val *= amp;

      const i = wrap(py) * SIZE + wrap(px);
      if (val > target[i]) {
        target[i] = val;
        if (!base) f.bright[i] = bright;
      }
    }
  }
}

// ---------- stitch painters (cell coordinates: sx, sy = cell size in px) ----------

// Knit stitch: a V made of two plied legs that meet at the bottom and dive under the next row.
function knitV(f, cx, cy, sx, sy, amp = 1) {
  const X = cx * sx;
  const Y = cy * sy;
  const r = 0.21 * sx;
  for (const side of [-1, 1]) {
    const k = side < 0 ? 1 : 2;
    const j = (n) => hash2(cx, cy, k * 10 + n) - 0.5;
    paintCapsule(
      f,
      X + (0.5 + 0.07 * side + 0.02 * j(0)) * sx, Y - 0.06 * sy,
      X + (0.5 + 0.27 * side + 0.02 * j(1)) * sx, Y + 1.08 * sy,
      r,
      { amp: amp * (1 + 0.1 * j(2)), plies: 3, lambda: 0.5 * sy, phase: j(3), bright: j(4) * 0.08 },
    );
  }
}

// Purl stitch: a plump horizontal bar with a smaller bar above it.
function purlBump(f, cx, cy, sx, sy, amp = 1) {
  const X = cx * sx;
  const Y = cy * sy;
  const j = (n) => hash2(cx, cy, 50 + n) - 0.5;
  paintCapsule(
    f,
    X + 0.14 * sx, Y + (0.31 + 0.03 * j(1)) * sy,
    X + 0.86 * sx, Y + (0.34 + 0.03 * j(2)) * sy,
    0.26 * sy,
    { amp: amp * (1 + 0.1 * j(3)), plies: 3, lambda: 0.45 * sx, phase: j(4), bright: j(5) * 0.08, taper: false },
  );
  paintCapsule(
    f,
    X + 0.24 * sx, Y + (0.8 + 0.02 * j(6)) * sy,
    X + 0.76 * sx, Y + (0.78 + 0.02 * j(7)) * sy,
    0.15 * sy,
    { amp: amp * 0.6, plies: 2, lambda: 0.35 * sx, phase: j(8), bright: j(5) * 0.08, taper: false },
  );
}

function buildGrid(cols, rows, cellFn) {
  const f = newField();
  const sx = SIZE / cols;
  const sy = SIZE / rows;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) cellFn(f, cx, cy, sx, sy);
  }
  return f;
}

const buildStockinette = () => buildGrid(4, 5, (f, cx, cy, sx, sy) => knitV(f, cx, cy, sx, sy, 1));

const buildGarter = () => buildGrid(4, 6, (f, cx, cy, sx, sy) => purlBump(f, cx, cy, sx, sy, 1));

// Seed stitch reads as a pebbly field of small purl nubs, offset half a cell on alternate rows.
const buildSeed = () =>
  buildGrid(8, 8, (f, cx, cy, sx, sy) => {
    const X = (cx + (cy % 2) * 0.5) * sx;
    const Y = cy * sy;
    const j = (n) => hash2(cx, cy, 70 + n) - 0.5;
    paintCapsule(
      f,
      X + (0.24 + 0.04 * j(0)) * sx, Y + (0.5 + 0.06 * j(1)) * sy,
      X + (0.76 + 0.04 * j(2)) * sx, Y + (0.5 + 0.06 * j(3)) * sy,
      0.36 * sy,
      { amp: 1 + 0.12 * j(4), plies: 3, lambda: 0.4 * sx, phase: j(5), bright: j(6) * 0.08, taper: false },
    );
  });

const buildRib = () =>
  buildGrid(4, 5, (f, cx, cy, sx, sy) => {
    if (cx < 2) {
      // raised knit column: a broad rounded ridge under the V legs
      const X = cx * sx;
      const Y = cy * sy;
      paintCapsule(f, X + 0.5 * sx, Y - 0.5 * sy, X + 0.5 * sx, Y + 1.5 * sy, 0.78 * sx, {
        amp: 0.5, base: true, taper: false, exponent: 0.35,
      });
      knitV(f, cx, cy, sx, sy, 0.7);
    } else {
      purlBump(f, cx, cy, sx, sy, 0.4); // recessed purl column
    }
  });

// Cable: in each 3-stitch column two 1.5-stitch ropes trade places over 2 rows, hold 2 rows, and trade back.
// The rope that crosses on top is painted higher. The second column crosses half a period later.
const CABLE_PERIOD = 8;
const crossAmount = (y) => {
  const p = ((y % CABLE_PERIOD) + CABLE_PERIOD) % CABLE_PERIOD;
  if (p < 2) return 0;
  if (p < 4) return smoothstep(0, 1, (p - 2) / 2);
  if (p < 6) return 1;
  return 1 - smoothstep(0, 1, (p - 6) / 2);
};

function buildCable() {
  const f = newField();
  const sx = SIZE / 8;
  const sy = SIZE / 8;
  for (let col = 0; col < 2; col++) {
    const x0 = col * 4; // cable cells x0..x0+2, purl ditch at x0+3
    paintCapsule(f, (x0 + 1.5) * sx, -sy, (x0 + 1.5) * sx, 9 * sy, 1.4 * sx, {
      amp: 0.5, base: true, taper: false, exponent: 0.35,
    });
    for (let cy = 0; cy < 8; cy++) {
      const y = cy + 0.5 + col * 4;
      const k = crossAmount(y);
      const p = ((y % CABLE_PERIOD) + CABLE_PERIOD) % CABLE_PERIOD;
      const crossing = p >= 2 && p < 4 ? 1 : p >= 6 ? -1 : 0; // 1: rope A on top, -1: rope B on top
      const ampA = crossing > 0 ? 1.12 : crossing < 0 ? 0.88 : 1;
      const ampB = crossing < 0 ? 1.12 : crossing > 0 ? 0.88 : 1;
      const ca = 0.75 + 1.5 * k;
      const cb = 2.25 - 1.5 * k;
      for (const d of [-0.3, 0.3]) {
        knitV(f, x0 + ca + d - 0.5, cy, sx, sy, ampA);
        knitV(f, x0 + cb + d - 0.5, cy, sx, sy, ampB);
      }
      purlBump(f, x0 + 3, cy, sx, sy, 0.4);
    }
  }
  return f;
}

// Curly loops: many partial rings of two sizes, drawn with wrap-around.
function buildBoucle() {
  const f = newField();
  f.base.fill(0.1);
  const rng = mulberry32(1337);
  const layers = [
    { count: 520, R: [9, 18], w: [4, 6.5] },
    { count: 1400, R: [4, 9], w: [2.2, 3.6] },
  ];
  for (const L of layers) {
    for (let n = 0; n < L.count; n++) {
      const cx = rng() * SIZE;
      const cy = rng() * SIZE;
      const R = L.R[0] + rng() * (L.R[1] - L.R[0]);
      const w = L.w[0] + rng() * (L.w[1] - L.w[0]);
      const span = (1.1 + 0.9 * rng()) * Math.PI;
      const a0 = rng() * TAU;
      const amp = 0.45 + 0.55 * rng();
      const bright = (rng() - 0.5) * 0.08;
      const ext = Math.ceil(R + w) + 1;
      for (let py = Math.floor(cy) - ext; py <= Math.floor(cy) + ext; py++) {
        for (let px = Math.floor(cx) - ext; px <= Math.floor(cx) + ext; px++) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          const q = Math.abs(Math.hypot(dx, dy) - R) / w;
          if (q >= 1) continue;
          const rel = ((((Math.atan2(dy, dx) - a0) % TAU) + TAU) % TAU) / span;
          if (rel > 1) continue;
          const val = Math.sqrt(1 - q * q) * (0.35 + 0.65 * Math.sin(Math.PI * rel)) * amp;
          const i = wrap(py) * SIZE + wrap(px);
          if (val > f.top[i]) {
            f.top[i] = val;
            f.bright[i] = bright;
          }
        }
      }
    }
  }
  return f;
}

// Twisted strand: u runs along the length, v around the circumference.
// Ply centers advance around the strand as u increases, so grooves run diagonally.
function buildStrand() {
  const f = newField();
  f.base.fill(0.08);
  const plies = 3;
  const twists = 2; // integer so the tile repeats seamlessly
  const halfW = (0.5 / plies) * 1.04;
  for (let y = 0; y < SIZE; y++) {
    const b = y / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const a = x / SIZE;
      let best = 0;
      let bright = 0;
      for (let k = 0; k < plies; k++) {
        let dd = b - k / plies - twists * a;
        dd -= Math.floor(dd + 0.5);
        const q = dd / halfW;
        if (Math.abs(q) >= 1) continue;
        // fine fibre striations run along each ply
        const h = Math.sqrt(1 - q * q) * (0.96 + 0.04 * Math.sin(TAU * 3.5 * q));
        if (h > best) {
          best = h;
          bright = (hash2(k, 0, 5) - 0.5) * 0.08;
        }
      }
      const i = y * SIZE + x;
      f.top[i] = best;
      f.bright[i] = bright;
    }
  }
  return f;
}

// ---------- height field -> textures ----------

function finish(f, cfg) {
  const h = new Float32Array(N);
  let max = 1e-6;
  for (let i = 0; i < N; i++) {
    h[i] = f.top[i] + f.base[i];
    if (h[i] > max) max = h[i];
  }
  for (let i = 0; i < N; i++) h[i] /= max;
  const hs = boxBlur(h, 1, 1);
  const cavityBlur = boxBlur(hs, cfg.aoRadius, 2);
  const bright = boxBlur(f.bright, 2, 1);

  const normal = new Uint8Array(N * 4);
  const albedo = new Uint8Array(N * 4);
  const rough = new Uint8Array(N * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      // row index equals v, so +y is the +v (green-up) direction
      const gx = (hs[y * SIZE + wrap(x + 1)] - hs[y * SIZE + wrap(x - 1)]) * 0.5;
      const gy = (hs[wrap(y + 1) * SIZE + x] - hs[wrap(y - 1) * SIZE + x]) * 0.5;
      let nx = -gx * cfg.slope;
      let ny = -gy * cfg.slope;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const nz = inv;
      const o = i * 4;
      normal[o] = (nx * 0.5 + 0.5) * 255;
      normal[o + 1] = (ny * 0.5 + 0.5) * 255;
      normal[o + 2] = (nz * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;

      // ambient occlusion: low heights and cavities relative to the neighbourhood go dark
      const cavity = clamp01((cavityBlur[i] - hs[i]) * cfg.aoGain);
      const heightAO = 0.38 + 0.62 * smoothstep(0, 0.45, hs[i]);
      const ao = Math.max(0.35, heightAO * (1 - 0.4 * cavity));
      const g = linearToSRGB(ao * (1 + bright[i]));
      albedo[o] = albedo[o + 1] = albedo[o + 2] = g;
      albedo[o + 3] = 255;

      const r = 255 * (1 - 0.12 * hs[i]);
      rough[o] = rough[o + 1] = rough[o + 2] = r;
      rough[o + 3] = 255;
    }
  }

  return {
    map: makeTexture(albedo, THREE.SRGBColorSpace),
    normalMap: makeTexture(normal, THREE.NoColorSpace),
    roughnessMap: makeTexture(rough, THREE.NoColorSpace),
  };
}

function makeTexture(data, colorSpace) {
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

// slope: height-gradient to normal strength, aoRadius/aoGain: cavity darkening, normalScale: material default
const KINDS = {
  stockinette: { build: buildStockinette, slope: 14, aoRadius: 9, aoGain: 3, normalScale: 1.5 },
  rib: { build: buildRib, slope: 14, aoRadius: 12, aoGain: 3, normalScale: 1.5 },
  garter: { build: buildGarter, slope: 14, aoRadius: 9, aoGain: 3, normalScale: 1.5 },
  seed: { build: buildSeed, slope: 16, aoRadius: 6, aoGain: 3, normalScale: 1.4 },
  cable: { build: buildCable, slope: 14, aoRadius: 10, aoGain: 3, normalScale: 1.5 },
  boucle: { build: buildBoucle, slope: 20, aoRadius: 8, aoGain: 3.5, normalScale: 1.8 },
  strand: { build: buildStrand, slope: 34, aoRadius: 10, aoGain: 3, normalScale: 1.6 },
};

const cache = new Map();

function kindFor(stitch) {
  const cfg = KINDS[stitch];
  if (!cfg) throw new Error(`yarnMaterial: unknown stitch "${stitch}"`);
  return cfg;
}

// Cached base textures (un-repeated, shared by every material of this stitch kind).
export function yarnTexturesFor(stitch) {
  let tex = cache.get(stitch);
  if (!tex) {
    const cfg = kindFor(stitch);
    tex = finish(cfg.build(), cfg);
    cache.set(stitch, tex);
  }
  return tex;
}

// Lighter, slightly desaturated version of the yarn color for the sheen lobe.
function sheenColorFor(color) {
  const hsl = {};
  color.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, hsl.s * 0.7, hsl.l + (1 - hsl.l) * 0.4);
}

// ---------- colorwork ----------

// stitch grid of one base tile [columns, rows], for the kinds that can carry colorwork
const GRIDS = { stockinette: [4, 5], rib: [4, 5], garter: [4, 6], seed: [8, 8], cable: [8, 8] };
const MAP = 1024; // colorwork map size in px
const MAP_TILES = 4; // base tiles per map side
const STRIPE_ROWS = 6; // wanted rows per stripe period
const BAND_ROWS = 10; // wanted rows per fair-isle band
const CHECK_COLS = 4; // stitch columns per gingham block

// 8 columns x 7 rows; # marks the second color
const MOTIFS = [
  ['...#....', '..###...', '.#####..', '#######.', '.#####..', '..###...', '...#....'], // diamond
  ['........', '.##.##..', '#######.', '#######.', '.#####..', '..###...', '...#....'], // heart
  ['...#....', '..###...', '.#####..', '..###...', '.#####..', '#######.', '...#....'], // little tree
];
const MOTIF_W = 8;
const MOTIF_H = 7;

// divisor of n closest to `want` (ties go to the larger one), at least `min`
function nearestDivisor(n, want, min = 1) {
  let best = n;
  for (let d = min; d <= n; d++) {
    if (n % d) continue;
    const a = Math.abs(d - want);
    const b = Math.abs(best - want);
    if (a < b || (a === b && d > best)) best = d;
  }
  return best;
}

// Per-stitch tone for the whole map: 0 = color, 1 = color2, 2 = halfway mix (gingham overlap).
function buildTones(stitch, pattern) {
  const [cols, rows] = GRIDS[stitch];
  const gw = cols * MAP_TILES;
  const gh = rows * MAP_TILES;
  const tones = new Uint8Array(gw * gh);
  if (pattern === 'stripe') {
    const period = nearestDivisor(gh, STRIPE_ROWS);
    const second = Math.max(1, Math.round(period * 0.4));
    for (let y = 0; y < gh; y++) {
      if (y % period < second) tones.fill(1, y * gw, (y + 1) * gw);
    }
  } else if (pattern === 'check') {
    // even block counts both ways so the map wraps without breaking the checks
    let bh = 1;
    for (const c of [5, 4, 6, 3, 2]) {
      if (gh % c === 0 && (gh / c) % 2 === 0) {
        bh = c;
        break;
      }
    }
    const tone = [1, 2, 0];
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const a = ((x / CHECK_COLS) | 0) & 1;
        const b = ((y / bh) | 0) & 1;
        tones[y * gw + x] = tone[a + b];
      }
    }
  } else if (pattern === 'fairisle') {
    const period = nearestDivisor(gh, BAND_ROWS, MOTIF_H + 1);
    for (let y = 0; y < gh; y++) {
      const py = y % period;
      if (py >= MOTIF_H) continue;
      const band = (y / period) | 0;
      for (let x = 0; x < gw; x++) {
        const motif = MOTIFS[(band + ((x / MOTIF_W) | 0)) % MOTIFS.length];
        if (motif[py][x % MOTIF_W] === '#') tones[y * gw + x] = 1;
      }
    }
  } else {
    throw new Error(`yarnMaterial: unknown pattern "${pattern}"`);
  }
  return { tones, gw, gh };
}

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const colorMapCache = new Map();

// sRGB color map: stitch albedo (gray) x per-stitch yarn color, 1024 px = MAP_TILES base tiles
function colorMapFor(stitch, pattern, c1, c2) {
  const key = `${stitch}|${pattern}|${c1.getHexString()}|${c2.getHexString()}`;
  let tex = colorMapCache.get(key);
  if (tex) return tex;

  const { tones, gw, gh } = buildTones(stitch, pattern);
  const palette = [c1, c2, c1.clone().lerp(c2, 0.5)];
  const lut = new Uint8Array(3 * 256 * 3); // [tone][gray][rgb]
  for (let t = 0; t < 3; t++) {
    for (let g = 0; g < 256; g++) {
      const gl = srgbToLinear(g / 255);
      const o = (t * 256 + g) * 3;
      lut[o] = linearToSRGB(palette[t].r * gl) + 0.5;
      lut[o + 1] = linearToSRGB(palette[t].g * gl) + 0.5;
      lut[o + 2] = linearToSRGB(palette[t].b * gl) + 0.5;
    }
  }

  const src = yarnTexturesFor(stitch).map.image.data;
  const out = new Uint8Array(MAP * MAP * 4);
  const cw = MAP / gw;
  const ch = MAP / gh;
  const shifted = stitch === 'seed'; // odd seed rows sit half a stitch to the right
  const k = (MAP_TILES * SIZE) / MAP; // base pixels per map pixel
  for (let y = 0; y < MAP; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / ch));
    const shift = shifted && gy & 1 ? 0.5 : 0;
    const by0 = wrap(y * k);
    const by1 = wrap(y * k + 1);
    for (let x = 0; x < MAP; x++) {
      const gx = (((Math.floor(x / cw - shift) % gw) + gw) % gw);
      const bx0 = wrap(x * k);
      const bx1 = wrap(x * k + 1);
      // 2x2 box filter of the albedo
      const gray =
        (src[(by0 * SIZE + bx0) * 4] + src[(by0 * SIZE + bx1) * 4] + src[(by1 * SIZE + bx0) * 4] + src[(by1 * SIZE + bx1) * 4]) >> 2;
      const l = (tones[gy * gw + gx] * 256 + gray) * 3;
      const o = (y * MAP + x) * 4;
      out[o] = lut[l];
      out[o + 1] = lut[l + 1];
      out[o + 2] = lut[l + 2];
      out[o + 3] = 255;
    }
  }

  tex = new THREE.DataTexture(out, MAP, MAP, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.flipY = false;
  tex.needsUpdate = true;
  colorMapCache.set(key, tex);
  return tex;
}

export function yarnMaterial({
  color, color2, pattern, stitch = 'stockinette', repeat = [8, 8], sheen = 1, roughness = 0.9,
} = {}) {
  const cfg = kindFor(stitch);
  const base = yarnTexturesFor(stitch);
  const c = new THREE.Color(color ?? 0xffffff);

  let map = base.map;
  let mapDiv = 1; // base tiles covered by one period of the color map
  let tint = c;
  let sheenSource = c;
  if (pattern) {
    if (!GRIDS[stitch]) throw new Error(`yarnMaterial: stitch "${stitch}" has no colorwork grid`);
    const c2 = new THREE.Color(color2 ?? 0xffffff);
    map = colorMapFor(stitch, pattern, c, c2);
    mapDiv = MAP_TILES;
    tint = new THREE.Color(0xffffff); // the colors are baked into the map
    sheenSource = c.clone().lerp(c2, 0.5);
  }

  // clone shares the pixel data; only repeat is per material
  const withRepeat = (t, div = 1) => {
    const tex = t.clone();
    tex.repeat.set(repeat[0] / div, repeat[1] / div);
    return tex;
  };

  return new THREE.MeshPhysicalMaterial({
    color: tint,
    map: withRepeat(map, mapDiv),
    normalMap: withRepeat(base.normalMap),
    normalScale: new THREE.Vector2(cfg.normalScale, cfg.normalScale),
    roughnessMap: withRepeat(base.roughnessMap),
    roughness,
    metalness: 0,
    sheen,
    sheenRoughness: 0.5,
    sheenColor: sheenColorFor(sheenSource),
  });
}
