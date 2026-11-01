// Synthetic scene generator: a pinhole camera looking at a dartboard (plane z = 0, mm,
// x right, y up, z out of the board towards the thrower), darts as 3-D shafts with flights,
// soft shadows, lighting gradient, per-frame exposure jitter and sensor noise.
// Used by the detection eval (synth/eval.ts) and to build the e2e fake-camera video.

import { R_BOARD, R_BULL, R_DOUBLE_IN, R_DOUBLE_OUT, R_OUTER_BULL, R_TREBLE_IN, R_TREBLE_OUT, SECTOR_DEG, angleFromTop, polar, sectorCenterDeg, type Pt } from '../src/board.ts';
import { apply, invert, normalise, type Mat3 } from '../src/homography.ts';
import { type Img, makeImg } from '../src/img.ts';

export type V3 = [number, number, number];

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const normal = () => {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, normal, range: (a: number, b: number) => a + (b - a) * next() };
}
export type Rng = ReturnType<typeof rng>;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

export interface Camera {
  w: number;
  h: number;
  f: number;
  cx: number;
  cy: number;
  /** Rows: camera right, down, forward (world coords). */
  R: [V3, V3, V3];
  C: V3;
}

export function lookAt(C: V3, target: V3, rollDeg: number, w: number, h: number, f: number): Camera {
  const fw = norm(sub(target, C));
  let right = norm(cross(fw, [0, 1, 0]));
  let down = cross(fw, right);
  const a = (rollDeg * Math.PI) / 180;
  const r2 = add(scale(right, Math.cos(a)), scale(down, Math.sin(a)));
  const d2 = add(scale(down, Math.cos(a)), scale(right, -Math.sin(a)));
  right = r2;
  down = d2;
  return { w, h, f, cx: w / 2, cy: h / 2, R: [right, down, fw], C };
}

export function project(cam: Camera, X: V3): { x: number; y: number; z: number } {
  const d = sub(X, cam.C);
  const xc = dot(cam.R[0], d);
  const yc = dot(cam.R[1], d);
  const zc = dot(cam.R[2], d);
  return { x: cam.cx + (cam.f * xc) / zc, y: cam.cy + (cam.f * yc) / zc, z: zc };
}

/** Ground-truth homography board mm -> image px for this camera. */
export function boardHomography(cam: Camera): Mat3 {
  const [r, d, f] = cam.R;
  const t: V3 = [-dot(r, cam.C), -dot(d, cam.C), -dot(f, cam.C)];
  // [K][r1 r2 t] where r1, r2 are the camera-frame images of world x and y axes.
  const M = [r[0], r[1], t[0], d[0], d[1], t[1], f[0], f[1], t[2]];
  const K = [cam.f, 0, cam.cx, 0, cam.f, cam.cy, 0, 0, 1];
  const H = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) H[i * 3 + j] += K[i * 3 + k] * M[k * 3 + j];
  return normalise(H);
}

export interface SceneOpts {
  w?: number;
  h?: number;
  /** Viewing angle from the board normal, degrees. */
  tilt?: [number, number];
}

export interface Scene {
  cam: Camera;
  H: Mat3;
  boardImg: Float32Array; // RGB float, board without darts and without lighting
  light: Float32Array; // per-pixel illumination factor
  lightDir: V3; // direction light travels (towards the board)
  noise: number;
}

// --- board appearance -------------------------------------------------------------
const BLACK: V3 = [28, 26, 26];
const CREAM: V3 = [232, 218, 182];
const RED: V3 = [196, 36, 42];
const GREEN: V3 = [22, 128, 64];
const WIRE: V3 = [178, 178, 184];
const WALL: V3 = [128, 118, 104];
const WIRE_R = [R_BULL, R_OUTER_BULL, R_TREBLE_IN, R_TREBLE_OUT, R_DOUBLE_IN, R_DOUBLE_OUT];

export function boardColor(x: number, y: number): V3 {
  const r = Math.hypot(x, y);
  if (r > R_BOARD) return WALL;
  if (r > R_DOUBLE_OUT + 0.5) return BLACK;
  for (const wr of WIRE_R) if (Math.abs(r - wr) < 0.5) return WIRE;
  if (r < R_BULL) return RED;
  if (r < R_OUTER_BULL) return GREEN;
  const a = angleFromTop(x, y);
  const rel = ((a + SECTOR_DEG / 2) % SECTOR_DEG) - SECTOR_DEG / 2; // -9..9 within sector
  if (Math.abs((rel * Math.PI) / 180) * r < 0.5) return WIRE;
  const i = Math.floor(((a + SECTOR_DEG / 2) % 360) / SECTOR_DEG);
  const dark = i % 2 === 0; // 20 is a black sector
  if ((r >= R_TREBLE_IN && r < R_TREBLE_OUT) || (r >= R_DOUBLE_IN && r < R_DOUBLE_OUT)) return dark ? RED : GREEN;
  return dark ? BLACK : CREAM;
}

export function makeScene(seed: number, opts: SceneOpts = {}): Scene {
  const R = rng(seed);
  const w = opts.w ?? 640;
  const h = opts.h ?? 480;
  const f = w * R.range(0.8, 1.0);
  const [t0, t1] = opts.tilt ?? [25, 55];
  const tilt = (R.range(t0, t1) * Math.PI) / 180;
  const az = R.range(0, 2 * Math.PI);
  const boardPx = Math.min(w, h) * R.range(0.34, 0.44); // apparent radius of the double ring
  const dist = (f * R_DOUBLE_OUT) / boardPx;
  const C: V3 = [dist * Math.sin(tilt) * Math.cos(az), dist * Math.sin(tilt) * Math.sin(az), dist * Math.cos(tilt)];
  const target: V3 = [R.range(-20, 20), R.range(-20, 20), 0];
  const cam = lookAt(C, target, R.range(-10, 10), w, h, f);
  const H = boardHomography(cam);
  const Hi = invert(H);

  // Supersampled (2x2) board render.
  const boardImg = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const p = apply(Hi, { x: x + ox, y: y + oy });
        const c = boardColor(p.x, p.y);
        r += c[0]; g += c[1]; b += c[2];
      }
      const k = (y * w + x) * 3;
      boardImg[k] = r / 4; boardImg[k + 1] = g / 4; boardImg[k + 2] = b / 4;
    }

  // Smooth lighting: a linear gradient plus vignetting.
  const gx = R.range(-0.25, 0.25), gy = R.range(-0.25, 0.25), base = R.range(0.8, 1.05);
  const light = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = (x - w / 2) / w, ny = (y - h / 2) / h;
      light[y * w + x] = base * (1 + gx * nx + gy * ny) * (1 - 0.35 * (nx * nx + ny * ny));
    }
  const lightDir = norm([R.range(-0.5, 0.5), R.range(-0.5, 0.5), -1]);
  return { cam, H, boardImg, light, lightDir, noise: R.range(2, 4.5) };
}

// --- darts -----------------------------------------------------------------------
export interface Dart {
  tip: Pt; // board mm
  dir: V3; // unit vector from tip towards the flight
  roll: number; // flight fin orientation (rad)
  color: V3; // shaft / flight colour
  flight: V3;
}

const PALETTE: V3[] = [[220, 30, 30], [30, 90, 220], [240, 200, 20], [30, 170, 70], [240, 240, 240], [20, 20, 20], [230, 110, 20], [150, 40, 190]];

export function randomDart(R: Rng, tip: Pt): Dart {
  const dir = norm([R.normal() * 0.18, R.normal() * 0.18 - 0.08, 1]);
  const c = PALETTE[Math.floor(R.next() * PALETTE.length)];
  const fl = PALETTE[Math.floor(R.next() * PALETTE.length)];
  return { tip, dir, roll: R.range(0, Math.PI), color: c, flight: fl };
}

// Dart profile along its axis (mm from the tip): [s0, s1, r0, r1, colour key]
const POINT_COL: V3 = [172, 172, 178];
const BARREL_COL: V3 = [118, 120, 126];
const PARTS: [number, number, number, number, 'point' | 'barrel' | 'shaft'][] = [
  [0, 30, 0.7, 1.2, 'point'],
  [30, 36, 1.6, 3.2, 'barrel'],
  [36, 78, 3.4, 3.2, 'barrel'],
  [78, 116, 2.2, 2.0, 'shaft'],
];
const FLIGHT = { s0: 104, s1: 150, ramp: 18, half: 16 };

interface Shape {
  kind: 'capsule' | 'quad';
  depth: number;
  color: V3;
  a?: { x: number; y: number };
  b?: { x: number; y: number };
  ra?: number;
  rb?: number;
  poly?: { x: number; y: number }[];
}

function dartShapes(cam: Camera, d: Dart): Shape[] {
  const P0: V3 = [d.tip.x, d.tip.y, 0];
  const at = (s: number): V3 => add(P0, scale(d.dir, s));
  const out: Shape[] = [];
  for (const [s0, s1, r0, r1, key] of PARTS) {
    const A = project(cam, at(s0)), B = project(cam, at(s1));
    const color = key === 'point' ? POINT_COL : key === 'barrel' ? BARREL_COL : d.color;
    out.push({ kind: 'capsule', depth: (A.z + B.z) / 2, color, a: A, b: B, ra: (cam.f * r0) / A.z, rb: (cam.f * r1) / B.z });
  }
  // Two crossed fins, each a plane through the axis.
  const ref: V3 = Math.abs(d.dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm(cross(d.dir, ref));
  const e2 = cross(d.dir, e1);
  for (let k = 0; k < 2; k++) {
    const ang = d.roll + (k * Math.PI) / 2;
    const e = add(scale(e1, Math.cos(ang)), scale(e2, Math.sin(ang)));
    const { s0, s1, ramp, half } = FLIGHT;
    const pts = [add(at(s0), scale(e, 0)), add(at(s0 + ramp), scale(e, half)), add(at(s1), scale(e, half)), add(at(s1), scale(e, -half)), add(at(s0 + ramp), scale(e, -half))].map((X) => project(cam, X));
    const shade = k === 0 ? 1 : 0.8;
    out.push({ kind: 'quad', depth: pts.reduce((s, p) => s + p.z, 0) / pts.length, color: scale(d.flight, shade), poly: pts });
  }
  return out;
}

function insidePoly(poly: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function drawShape(rgb: Float32Array, w: number, h: number, s: Shape) {
  if (s.kind === 'capsule') {
    const a = s.a!, b = s.b!, ra = s.ra!, rb = s.rb!;
    const pad = Math.max(ra, rb) + 2;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - pad)), x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - pad)), y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + pad));
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2));
        const qx = a.x + t * dx - px, qy = a.y + t * dy - py;
        const dist = Math.hypot(qx, qy);
        const rad = Math.max(0.6, ra + (rb - ra) * t);
        const cov = Math.max(0, Math.min(1, rad - dist + 0.5));
        if (cov <= 0) continue;
        const shade = 0.7 + 0.45 * (1 - Math.min(1, dist / rad)) ** 2;
        const k = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) rgb[k + c] = rgb[k + c] * (1 - cov) + Math.min(255, s.color[c] * shade) * cov;
      }
  } else {
    const poly = s.poly!;
    const x0 = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.x)))), x1 = Math.min(w - 1, Math.ceil(Math.max(...poly.map((p) => p.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.y)))), y1 = Math.min(h - 1, Math.ceil(Math.max(...poly.map((p) => p.y))));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        let cov = 0;
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) if (insidePoly(poly, x + ox, y + oy)) cov += 0.25;
        if (!cov) continue;
        const k = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) rgb[k + c] = rgb[k + c] * (1 - cov) + s.color[c] * cov;
      }
  }
}

/** Soft shadows of the dart axes, cast on the board along the scene light direction. */
function drawShadows(rgb: Float32Array, sc: Scene, darts: Dart[]) {
  const { w, h } = sc.cam;
  const L = sc.lightDir;
  for (const d of darts) {
    const P0: V3 = [d.tip.x, d.tip.y, 0];
    const onBoard = (s: number): Pt => {
      const X = add(P0, scale(d.dir, s));
      const t = -X[2] / L[2];
      return { x: X[0] + t * L[0], y: X[1] + t * L[1] };
    };
    const a = onBoard(0), b = onBoard(120);
    const A = project(sc.cam, [a.x, a.y, 0]), B = project(sc.cam, [b.x, b.y, 0]);
    const pad = 14;
    const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x) - pad)), x1 = Math.min(w - 1, Math.ceil(Math.max(A.x, B.x) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y) - pad)), y1 = Math.min(h - 1, Math.ceil(Math.max(A.y, B.y) + pad));
    const Hi = invert(sc.H);
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const p = apply(Hi, { x: x + 0.5, y: y + 0.5 });
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
        const dist = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
        const width = 2 + 6 * t; // penumbra widens away from the tip
        const k = Math.max(0, 1 - dist / width) * (1 - 0.5 * t);
        if (k <= 0) continue;
        const f = 1 - 0.2 * k;
        const i = (y * w + x) * 3;
        rgb[i] *= f; rgb[i + 1] *= f; rgb[i + 2] *= f;
      }
  }
}

/** Render a camera frame with the given darts in the board. */
export function renderFrame(sc: Scene, darts: Dart[], seed: number, exposure = 1): Img {
  const { w, h } = sc.cam;
  const R = rng(seed);
  const rgb = new Float32Array(sc.boardImg);
  drawShadows(rgb, sc, darts);
  const shapes = darts.flatMap((d) => dartShapes(sc.cam, d)).sort((p, q) => q.depth - p.depth);
  for (const s of shapes) drawShape(rgb, w, h, s);
  const out = makeImg(w, h);
  for (let i = 0, n = w * h; i < n; i++) {
    const l = sc.light[i] * exposure;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = rgb[i * 3 + c] * l + R.normal() * sc.noise;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Where a player aiming at typical targets lands; mixes target play with uniform board coverage. */
export function randomTip(R: Rng): Pt {
  const u = R.next();
  if (u < 0.15) {
    // Uniform over the scoring area and a bit beyond (misses on the number ring).
    const r = Math.sqrt(R.next()) * 200;
    const a = R.range(0, 2 * Math.PI);
    return { x: r * Math.sin(a), y: r * Math.cos(a) };
  }
  const aims: Pt[] = [
    polar(103, 0), // T20
    polar(103, 0),
    { x: 0, y: 0 }, // bull
    polar(103, sectorCenterDeg(19)),
    polar(166, 0), // D20
    polar(166, sectorCenterDeg(16)),
  ];
  const aim = aims[Math.floor(R.next() * aims.length)];
  const s = 18; // mm spread (club player)
  return { x: aim.x + R.normal() * s, y: aim.y + R.normal() * s };
}
