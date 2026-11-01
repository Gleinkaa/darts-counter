import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_POINTS,
  R_BULL,
  R_DOUBLE_IN,
  R_DOUBLE_OUT,
  R_OUTER_BULL,
  R_TREBLE_IN,
  R_TREBLE_OUT,
  SECTORS,
  polar,
  scoreAt,
  scoreLabel,
} from '../src/board.ts';

const EPS = 0.1;
const at = (r: number, deg: number) => {
  const p = polar(r, deg);
  return scoreAt(p.x, p.y);
};

describe('scoreAt', () => {
  it('20 is at the top, 6 right, 3 bottom, 11 left', () => {
    expect(scoreAt(0, 140).sector).toBe(20);
    expect(scoreAt(140, 0).sector).toBe(6);
    expect(scoreAt(0, -140).sector).toBe(3);
    expect(scoreAt(-140, 0).sector).toBe(11);
  });

  it('scores every sector in every ring at the sector centre', () => {
    SECTORS.forEach((s, i) => {
      const deg = i * 18;
      expect(at(60, deg)).toMatchObject({ ring: 'single', sector: s, points: s });
      expect(at(103, deg)).toMatchObject({ ring: 'treble', sector: s, points: 3 * s });
      expect(at(135, deg)).toMatchObject({ ring: 'single', sector: s, points: s });
      expect(at(166, deg)).toMatchObject({ ring: 'double', sector: s, points: 2 * s });
    });
  });

  it('sector borders: ±0.1° either side of each wire', () => {
    SECTORS.forEach((s, i) => {
      const next = SECTORS[(i + 1) % 20];
      const border = i * 18 + 9;
      expect(at(60, border - 0.1).sector).toBe(s);
      expect(at(60, border + 0.1).sector).toBe(next);
    });
  });

  it('bulls', () => {
    expect(scoreAt(0, 0)).toMatchObject({ ring: 'bull', points: 50 });
    expect(scoreAt(3, -3)).toMatchObject({ ring: 'bull', points: 50 });
    expect(scoreAt(10, 0)).toMatchObject({ ring: 'outer-bull', points: 25 });
  });

  it('ring borders at ±0.1 mm', () => {
    for (const deg of [0, 40, 133, 271]) {
      const s = at(60, deg).sector;
      expect(at(R_BULL - EPS, deg).points).toBe(50);
      expect(at(R_BULL + EPS, deg).points).toBe(25);
      expect(at(R_OUTER_BULL - EPS, deg).points).toBe(25);
      expect(at(R_OUTER_BULL + EPS, deg)).toMatchObject({ ring: 'single', sector: s });
      expect(at(R_TREBLE_IN - EPS, deg).ring).toBe('single');
      expect(at(R_TREBLE_IN + EPS, deg).ring).toBe('treble');
      expect(at(R_TREBLE_OUT - EPS, deg).ring).toBe('treble');
      expect(at(R_TREBLE_OUT + EPS, deg).ring).toBe('single');
      expect(at(R_DOUBLE_IN - EPS, deg).ring).toBe('single');
      expect(at(R_DOUBLE_IN + EPS, deg).ring).toBe('double');
      expect(at(R_DOUBLE_OUT - EPS, deg).ring).toBe('double');
      expect(at(R_DOUBLE_OUT + EPS, deg).ring).toBe('miss');
    }
  });

  it('miss outside the double ring', () => {
    expect(scoreAt(0, 200)).toMatchObject({ ring: 'miss', points: 0, multiplier: 0 });
    expect(scoreAt(500, 500).points).toBe(0);
    expect(scoreAt(NaN, NaN).ring).toBe('miss');
    expect(scoreAt(Infinity, 0).ring).toBe('miss');
  });

  it('labels', () => {
    expect(scoreLabel(at(103, 0))).toBe('T20');
    expect(scoreLabel(at(166, 90))).toBe('D6');
    expect(scoreLabel(scoreAt(0, 0))).toBe('Bull');
    expect(scoreLabel(scoreAt(0, 300))).toBe('Miss');
  });

  it('calibration points sit on the outer double wire of 20, 6, 3, 11', () => {
    expect(CALIBRATION_POINTS.map((p) => Math.round(Math.hypot(p.x, p.y)))).toEqual([170, 170, 170, 170]);
    expect(CALIBRATION_POINTS.map((p) => scoreAt(p.x * 0.99, p.y * 0.99).sector)).toEqual([20, 6, 3, 11]);
  });
});
