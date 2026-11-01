// Region of the camera image where darts can appear: the board plus a margin for flights
// that stick out past the board edge.

import { apply, invert, type Mat3 } from './homography.ts';

export const MASK_RADIUS_MM = 330;

export function boardMask(H: Mat3, w: number, h: number, radiusMm = MASK_RADIUS_MM): Uint8Array {
  const Hi = invert(H);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = apply(Hi, { x: x + 0.5, y: y + 0.5 });
      // Points behind the camera map to a negative w; guard via finite check and radius.
      if (Number.isFinite(p.x) && Math.hypot(p.x, p.y) < radiusMm) m[y * w + x] = 1;
    }
  return m;
}
