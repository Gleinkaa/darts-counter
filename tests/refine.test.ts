import { describe, expect, it } from 'vitest';
import { CALIBRATION_POINTS, polar } from '../src/board.ts';
import { apply, fitHomography } from '../src/homography.ts';
import { refineCalibration } from '../src/refine.ts';
import { makeScene, renderFrame, rng } from '../synth/render.ts';

/** Worst image-space disagreement with the true homography over the scoring area. */
function worstErrPx(H: number[], Htrue: number[]) {
  let worst = 0;
  for (let r = 20; r <= 170; r += 30)
    for (let deg = 0; deg < 360; deg += 15) {
      const a = apply(H, polar(r, deg)), b = apply(Htrue, polar(r, deg));
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
  return worst;
}

describe('refineCalibration', () => {
  it('snaps sloppy taps (σ 3 px) onto the wires', () => {
    for (const seed of [11, 12, 13]) {
      const sc = makeScene(seed);
      const R = rng(seed);
      const taps = CALIBRATION_POINTS.map((p) => {
        const q = apply(sc.H, p);
        return { x: q.x + R.normal() * 3, y: q.y + R.normal() * 3 };
      });
      const H0 = fitHomography(CALIBRATION_POINTS, taps);
      const res = refineCalibration(renderFrame(sc, [], seed), H0, CALIBRATION_POINTS);
      expect(res.ok).toBe(true);
      expect(worstErrPx(res.H, sc.H)).toBeLessThan(Math.min(1.5, worstErrPx(H0, sc.H)));
    }
  });

  it('keeps the taps when the picture is not a board', () => {
    const sc = makeScene(5);
    const H0 = sc.H;
    const blank = renderFrame(sc, [], 1);
    blank.data.fill(90);
    const res = refineCalibration(blank, H0, CALIBRATION_POINTS);
    expect(res.ok).toBe(false);
    expect(res.H).toBe(H0);
  });
});
