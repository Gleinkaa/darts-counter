// Board picture for the segment picker / one-tap correction UI.
//
// Pure string building, no DOM: returns an <svg> whose viewBox is in BOARD MILLIMETRES (-235..235), so the
// caller only has to keep the aspect ratio. SVG y points down while board y points up, so every board point
// (x, y) is emitted at (x, -y); the picture therefore looks exactly like the board (20 at the top).
//
// Geometry comes from src/board.ts; the radii are imported, never retyped.

import {
  CALIBRATION_POINTS,
  R_BOARD,
  R_BULL,
  R_DOUBLE_IN,
  R_DOUBLE_OUT,
  R_OUTER_BULL,
  R_TREBLE_IN,
  R_TREBLE_OUT,
  SECTORS,
  SECTOR_DEG,
  polar,
  scoreAt,
  type Ring,
  type Score,
} from '../board.ts';

const BLACK = '#1c1a1a';
const CREAM = '#e8dab6';
const RED = '#c4242a';
const GREEN = '#168040';
const WIRE = '#c8c8cc';
const RIM = '#121212';
const NUMBER_R = R_DOUBLE_OUT + 26; // ≈ 196 mm, white numbers in the black ring
/** viewBox is in board mm, with 10 mm of margin so the rim and the numbers are never clipped. */
const VIEW = R_BOARD + 9.5; // 235

export interface BoardSvgOpts {
  /** Region to outline as the current selection, e.g. { ring: 'treble', sector: 20 }. */
  highlight?: { ring: Ring; sector: number } | null;
  /** Which calibration target (0..3, in CALIBRATION_POINTS order) gets a pulsing marker. */
  calibrationIndex?: number;
}

/** Board millimetres -> SVG user units (y flipped). */
const svgPt = (r: number, deg: number): { x: number; y: number } => {
  const p = polar(r, deg);
  return { x: p.x, y: -p.y };
};

const N = (v: number): string => String(Number(v.toFixed(2)));

/** Annular wedge between rIn and rOut around degCenter, drawn as two arcs. */
function wedge(rIn: number, rOut: number, degCenter: number): string {
  const a0 = degCenter - SECTOR_DEG / 2;
  const a1 = degCenter + SECTOR_DEG / 2;
  const o0 = svgPt(rOut, a0);
  const o1 = svgPt(rOut, a1);
  const i1 = svgPt(rIn, a1);
  const i0 = svgPt(rIn, a0);
  // Sweep flag 1 follows increasing board angle (clockwise on the board); the inner arc runs back.
  return (
    `M ${N(o0.x)} ${N(o0.y)}` +
    ` A ${N(rOut)} ${N(rOut)} 0 0 1 ${N(o1.x)} ${N(o1.y)}` +
    ` L ${N(i1.x)} ${N(i1.y)}` +
    ` A ${N(rIn)} ${N(rIn)} 0 0 0 ${N(i0.x)} ${N(i0.y)} Z`
  );
}

/** Full disc as a path (so the bulls are <path> regions like every sector). */
function disc(r: number): string {
  return `M ${N(-r)} 0 A ${N(r)} ${N(r)} 0 1 0 ${N(r)} 0 A ${N(r)} ${N(r)} 0 1 0 ${N(-r)} 0 Z`;
}

function region(d: string, fill: string, ring: Ring, sector: number, hl: boolean): string {
  const cls = hl ? ' class="hl"' : '';
  return `<path d="${d}" fill="${fill}" stroke="${WIRE}" stroke-width="0.8" data-ring="${ring}" data-sector="${sector}"${cls}/>`;
}

const STYLE = [
  '.hl{stroke:#fff;stroke-width:2.6}',
  '.cal-target{fill:#ffd60a;stroke:#111;stroke-width:1.4;animation:calPulse 1.1s ease-in-out infinite}',
  '@keyframes calPulse{0%,100%{opacity:1}50%{opacity:.35}}',
].join('');

/** SVG picture of the board; one <path> per scoring region, plus the number ring. */
export function boardSvg(opts: BoardSvgOpts = {}): string {
  const hl = opts.highlight ?? null;
  const isHl = (ring: Ring, sector: number): boolean => hl !== null && hl.ring === ring && hl.sector === sector;

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="${-VIEW} ${-VIEW} ${2 * VIEW} ${2 * VIEW}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="dartboard">`,
  );
  parts.push(`<style>${STYLE}</style>`);
  // Black number ring; the scoring regions are painted on top of it.
  parts.push(`<circle cx="0" cy="0" r="${N(R_BOARD)}" fill="${RIM}" stroke="${WIRE}" stroke-width="1.5"/>`);

  for (let i = 0; i < SECTORS.length; i++) {
    const sector = SECTORS[i];
    const deg = i * SECTOR_DEG;
    const dark = i % 2 === 0; // 20, 18, 13, … are the black sectors
    const single = dark ? BLACK : CREAM;
    const ringCol = dark ? RED : GREEN;
    const rings: [Ring, number, number, string][] = [
      ['single', R_OUTER_BULL, R_TREBLE_IN, single],
      ['treble', R_TREBLE_IN, R_TREBLE_OUT, ringCol],
      ['single', R_TREBLE_OUT, R_DOUBLE_IN, single],
      ['double', R_DOUBLE_IN, R_DOUBLE_OUT, ringCol],
    ];
    for (const [ring, rIn, rOut, fill] of rings)
      parts.push(region(wedge(rIn, rOut, deg), fill, ring, sector, isHl(ring, sector)));
  }

  parts.push(region(disc(R_OUTER_BULL), GREEN, 'outer-bull', 25, isHl('outer-bull', 25)));
  parts.push(region(disc(R_BULL), RED, 'bull', 25, isHl('bull', 25)));

  for (let i = 0; i < SECTORS.length; i++) {
    const p = svgPt(NUMBER_R, i * SECTOR_DEG);
    parts.push(
      `<text x="${N(p.x)}" y="${N(p.y)}" fill="#f4f4f4" font-family="system-ui" font-size="26" text-anchor="middle" dominant-baseline="central">${SECTORS[i]}</text>`,
    );
  }

  const ci = opts.calibrationIndex;
  if (ci !== undefined && ci >= 0 && ci < CALIBRATION_POINTS.length) {
    const c = CALIBRATION_POINTS[ci];
    parts.push(`<circle class="cal-target" cx="${N(c.x)}" cy="${N(-c.y)}" r="8"/>`);
  }

  parts.push('</svg>');
  return parts.join('');
}

/** Score of a tap given in board millimetres. The caller converts the tap itself: x = svgX, y = -svgY. */
export function svgHit(boardX: number, boardY: number): Score {
  return scoreAt(boardX, boardY);
}
