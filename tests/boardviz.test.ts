import { describe, expect, it } from 'vitest';
import { CALIBRATION_POINTS, SECTORS } from '../src/board.ts';
import { boardSvg, svgHit } from '../src/ui/boardSvg.ts';
import { CIRCLE_STEPS, OVERLAY_RINGS, drawBoardOverlay, drawDartMarker } from '../src/ui/overlay.ts';

// --- helpers ---------------------------------------------------------------------------------

const flip = (v: number): string => String(Number(v.toFixed(2)));

/** Every <path> element of the svg. */
const pathsOf = (svg: string): string[] => svg.match(/<path[^>]*>/g) ?? [];
const dOf = (el: string): string => /d="([^"]*)"/.exec(el)?.[1] ?? '';
const numsOf = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

interface RecPt {
  x: number;
  y: number;
}

/** Minimal canvas 2D stand-in that records the polyline points, split at each beginPath. */
function recorder() {
  const pts: RecPt[] = [];
  const segments: RecPt[][] = [];
  const labels: { text: string; x: number; y: number }[] = [];
  let cur: RecPt[] = [];
  const flush = (): void => {
    if (cur.length) segments.push(cur);
    cur = [];
  };
  const push = (x: number, y: number): void => {
    const q = { x, y };
    cur.push(q);
    pts.push(q);
  };
  const ctx = {
    globalAlpha: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    lineJoin: 'miter',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    beginPath: (): void => flush(),
    moveTo: (x: number, y: number): void => push(x, y),
    lineTo: (x: number, y: number): void => push(x, y),
    closePath: (): void => {},
    stroke: (): void => {},
    arc: (x: number, y: number, _r: number, _a0: number, _a1: number): void => push(x, y),
    fillText: (text: string, x: number, y: number): void => {
      labels.push({ text, x, y });
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    pts,
    labels,
    segments: () => {
      flush();
      return segments;
    },
    alpha: () => ctx.globalAlpha,
  };
}

// --- boardSvg --------------------------------------------------------------------------------

describe('boardSvg regions', () => {
  const svg = boardSvg();

  it('has exactly 82 data-ring regions (20 sectors x 4 rings + 2 bulls)', () => {
    expect(svg.match(/data-ring="/g)?.length).toBe(82);
    expect(pathsOf(svg).length).toBe(82);
    for (const ring of ['single', 'treble', 'double', 'outer-bull', 'bull'])
      expect(svg).toContain(`data-ring="${ring}"`);
  });

  it('counts each ring right: 40 singles, 20 trebles, 20 doubles, 1 outer bull, 1 bull', () => {
    expect(svg.match(/data-ring="single"/g)?.length).toBe(40);
    expect(svg.match(/data-ring="treble"/g)?.length).toBe(20);
    expect(svg.match(/data-ring="double"/g)?.length).toBe(20);
    expect(svg.match(/data-ring="outer-bull"/g)?.length).toBe(1);
    expect(svg.match(/data-ring="bull"/g)?.length).toBe(1);
    expect(svg.match(/data-sector="25"/g)?.length).toBe(2);
  });

  it('uses the board viewBox and one region per sector number', () => {
    expect(svg).toContain('viewBox="-235 -235 470 470"');
    for (const s of SECTORS) expect(svg.match(new RegExp(`data-sector="${s}"`, 'g'))?.length).toBe(4);
  });

  it('shows all twenty numbers, 20 at the top', () => {
    for (const s of SECTORS) expect(svg).toContain(`>${s}<`);
    const text20 = svg.match(/<text[^>]*>20<\/text>/)?.[0] ?? '';
    expect(text20).not.toBe('');
    const [x, y] = numsOf(text20);
    expect(Math.abs(x)).toBeLessThan(1);
    expect(y).toBeLessThan(-150); // SVG y up is negative; the 20 must be above the centre
  });

  it('puts every sector-20 region at the top (first path point has svg y < 0)', () => {
    const p20 = pathsOf(svg).filter((el) => el.includes('data-sector="20"'));
    expect(p20.length).toBe(4);
    for (const el of p20) {
      const n = numsOf(dOf(el));
      expect(n.length).toBeGreaterThan(5);
      expect(n[1]).toBeLessThan(0);
    }
  });

  it('formats every d attribute as numbers only', () => {
    for (const el of pathsOf(svg)) {
      const d = dOf(el);
      expect(d.length).toBeGreaterThan(0);
      expect(d).not.toMatch(/NaN|undefined|Infinity|null/);
      const junk = d
        .replace(/-?\d+(?:\.\d+)?/g, '')
        .replace(/[MALZ]/g, '')
        .replace(/[\s,]/g, '');
      expect(junk).toBe('');
      expect(d).toMatch(/^M -?\d/);
    }
  });
});

describe('boardSvg options', () => {
  it('adds hl to exactly one region', () => {
    expect(boardSvg()).not.toContain('class="hl"');
    const svg = boardSvg({ highlight: { ring: 'treble', sector: 20 } });
    const hl = pathsOf(svg).filter((el) => el.includes('class="hl"'));
    expect(hl.length).toBe(1);
    expect(hl[0]).toContain('data-ring="treble"');
    expect(hl[0]).toContain('data-sector="20"');
    expect(svg.match(/class="hl"/g)?.length).toBe(1);
  });

  it('can highlight a bull', () => {
    const hl = pathsOf(boardSvg({ highlight: { ring: 'bull', sector: 25 } })).filter((el) => el.includes('class="hl"'));
    expect(hl.length).toBe(1);
    expect(hl[0]).toContain('data-ring="bull"');
  });

  it('draws one pulsing calibration marker at the requested point', () => {
    for (let i = 0; i < CALIBRATION_POINTS.length; i++) {
      const svg = boardSvg({ calibrationIndex: i });
      expect(svg.match(/cal-target/g)?.length).toBe(2); // the class rule + the marker
      const p = CALIBRATION_POINTS[i];
      expect(svg).toContain(`cx="${flip(p.x)}"`);
      expect(svg).toContain(`cy="${flip(-p.y)}"`);
    }
    expect(boardSvg()).not.toContain('cal-target"');
  });
});

describe('svgHit', () => {
  it('scores a tap given in board millimetres', () => {
    expect(svgHit(0, 103).points).toBe(60);
    expect(svgHit(0, 0).points).toBe(50);
    expect(svgHit(0, 180).ring).toBe('miss');
  });
});

// --- overlay ---------------------------------------------------------------------------------

describe('drawBoardOverlay', () => {
  // Board (x, y) -> image (x + 320, 240 - y): a flip plus a translate, so every radius is preserved.
  const H = [1, 0, 320, 0, -1, 240, 0, 0, 1];
  const C = { x: 320, y: 240 };

  it('draws six ring circles of the board radii, all points finite', () => {
    const rec = recorder();
    drawBoardOverlay(rec.ctx, H);
    const segs = rec.segments();

    for (const p of rec.pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }

    const circles = segs.filter((s) => s.length === CIRCLE_STEPS);
    expect(circles.length).toBe(6);
    circles.forEach((circle, i) => {
      for (const p of circle) expect(Math.hypot(p.x - C.x, p.y - C.y)).toBeCloseTo(OVERLAY_RINGS[i], 6);
    });
    expect(circles[5].length).toBe(120);
    for (const p of circles[5]) expect(Math.hypot(p.x - C.x, p.y - C.y)).toBeCloseTo(170, 6);
  });

  it('draws twenty sector wires and the twenty numbers', () => {
    const rec = recorder();
    drawBoardOverlay(rec.ctx, H, { color: '#fff', alpha: 0.5, lineWidth: 3 });
    const wires = rec.segments().filter((s) => s.length === 2);
    expect(wires.length).toBe(20);
    for (const [a, b] of wires) {
      expect(Math.hypot(a.x - C.x, a.y - C.y)).toBeCloseTo(15.9, 6);
      expect(Math.hypot(b.x - C.x, b.y - C.y)).toBeCloseTo(170, 6);
    }
    expect(rec.labels.map((l) => l.text)).toEqual(SECTORS.map(String));
    for (const l of rec.labels) {
      expect(Number.isFinite(l.x)).toBe(true);
      expect(Math.hypot(l.x - C.x, l.y - C.y)).toBeCloseTo(186, 6);
    }
    expect(rec.alpha()).toBe(1); // restored
  });

  it('survives a real perspective homography', () => {
    const persp = [38.2, -12.4, 320, 9.7, -40.1, 240, 0.012, -0.004, 1];
    const rec = recorder();
    drawBoardOverlay(rec.ctx, persp);
    for (const p of rec.pts) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(Number.isNaN(p.x + p.y)).toBe(false);
    }
  });
});

describe('drawDartMarker', () => {
  it('draws a ring, a cross and the label at the image point', () => {
    const rec = recorder();
    drawDartMarker(rec.ctx, { x: 300, y: 200 }, 'T20');
    expect(rec.pts.length).toBeGreaterThanOrEqual(5); // ring + 4 cross ends
    for (const p of rec.pts) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(rec.labels).toEqual([expect.objectContaining({ text: 'T20' })]);
    expect(rec.labels[0].x).toBeGreaterThan(300); // label sits to the right of the marker
  });
});
