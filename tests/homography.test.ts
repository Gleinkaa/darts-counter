import { describe, expect, it } from 'vitest';
import { apply, fitHomography, invert, mul, normalise } from '../src/homography.ts';
import { CALIBRATION_POINTS } from '../src/board.ts';

// Deterministic PRNG so the tests are reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const H_TRUE = [1.2, 0.15, 320, -0.05, -0.9, 240, 0.0006, -0.0004, 1];

describe('homography', () => {
  it('recovers a known homography from the 4 calibration points', () => {
    const dst = CALIBRATION_POINTS.map((p) => apply(H_TRUE, p));
    const H = fitHomography(CALIBRATION_POINTS, dst);
    H.forEach((v, i) => expect(v).toBeCloseTo(H_TRUE[i], 6));
  });

  it('maps arbitrary board points exactly once fitted', () => {
    const r = rng(1);
    const dst = CALIBRATION_POINTS.map((p) => apply(H_TRUE, p));
    const H = fitHomography(CALIBRATION_POINTS, dst);
    for (let i = 0; i < 50; i++) {
      const p = { x: (r() - 0.5) * 400, y: (r() - 0.5) * 400 };
      const a = apply(H, p);
      const b = apply(H_TRUE, p);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
    }
  });

  it('inverse round-trips image -> board -> image', () => {
    const Hi = invert(H_TRUE);
    const I = normalise(mul(H_TRUE, Hi)); // equal to identity up to scale
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(I[i]).toBeCloseTo(v, 9));
    const r = rng(7);
    for (let i = 0; i < 50; i++) {
      const p = { x: (r() - 0.5) * 300, y: (r() - 0.5) * 300 };
      const back = apply(Hi, apply(H_TRUE, p));
      expect(back.x).toBeCloseTo(p.x, 8);
      expect(back.y).toBeCloseTo(p.y, 8);
    }
  });

  it('least-squares fit with > 4 noisy points stays close', () => {
    const r = rng(3);
    const src = Array.from({ length: 12 }, () => ({ x: (r() - 0.5) * 340, y: (r() - 0.5) * 340 }));
    const dst = src.map((p) => {
      const q = apply(H_TRUE, p);
      return { x: q.x + (r() - 0.5) * 0.5, y: q.y + (r() - 0.5) * 0.5 };
    });
    const H = fitHomography(src, dst);
    const q = apply(H, { x: 0, y: 0 });
    expect(Math.hypot(q.x - 320, q.y - 240)).toBeLessThan(0.5);
  });

  it('rejects degenerate (collinear) input', () => {
    const src = [0, 1, 2, 3].map((i) => ({ x: i, y: i }));
    expect(() => fitHomography(src, src)).toThrow();
  });
});
