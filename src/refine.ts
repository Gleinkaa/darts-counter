// Calibration refinement ("snap to wires"). Four finger taps are only good to a few pixels.
// Starting from that rough homography, measure the board itself:
//   - radial searches across the treble and double ring edges at many angles,
//   - tangential searches across the sector wires at several radii,
// then refit H to all measured points (least squares) and iterate, ICP-style.
// Each measurement only fixes one direction (radial or tangential); the other comes from the
// current estimate, which is why it iterates.

import { R_DOUBLE_IN, R_DOUBLE_OUT, R_TREBLE_IN, R_TREBLE_OUT, SECTOR_DEG, polar, type Pt } from './board.ts';
import { apply, fitHomography, type Mat3 } from './homography.ts';
import type { Img } from './img.ts';

export interface RefineResult {
  H: Mat3;
  /** Number of edge measurements used in the final fit. */
  used: number;
  /** RMS residual of the final fit, px. */
  rms: number;
  /** Largest move of a calibration-point image position compared with the input H, px. */
  moved: number;
  ok: boolean;
}

function sampleRGB(im: Img, p: Pt): [number, number, number] | null {
  const x = p.x - 0.5, y = p.y - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= im.width || y0 + 1 >= im.height) return null;
  const fx = x - x0, fy = y - y0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const i = (y0 * im.width + x0) * 4 + c;
    const a = im.data[i], b = im.data[i + 4], d = im.data[i + im.width * 4], e = im.data[i + im.width * 4 + 4];
    out[c] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
  }
  return out;
}

/**
 * Along a 1-D family of board points, find the strongest colour edge and return its parameter
 * (centroid of the gradient around the peak), or null when there is no clear edge.
 */
function edgeAlong(im: Img, H: Mat3, at: (u: number) => Pt, u0: number, u1: number, step: number): number | null {
  const n = Math.round((u1 - u0) / step);
  const cols: ([number, number, number] | null)[] = [];
  for (let k = 0; k <= n; k++) cols.push(sampleRGB(im, apply(H, at(u0 + k * step))));
  const g = new Float32Array(n + 1);
  for (let k = 1; k < n; k++) {
    const a = cols[k - 1], b = cols[k + 1];
    if (!a || !b) return null;
    g[k] = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + Math.abs(b[2] - a[2]);
  }
  let best = 1;
  for (let k = 1; k < n; k++) if (g[k] > g[best]) best = k;
  if (g[best] < 45) return null; // too weak: glare, a dart in the way, or off the image
  // Unique enough? The second-best peak away from this one must be clearly smaller.
  let second = 0;
  for (let k = 1; k < n; k++) if (Math.abs(k - best) > 3 / step) second = Math.max(second, g[k]);
  if (second > 0.8 * g[best]) return null;
  let sw = 0, su = 0;
  const half = Math.max(1, Math.round(1 / step));
  for (let k = Math.max(1, best - half); k <= Math.min(n - 1, best + half); k++) {
    sw += g[k];
    su += g[k] * (u0 + k * step);
  }
  return su / sw;
}

const RING_EDGES = [R_TREBLE_IN, R_TREBLE_OUT, R_DOUBLE_IN, R_DOUBLE_OUT];
const WIRE_RADII = [45, 75, 125, 145];

function measure(im: Img, H: Mat3): { src: Pt[]; dst: Pt[] } {
  const src: Pt[] = [], dst: Pt[] = [];
  // Radial: across ring edges, at three angles per sector (away from the wires at ±9°).
  for (let s = 0; s < 20; s++)
    for (const off of [-5, 0, 5]) {
      const deg = s * SECTOR_DEG + off;
      for (const R of RING_EDGES) {
        const r = edgeAlong(im, H, (u) => polar(u, deg), R - 3.5, R + 3.5, 0.25);
        if (r === null) continue;
        src.push(polar(R, deg));
        dst.push(apply(H, polar(r, deg)));
      }
    }
  // Tangential: across the sector wires (boundaries at 9° + k·18°).
  for (let k = 0; k < 20; k++) {
    const deg = k * SECTOR_DEG + SECTOR_DEG / 2;
    for (const r of WIRE_RADII) {
      const span = (4 / r) * (180 / Math.PI); // ±4 mm of arc
      const a = edgeAlong(im, H, (u) => polar(r, u), deg - span, deg + span, span / 32);
      if (a === null) continue;
      src.push(polar(r, deg));
      dst.push(apply(H, polar(r, a)));
    }
  }
  return { src, dst };
}

export function refineCalibration(im: Img, H0: Mat3, calibBoard: Pt[], maxIterations = 12): RefineResult {
  let H = H0;
  let used = 0;
  let rms = Infinity;
  for (let it = 0; it < maxIterations; it++) {
    const { src, dst } = measure(im, H);
    if (src.length < 24) return { H: H0, used: src.length, rms: Infinity, moved: 0, ok: false };
    let Hn = fitHomography(src, dst);
    // One round of outlier rejection.
    const res = src.map((p, i) => {
      const q = apply(Hn, p);
      return Math.hypot(q.x - dst[i].x, q.y - dst[i].y);
    });
    const med = [...res].sort((a, b) => a - b)[res.length >> 1];
    const keep = res.map((r) => r <= Math.max(1.0, 3 * med));
    const s2 = src.filter((_, i) => keep[i]), d2 = dst.filter((_, i) => keep[i]);
    if (s2.length >= 24) Hn = fitHomography(s2, d2);
    used = s2.length;
    rms = Math.sqrt(
      s2.reduce((acc, p, i) => {
        const q = apply(Hn, p);
        return acc + (q.x - d2[i].x) ** 2 + (q.y - d2[i].y) ** 2;
      }, 0) / s2.length,
    );
    // Stop once the fit no longer moves (each round fixes one direction per measurement).
    const step = Math.max(...calibBoard.map((p) => {
      const a = apply(H, p), b = apply(Hn, p);
      return Math.hypot(a.x - b.x, a.y - b.y);
    }));
    H = Hn;
    if (step < 0.05) break;
  }
  const moved = Math.max(
    ...calibBoard.map((p) => {
      const a = apply(H0, p), b = apply(H, p);
      return Math.hypot(a.x - b.x, a.y - b.y);
    }),
  );
  // Board radius in px, to judge whether the snap moved implausibly far from the taps.
  const c = apply(H0, { x: 0, y: 0 });
  const rpx = Math.max(...calibBoard.map((p) => Math.hypot(apply(H0, p).x - c.x, apply(H0, p).y - c.y)));
  const ok = rms < 1.5 && moved < Math.max(8, 0.06 * rpx) && used >= 60;
  return { H: ok ? H : H0, used, rms, moved, ok };
}
