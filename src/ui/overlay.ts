// Calibration overlay drawn on top of the camera canvas: the six ring circles and the twenty sector wires,
// pushed through the fitted homography H (board mm -> image px), plus the sector numbers just outside the
// double ring. Only plain canvas 2D calls, so a test can pass a recorder object instead of a real context:
//   beginPath, moveTo, lineTo, closePath, stroke, arc, fillText
// and the properties globalAlpha, strokeStyle, fillStyle, lineWidth, lineJoin, font, textAlign, textBaseline.
//
// Nothing here calls ctx.save()/restore() or setLineDash(), so a minimal stub works.

import {
  R_BULL,
  R_DOUBLE_IN,
  R_DOUBLE_OUT,
  R_OUTER_BULL,
  R_TREBLE_IN,
  R_TREBLE_OUT,
  SECTORS,
  SECTOR_DEG,
  polar,
  type Pt,
} from '../board.ts';
import { apply, type Mat3 } from '../homography.ts';

/** Radii of the six rings, centre outwards. */
export const OVERLAY_RINGS = [R_BULL, R_OUTER_BULL, R_TREBLE_IN, R_TREBLE_OUT, R_DOUBLE_IN, R_DOUBLE_OUT] as const;
/** Points per ring circle; 120 keeps the polyline visually round at phone resolution. */
export const CIRCLE_STEPS = 120;

export interface BoardOverlayOpts {
  color?: string;
  alpha?: number;
  lineWidth?: number;
}

/**
 * Draw the fitted board on top of the camera image: 6 ring circles (120-point polylines), 20 sector wires from
 * the outer bull to the double ring, and the sector numbers just outside the double ring.
 */
export function drawBoardOverlay(ctx: CanvasRenderingContext2D, H: Mat3, opts: BoardOverlayOpts = {}): void {
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = opts.alpha ?? 0.9;
  ctx.strokeStyle = opts.color ?? '#34d399';
  ctx.lineWidth = opts.lineWidth ?? 2;
  ctx.lineJoin = 'round';

  for (const r of OVERLAY_RINGS) {
    ctx.beginPath();
    for (let k = 0; k < CIRCLE_STEPS; k++) {
      const q = apply(H, polar(r, (360 * k) / CIRCLE_STEPS));
      if (k === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // Wires sit on the sector boundaries: 18 deg apart, offset half a sector from the sector centres.
  for (let k = 0; k < SECTORS.length; k++) {
    const deg = k * SECTOR_DEG + SECTOR_DEG / 2;
    const a = apply(H, polar(R_OUTER_BULL, deg));
    const b = apply(H, polar(R_DOUBLE_OUT, deg));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.fillStyle = opts.color ?? '#34d399';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rNum = R_DOUBLE_OUT + 16;
  for (let k = 0; k < SECTORS.length; k++) {
    const p = apply(H, polar(rNum, k * SECTOR_DEG));
    ctx.fillText(String(SECTORS[k]), p.x, p.y);
  }

  ctx.globalAlpha = prevAlpha ?? 1;
}

export interface DartMarkerOpts {
  color?: string;
}

/** Ring + cross at image point p, with the score label next to it. */
export function drawDartMarker(ctx: CanvasRenderingContext2D, p: Pt, label: string, opts: DartMarkerOpts = {}): void {
  const prevAlpha = ctx.globalAlpha;
  const color = opts.color ?? '#ffd60a';
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;

  const r = 9;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(p.x - r * 1.7, p.y);
  ctx.lineTo(p.x + r * 1.7, p.y);
  ctx.moveTo(p.x, p.y - r * 1.7);
  ctx.lineTo(p.x, p.y + r * 1.7);
  ctx.stroke();

  ctx.font = '700 16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, p.x + r * 1.9, p.y - r);

  ctx.globalAlpha = prevAlpha ?? 1;
}
