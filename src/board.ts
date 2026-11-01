// Canonical steel-tip dartboard geometry and the point -> score function.
//
// Source: WDF Playing & Tournament Rules, "Dartboard specification" (also used by the PDC):
//   inner bull (50) diameter 12.7 mm  -> r 6.35
//   outer bull (25) diameter 31.8 mm  -> r 15.9
//   treble ring inside/outside radius 99 / 107 mm (8 mm ring)
//   double ring inside/outside radius 162 / 170 mm (8 mm ring), 340 mm scoring diameter
//   sector order clockwise from the top: 20 1 18 4 13 6 10 15 2 17 3 19 7 16 8 11 14 9 12 5
// All radii are measured to the outside of the wire, which is the boundary we score against.
//
// Board coordinates are millimetres from the centre, x to the right, y UP (20 is at +y).

export const R_BULL = 6.35;
export const R_OUTER_BULL = 15.9;
export const R_TREBLE_IN = 99;
export const R_TREBLE_OUT = 107;
export const R_DOUBLE_IN = 162;
export const R_DOUBLE_OUT = 170;
/** Outer edge of the black number ring; beyond this is the wall/cabinet. */
export const R_BOARD = 225.5;

export const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5] as const;
export const SECTOR_DEG = 18;

export type Ring = 'miss' | 'single' | 'double' | 'treble' | 'outer-bull' | 'bull';

export interface Score {
  ring: Ring;
  /** 1..20 for numbered rings, 25 for the bulls, 0 for a miss. */
  sector: number;
  multiplier: 0 | 1 | 2 | 3;
  points: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Angle in degrees, clockwise from straight up (the centre of 20), in [0, 360). */
export function angleFromTop(x: number, y: number): number {
  const a = (Math.atan2(x, y) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

export function sectorAt(x: number, y: number): number {
  const a = angleFromTop(x, y);
  return SECTORS[Math.floor(((a + SECTOR_DEG / 2) % 360) / SECTOR_DEG)];
}

export function makeScore(ring: Ring, sector = 0): Score {
  switch (ring) {
    case 'miss':
      return { ring, sector: 0, multiplier: 0, points: 0 };
    case 'bull':
      return { ring, sector: 25, multiplier: 2, points: 50 };
    case 'outer-bull':
      return { ring, sector: 25, multiplier: 1, points: 25 };
    case 'single':
      return { ring, sector, multiplier: 1, points: sector };
    case 'treble':
      return { ring, sector, multiplier: 3, points: sector * 3 };
    case 'double':
      return { ring, sector, multiplier: 2, points: sector * 2 };
  }
}

/** Score of a dart whose tip is at board point (x, y) in mm. */
export function scoreAt(x: number, y: number): Score {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return makeScore('miss'); // degenerate mapping
  const r = Math.hypot(x, y);
  if (r < R_BULL) return makeScore('bull');
  if (r < R_OUTER_BULL) return makeScore('outer-bull');
  if (r >= R_DOUBLE_OUT) return makeScore('miss');
  const s = sectorAt(x, y);
  if (r >= R_DOUBLE_IN) return makeScore('double', s);
  if (r >= R_TREBLE_IN && r < R_TREBLE_OUT) return makeScore('treble', s);
  return makeScore('single', s);
}

export function scoreLabel(s: Score): string {
  switch (s.ring) {
    case 'miss':
      return 'Miss';
    case 'bull':
      return 'Bull';
    case 'outer-bull':
      return '25';
    case 'single':
      return String(s.sector);
    case 'double':
      return `D${s.sector}`;
    case 'treble':
      return `T${s.sector}`;
  }
}

/** Board point at radius r (mm), clockwise angle from the top (degrees). */
export function polar(r: number, deg: number): Pt {
  const a = (deg * Math.PI) / 180;
  return { x: r * Math.sin(a), y: r * Math.cos(a) };
}

/** Clockwise angle of the centre of a numbered sector. */
export function sectorCenterDeg(sector: number): number {
  const i = SECTORS.indexOf(sector as (typeof SECTORS)[number]);
  if (i < 0) throw new Error(`no sector ${sector}`);
  return i * SECTOR_DEG;
}

/** Calibration targets: outer edge of the double ring at the centre of 20, 6, 3 and 11. */
export const CALIBRATION_SECTORS = [20, 6, 3, 11] as const;
export const CALIBRATION_POINTS: Pt[] = CALIBRATION_SECTORS.map((s) => polar(R_DOUBLE_OUT, sectorCenterDeg(s)));
