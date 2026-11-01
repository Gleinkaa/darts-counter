// Dart detection by frame differencing. Hand-written, no OpenCV:
//   1. gain-compensated colour difference between the frame before and after the throw,
//      with cast shadows suppressed (uniform darkening across channels),
//   2. blur + threshold + connected components (8-connected),
//   3. the largest component is the new dart; nearby fragments are merged back
//      (the dart is cut in pieces where it crosses an earlier dart of similar colour),
//   4. the flight holds most of the changed area, so the blob centroid sits near it; the tip
//      is the far end of a thin, straight, continuous run (the shaft) out of that centroid,
//   5. a line fit on that run; the tip is the extreme point along it.

import { type Img, boxBlur } from './img.ts';
import { type Pt } from './board.ts';
import { apply, invert, type Mat3 } from './homography.ts';
import { type Pose, poseFromHomography, projectLifted } from './camera.ts';

/** See the tip extension in detectDart. */
export const TIP_BACKOFF_PX = 1.75;
const MAX_GAP_PX = 7;
const RESUME_PX = 1.5;

export interface DetectOpts {
  /** Optional mask of pixels to consider (1 = board area). Same size as the frames. */
  mask?: Uint8Array;
  /** Minimum pixel count of a dart. */
  minArea?: number;
  /** Approximate image scale near the board (px per mm); sets the expected dart width. */
  pxPerMm?: number;
  /** Calibration homography (board mm -> px). Enables the "darts stick out of the board" prior. */
  H?: Mat3;
  /** Filled with intermediate results when given (tests/debugging). */
  debug?: { reason?: string; bin?: Uint8Array; thr?: number; elong?: number; comps?: number[]; cands?: string[]; merged?: number; walk?: string };
}

export interface Detection {
  tip: Pt;
  /** Unit vector along the dart from the tip towards the flight. */
  axis: Pt;
  /** Far (flight) end of the dart, image px. */
  tail: Pt;
  area: number;
  length: number;
  /** 0..1, how sure we are (elongation and tip/tail width contrast). */
  confidence: number;
}

/** Per-frame brightness ratio after/before (median over a pixel grid), to undo auto exposure. */
export function gainRatio(before: Img, after: Img, mask?: Uint8Array): number {
  const r: number[] = [];
  const n = before.width * before.height;
  const step = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n; i += step) {
    if (mask && !mask[i]) continue;
    const j = i * 4;
    const a = before.data[j] + before.data[j + 1] + before.data[j + 2];
    const b = after.data[j] + after.data[j + 1] + after.data[j + 2];
    if (a > 60) r.push(b / a);
  }
  if (r.length < 20) return 1;
  r.sort((x, y) => x - y);
  return r[r.length >> 1];
}

/** Change magnitude per pixel (0..255), shadows and global exposure removed. */
export function changeMap(before: Img, after: Img, mask?: Uint8Array): Float32Array {
  const n = before.width * before.height;
  const g = gainRatio(before, after, mask);
  const out = new Float32Array(n);
  const A = before.data, B = after.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (mask && !mask[i]) continue;
    const r0 = A[j] * g, g0 = A[j + 1] * g, b0 = A[j + 2] * g;
    const r1 = B[j], g1 = B[j + 1], b1 = B[j + 2];
    const d = Math.max(Math.abs(r1 - r0), Math.abs(g1 - g0), Math.abs(b1 - b0));
    // Shadow: every channel darkened by about the same factor, and not a lot.
    const s0 = r0 + g0 + b0;
    if (s0 > 90 && r1 < r0 && g1 < g0 && b1 < b0) {
      const k = (r1 + g1 + b1) / s0;
      if (k > 0.6) {
        const dev = Math.max(Math.abs(r1 - k * r0), Math.abs(g1 - k * g0), Math.abs(b1 - k * b0));
        if (dev < 14) continue;
      }
    }
    out[i] = d;
  }
  return out;
}

interface Comp {
  pixels: number[];
}

function components(bin: Uint8Array, w: number, h: number, minArea: number): Comp[] {
  const label = new Int32Array(w * h).fill(-1);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!bin[i] || label[i] >= 0) continue;
    const id = comps.length;
    const px: number[] = [];
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      px.push(p);
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (bin[q] && label[q] < 0) {
            label[q] = id;
            stack.push(q);
          }
        }
    }
    comps.push({ pixels: px });
  }
  return comps.filter((c) => c.pixels.length >= minArea);
}

interface Line {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  l1: number;
  l2: number;
}

function fitLine(pixels: number[], w: number, weight?: Float32Array): Line {
  let sw = 0, sx = 0, sy = 0;
  for (const p of pixels) {
    const k = weight ? weight[p] : 1;
    sw += k; sx += k * (p % w); sy += k * Math.floor(p / w);
  }
  const cx = sx / sw, cy = sy / sw;
  let xx = 0, xy = 0, yy = 0;
  for (const p of pixels) {
    const k = weight ? weight[p] : 1;
    const dx = (p % w) - cx, dy = Math.floor(p / w) - cy;
    xx += k * dx * dx; xy += k * dx * dy; yy += k * dy * dy;
  }
  xx /= sw; xy /= sw; yy /= sw;
  const tr = xx + yy, det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { cx, cy, ux: Math.cos(ang), uy: Math.sin(ang), l1, l2 };
}

/** Robust noise level of a change map: scaled median absolute value of masked pixels. */
function noiseLevel(d: Float32Array, mask?: Uint8Array): number {
  const v: number[] = [];
  const step = Math.max(1, Math.floor(d.length / 5000));
  for (let i = 0; i < d.length; i += step) if (!mask || mask[i]) v.push(d[i]);
  v.sort((a, b) => a - b);
  return v[v.length >> 1] || 1;
}

/** Find the single new dart between two still frames, or null. */
export function detectDart(before: Img, after: Img, opts: DetectOpts = {}): Detection | null {
  const { width: w, height: h } = before;
  const minArea = opts.minArea ?? Math.max(20, Math.round((w * h) / 6000));
  const raw = changeMap(before, after, opts.mask);
  const d = boxBlur(raw, w, h, 1);
  const thr = Math.max(24, noiseLevel(d, opts.mask) * 3.5);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = d[i] > thr ? 1 : 0;
  const comps = components(bin, w, h, 4).sort((a, b) => b.pixels.length - a.pixels.length);
  const dbg = opts.debug;
  if (dbg) Object.assign(dbg, { bin, thr, comps: comps.slice(0, 8).map((c) => c.pixels.length) });
  if (!comps.length || comps[0].pixels.length < minArea) {
    if (dbg) dbg.reason = 'no component >= minArea';
    return null;
  }

  let s = opts.pxPerMm ?? 1.1;
  let pose: Pose | null = null;
  let Hi: Mat3 | null = null;
  if (opts.H) {
    pose = poseFromHomography(opts.H, w, h);
    Hi = invert(opts.H);
    if (!opts.pxPerMm) {
      const a = apply(opts.H, { x: -50, y: 0 }), b = apply(opts.H, { x: 50, y: 0 });
      const c = apply(opts.H, { x: 0, y: -50 }), e = apply(opts.H, { x: 0, y: 50 });
      s = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(e.x - c.x, e.y - c.y)) / 200;
    }
  }
  // Direction a dart standing in the board at image point p should extend (towards its flight).
  const outward = (px: number, py: number): Pt | null => {
    if (!pose || !Hi) return null;
    const b = apply(Hi, { x: px, y: py });
    const q = projectLifted(pose, b, 100);
    const dx = q.x - px, dy = q.y - py, n = Math.hypot(dx, dy);
    return n > 1e-6 ? { x: dx / n, y: dy / n } : null;
  };
  const pixels = mergeFragments(comps, w, h, s, d, outward);
  const area = pixels.length;
  if (dbg) dbg.merged = area;
  const xs = new Float32Array(area), ys = new Float32Array(area), wt = new Float32Array(area);
  let sw = 0, cx = 0, cy = 0;
  pixels.forEach((p, i) => {
    xs[i] = p % w; ys[i] = (p - xs[i]) / w; wt[i] = d[p];
    sw += wt[i]; cx += wt[i] * xs[i]; cy += wt[i] * ys[i];
  });
  cx /= sw; cy /= sw; // dominated by the flight, which has most of the changed area

  // Candidates: the farthest pixel in each of 32 directions around the centroid.
  const BINS = 32;
  const far = new Array<{ i: number; dist: number }>(BINS).fill({ i: -1, dist: 0 });
  for (let i = 0; i < area; i++) {
    const dx = xs[i] - cx, dy = ys[i] - cy;
    const dist = Math.hypot(dx, dy);
    const b = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
    if (dist > far[b].dist) far[b] = { i, dist };
  }
  const narrowW = Math.max(3, 4.5 * s), wideW = Math.max(9, 14 * s);
  // How shaft-like is the straight run from the centroid out to this candidate?
  const shaftScore = (i: number, dist: number) => {
    const ux = (xs[i] - cx) / dist, uy = (ys[i] - cy) / dist;
    const t0 = 0.6 * dist; // the barrel + point; a gap behind an earlier flight is usually further in
    const nb = Math.max(1, Math.floor(dist - t0));
    const covered = new Uint8Array(nb + 1);
    let narrow = 0, wide = 0;
    for (let k = 0; k < area; k++) {
      const dx = xs[k] - cx, dy = ys[k] - cy;
      const t = dx * ux + dy * uy;
      if (t < t0 || t > dist + 1) continue;
      const n = Math.abs(-dx * uy + dy * ux);
      if (n <= narrowW) {
        narrow++;
        covered[Math.min(nb, Math.max(0, Math.floor(t - t0)))] = 1;
      } else if (n <= wideW) wide++;
    }
    let cov = 0;
    for (const c of covered) cov += c;
    const coverage = cov / (nb + 1);
    const wideRatio = wide / (narrow + 1);
    // Prior: from the tip, the dart must run towards where the board normal projects.
    let prior = 1;
    const o = outward(xs[i], ys[i]);
    if (o) {
      const cos = -(o.x * ux + o.y * uy); // centroid lies "outward" of the tip
      prior = 0.1 + 0.9 * Math.max(0, cos) ** 2;
    }
    return { score: (prior * dist * coverage * coverage) / (1 + 2 * wideRatio), coverage, wideRatio, ux, uy };
  };
  let best: { i: number; dist: number; score: number; coverage: number; wideRatio: number; ux: number; uy: number } | null = null;
  let second = 0;
  for (const c of far) {
    if (c.i < 0 || c.dist < 10 * s) continue;
    const r = shaftScore(c.i, c.dist);
    if (dbg) (dbg.cands ??= []).push(`(${xs[c.i]},${ys[c.i]}) d=${c.dist.toFixed(0)} cov=${r.coverage.toFixed(2)} wide=${r.wideRatio.toFixed(2)} score=${r.score.toFixed(1)}`);
    if (!best || r.score > best.score) {
      if (best) second = Math.max(second, best.score);
      best = { ...c, ...r };
    } else second = Math.max(second, r.score);
  }
  if (dbg) dbg.elong = best ? best.score : 0;
  if (!best || best.coverage < 0.6) {
    if (dbg) dbg.reason = best ? `no shaft (coverage ${best.coverage.toFixed(2)})` : 'blob too small';
    return null;
  }

  // Refine: line fit on the shaft/barrel/point run, then the extreme pixel along it.
  const run: number[] = [];
  for (let k = 0; k < area; k++) {
    const dx = xs[k] - cx, dy = ys[k] - cy;
    const t = dx * best.ux + dy * best.uy;
    const n = Math.abs(-dx * best.uy + dy * best.ux);
    if (t >= 0.45 * best.dist && n <= narrowW + 1) run.push(pixels[k]);
  }
  let dirx = best.ux, diry = best.uy, ox = cx, oy = cy;
  if (run.length >= 8) {
    const tl = fitLine(run, w, d);
    const flip = tl.ux * best.ux + tl.uy * best.uy < 0 ? -1 : 1;
    dirx = tl.ux * flip; diry = tl.uy * flip; ox = tl.cx; oy = tl.cy;
  }
  let tmax = -Infinity, tmin = Infinity;
  for (let k = 0; k < area; k++) {
    const dx = xs[k] - ox, dy = ys[k] - oy;
    const t = dx * dirx + dy * diry;
    if (t < tmin) tmin = t;
    if (Math.abs(-dx * diry + dy * dirx) < 2.5 && t > tmax) tmax = t;
  }
  if (!Number.isFinite(tmax)) return null;
  // The steel point is thin and often low-contrast, so the blurred mask loses it. Walk on
  // along the axis on the raw difference with a lower threshold until the signal stops.
  const rawNoise = noiseLevel(raw, opts.mask);
  const low = Math.max(11, rawNoise * 2.4);
  const sample = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : raw[yi * w + xi];
  };
  const along = (t: number) => {
    // Max across the line (±1.5 px) of the mean along it (3 samples, 1 px apart).
    let best = 0;
    for (let n = -1.5; n <= 1.5; n += 0.5) {
      let m = 0;
      for (let k = -1; k <= 1; k++) {
        const tt = t + k;
        m += sample(ox + dirx * tt - diry * n + 0.5 - 0.5, oy + diry * tt + dirx * n);
      }
      best = Math.max(best, m / 3);
    }
    return best;
  };
  let tEnd = tmax;
  // How long the ~30 mm steel point can look here: from the pose when calibrated, else a scale guess.
  let maxExt = 40 * s;
  if (pose && Hi) {
    const b = apply(Hi, { x: ox + dirx * tmax, y: oy + diry * tmax });
    const a0 = projectLifted(pose, b, 0), a1 = projectLifted(pose, b, 30);
    maxExt = Math.min(maxExt, 1.4 * Math.hypot(a1.x - a0.x, a1.y - a0.y) + 3);
  }
  // A light steel point over a lit cream segment has almost no contrast, so the signal can drop out
  // for a few pixels and come back. Bridge gaps up to MAX_GAP_PX, but only if it really comes back
  // (RESUME_PX of signal), and never beyond the length the point can have.
  let gap = 0, resumed = 0;
  for (let t = tmax + 0.5; t <= tmax + maxExt; t += 0.5) {
    if (along(t) > low) {
      resumed += 0.5;
      if (gap === 0 || resumed >= RESUME_PX) {
        tEnd = t;
        gap = 0;
      }
    } else {
      resumed = 0;
      if ((gap += 0.5) > MAX_GAP_PX) break;
    }
  }
  // The last pixel with signal lies past the board-entry point (round point end, partial
  // pixel coverage, the ±1 px along-axis window). TIP_BACKOFF_PX is calibrated on the synthetic
  // eval (median along-axis error 2.25 px before correction, see docs/eval.md).
  const te = tEnd - TIP_BACKOFF_PX;
  const tip = { x: ox + dirx * te + 0.5, y: oy + diry * te + 0.5 };
  const tail = { x: ox + dirx * tmin + 0.5, y: oy + diry * tmin + 0.5 };
  const sep = second > 0 ? best.score / second : 3;
  const confidence = Math.max(0, Math.min(1, (best.coverage - 0.6) * 2.5 * Math.min(1, (sep - 1) / 1.5) * (1 / (1 + best.wideRatio))));
  return { tip, axis: { x: -dirx, y: -diry }, tail, area, length: tmax - tmin, confidence };
}

/**
 * The new dart is the largest changed blob; where it crosses an earlier dart (or a background of
 * the same colour) it falls apart. Merge fragments back that are near the main blob, or — with the
 * pose prior — that lie on the line a dart standing there would follow towards the main blob.
 */
function mergeFragments(
  comps: Comp[],
  w: number,
  h: number,
  s: number,
  d: Float32Array,
  outward: (x: number, y: number) => Pt | null,
): number[] {
  const main = comps[0].pixels;
  let mx = 0, my = 0, mw = 0;
  for (const p of main) {
    mx += d[p] * (p % w); my += d[p] * Math.floor(p / w); mw += d[p];
  }
  mx /= mw; my /= mw;
  const CELL = 8;
  const gw = Math.ceil(w / CELL), gh = Math.ceil(h / CELL);
  const occ = new Uint8Array(gw * gh);
  for (const p of main) occ[Math.floor(Math.floor(p / w) / CELL) * gw + Math.floor((p % w) / CELL)] = 1;
  // Dilate the coarse occupancy by ~ 30 mm.
  const R = Math.max(2, Math.round((30 * s) / CELL));
  const near = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      if (!occ[gy * gw + gx]) continue;
      for (let y = Math.max(0, gy - R); y <= Math.min(gh - 1, gy + R); y++)
        for (let x = Math.max(0, gx - R); x <= Math.min(gw - 1, gx + R); x++) near[y * gw + x] = 1;
    }
  let out = main.slice();
  for (let i = 1; i < comps.length; i++) {
    const c = comps[i].pixels;
    if (c.length > main.length) continue;
    // A fragment of this dart touches the main blob's neighbourhood with at least one end…
    const inNear = c.filter((p) => near[Math.floor(Math.floor(p / w) / CELL) * gw + Math.floor((p % w) / CELL)]).length;
    let take = inNear >= Math.min(10, 0.5 * c.length);
    // …or sits on the dart's line further out (the part between is hidden).
    if (!take && c.length >= 8) {
      let fx = 0, fy = 0;
      for (const p of c) {
        fx += p % w; fy += Math.floor(p / w);
      }
      fx /= c.length; fy /= c.length;
      const o = outward(fx, fy);
      const dist = Math.hypot(mx - fx, my - fy);
      if (o && dist < 180 * s && dist > 1) {
        const cos = (o.x * (mx - fx) + o.y * (my - fy)) / dist;
        // The fragment's own axis must also point at the main blob (darts tilt ~10°, so the prior
        // alone is too loose or too strict depending on the view).
        const fl = fitLine(c, w);
        const off = Math.abs(-(mx - fl.cx) * fl.uy + (my - fl.cy) * fl.ux);
        const elongated = fl.l1 > 9 * fl.l2;
        take = cos > 0.985 || (cos > 0.9 && elongated && off < 12 * s);
      }
    }
    if (take) out = out.concat(c);
  }
  void h;
  return out;
}

/** Fraction of masked pixels that changed noticeably (used for "board empty" / "hand in view"). */
export function changedFraction(a: Img, b: Img, mask?: Uint8Array, thr = 40): number {
  const d = boxBlur(changeMap(a, b, mask), a.width, a.height, 1);
  let n = 0, c = 0;
  for (let i = 0; i < d.length; i++) {
    if (mask && !mask[i]) continue;
    n++;
    if (d[i] > thr) c++;
  }
  return n ? c / n : 0;
}
