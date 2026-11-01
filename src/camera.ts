// Camera pose from the calibration homography (Zhang-style decomposition), assuming square
// pixels and the principal point at the image centre. Lets us predict where a dart sticking
// out of the board at a given point appears in the image.

import type { Pt } from './board.ts';
import type { Mat3 } from './homography.ts';

export interface Pose {
  f: number;
  cx: number;
  cy: number;
  r1: number[];
  r2: number[];
  r3: number[];
  t: number[];
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function poseFromHomography(H: Mat3, w: number, h: number): Pose {
  const cx = w / 2, cy = h / 2;
  // Move the principal point to the origin.
  const col = (j: number) => [H[j] - cx * H[6 + j], H[3 + j] - cy * H[6 + j], H[6 + j]];
  const h1 = col(0), h2 = col(1), h3 = col(2);
  // Two constraints on f: r1 ⟂ r2 and |r1| = |r2|. Each degenerates in some views; combine.
  const est: { f2: number; wgt: number }[] = [];
  const d1 = h1[2] * h2[2];
  if (Math.abs(d1) > 1e-12) {
    const f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / d1;
    if (f2 > 0) est.push({ f2, wgt: Math.abs(d1) });
  }
  const d2 = h2[2] * h2[2] - h1[2] * h1[2];
  if (Math.abs(d2) > 1e-12) {
    const f2 = (h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2) / d2;
    if (f2 > 0) est.push({ f2, wgt: Math.abs(d2) });
  }
  let f = 0.9 * w; // typical phone camera, used when the view is too frontal to tell
  if (est.length) {
    const sw = est.reduce((s, e) => s + e.wgt, 0);
    f = Math.sqrt(est.reduce((s, e) => s + e.f2 * e.wgt, 0) / sw);
  }
  f = Math.min(2.5 * w, Math.max(0.5 * w, f));
  const a = (v: number[]) => [v[0] / f, v[1] / f, v[2]];
  const a1 = a(h1), a2 = a(h2), a3 = a(h3);
  let lam = 2 / (Math.hypot(...a1) + Math.hypot(...a2));
  if (a3[2] * lam < 0) lam = -lam; // the board is in front of the camera
  const r1 = a1.map((v) => v * lam), r2 = a2.map((v) => v * lam), t = a3.map((v) => v * lam);
  const r3 = cross(r1, r2);
  return { f, cx, cy, r1, r2, r3, t };
}

/** Image position of board point (x, y) lifted s mm out of the board (towards the thrower). */
export function projectLifted(P: Pose, b: Pt, s: number): Pt {
  const X = [0, 1, 2].map((k) => P.r1[k] * b.x + P.r2[k] * b.y + P.r3[k] * s + P.t[k]);
  return { x: P.cx + (P.f * X[0]) / X[2], y: P.cy + (P.f * X[1]) / X[2] };
}
