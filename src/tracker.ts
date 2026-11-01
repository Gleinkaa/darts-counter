// Turns a stream of camera frames into throw events.
//
// It keeps the last *settled* frame. When the picture changes and then holds still for
// `settleMs`, the new settled frame is compared with the old one:
//   - close to the empty-board reference  -> "empty" (darts were pulled: the visit ends)
//   - otherwise detectDart(old, new)       -> "dart"
//   - a big change with no dart            -> "nodart" (someone walked past, light changed…)
// Motion is measured on a 4x-downsampled grey image, so the per-frame cost is small; the full
// detector runs only once per settle.

import { type Pt } from './board.ts';
import { type Detection, detectDart } from './detect.ts';
import { apply, invert, type Mat3 } from './homography.ts';
import { type Img } from './img.ts';
import { boardMask } from './mask.ts';

export type TrackerEvent =
  | { type: 'dart'; det: Detection; board: Pt }
  | { type: 'empty' }
  /** A dart was pulled out or fell out mid-visit; never scored. */
  | { type: 'removed'; board: Pt }
  | { type: 'nodart'; changed: number }
  | { type: 'busy'; changed: number };

export interface TrackerOpts {
  settleMs?: number;
  /** Fraction of the board (small image) that must change to count as "something happened". */
  minChange?: number;
  /** Below this fraction of change against the empty reference the board counts as empty. */
  emptyMax?: number;
}

const SCALE = 4;

interface Small {
  w: number;
  h: number;
  g: Float32Array;
}

function shrink(im: Img): Small {
  const w = Math.floor(im.width / SCALE), h = Math.floor(im.height / SCALE);
  const g = new Float32Array(w * h);
  const d = im.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < SCALE; yy++)
        for (let xx = 0; xx < SCALE; xx++) {
          const j = ((y * SCALE + yy) * im.width + x * SCALE + xx) * 4;
          s += 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        }
      g[y * w + x] = s / (SCALE * SCALE);
    }
  return { w, h, g };
}

export class ThrowTracker {
  readonly H: Mat3;
  readonly Hi: Mat3;
  readonly mask: Uint8Array;
  private smallMask: Uint8Array;
  private settleMs: number;
  private minChange: number;
  private emptyMax: number;
  private stable: Img | null = null;
  private stableSmall: Small | null = null;
  private empty: Small | null = null;
  private emptyFull: Img | null = null;
  private awaitStill = -1;
  private last: Small | null = null;
  private stillSince = -1;
  private pending = false;
  busy = false;

  constructor(H: Mat3, w: number, h: number, opts: TrackerOpts = {}) {
    this.H = H;
    this.Hi = invert(H);
    this.mask = boardMask(H, w, h);
    const sw = Math.floor(w / SCALE), sh = Math.floor(h / SCALE);
    this.smallMask = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) this.smallMask[y * sw + x] = this.mask[(y * SCALE + 2) * w + x * SCALE + 2];
    this.settleMs = opts.settleMs ?? 350;
    this.minChange = opts.minChange ?? 0.0015;
    this.emptyMax = opts.emptyMax ?? 0.002;
  }

  /**
   * Take the empty-board reference from the first moment the picture holds still (3 frames), rather
   * than the instant the user tapped "start" (a hand may still be in view). No events until then.
   */
  resetWhenStill(): void {
    this.stable = null;
    this.awaitStill = 0;
  }

  /** Use this frame as the empty board. Only call it when the user has confirmed the board is empty. */
  reset(frame: Img): void {
    this.stable = frame;
    this.stableSmall = shrink(frame);
    this.empty = this.stableSmall;
    this.emptyFull = frame;
    this.last = this.stableSmall;
    this.pending = false;
    this.stillSince = -1;
  }

  /** Take this frame as the current state of the board (darts may be in it); keeps the empty reference. */
  resync(frame: Img): void {
    if (!this.emptyFull) return this.reset(frame);
    this.stable = frame;
    this.stableSmall = shrink(frame);
    this.last = this.stableSmall;
    this.pending = false;
    this.stillSince = -1;
  }

  /** Fraction of board pixels that differ between two small frames (exposure-compensated). */
  private changed(a: Small, b: Small): number {
    // Median brightness ratio, to ignore auto-exposure drift.
    const r: number[] = [];
    for (let i = 0; i < a.g.length; i += 7) if (this.smallMask[i] && a.g[i] > 20) r.push(b.g[i] / a.g[i]);
    r.sort((x, y) => x - y);
    const k = r.length ? r[r.length >> 1] : 1;
    let n = 0, c = 0;
    for (let i = 0; i < a.g.length; i++) {
      if (!this.smallMask[i]) continue;
      n++;
      if (Math.abs(b.g[i] - a.g[i] * k) > 14) c++;
    }
    return n ? c / n : 0;
  }

  feed(frame: Img, tMs: number): TrackerEvent[] {
    if (!this.stable) {
      const s0 = shrink(frame);
      if (this.awaitStill >= 0) {
        this.awaitStill = this.last && this.changed(this.last, s0) <= this.minChange / 4 ? this.awaitStill + 1 : 0;
        this.last = s0;
        if (this.awaitStill < 3) return [];
        this.awaitStill = -1;
      }
      this.reset(frame);
      return [];
    }
    const s = shrink(frame);
    const events: TrackerEvent[] = [];
    // Low gate: a far, thin dart can change well under minChange of the board.
    const moving = this.changed(this.last!, s) > this.minChange / 4;
    this.last = s;
    if (moving) {
      this.stillSince = -1;
      this.pending = true;
      const ch = this.changed(this.stableSmall!, s);
      if (ch > 0.08 && !this.busy) {
        this.busy = true;
        events.push({ type: 'busy', changed: ch });
      }
      return events;
    }
    if (this.stillSince < 0) this.stillSince = tMs;
    const vsStable = this.changed(this.stableSmall!, s);
    if (!this.pending && vsStable <= this.minChange) return events;
    if (tMs - this.stillSince < this.settleMs) return events;

    // Settled after a change.
    this.pending = false;
    this.busy = false;
    const before = this.stable;
    const eNow = this.changed(this.empty!, s);
    const eBefore = this.changed(this.empty!, this.stableSmall!);
    this.stable = frame;
    this.stableSmall = s;
    // "Empty" is relative: the board must have gone back to the empty reference. An absolute
    // threshold alone would swallow a small, far-away first dart. The thresholds alone also pass
    // when the darts are pulled in two goes and one small far dart is still in: so the detector
    // must find nothing against the empty board either.
    if (eNow <= this.emptyMax && eNow < 0.35 * eBefore && !detectDart(this.emptyFull!, frame, { mask: this.mask, H: this.H })) {
      // Follow slow lighting drift: the board is verified empty, so it is safe as the new reference.
      this.empty = s;
      this.emptyFull = frame;
      events.push({ type: 'empty' });
      return events;
    }
    const det = detectDart(before, frame, { mask: this.mask, H: this.H });
    if (det && vsStable < 0.08) {
      // Differencing is symmetric: a dart pulled out (or falling out) looks like a new one.
      // Along the detected dart, a removal makes the picture look *more* like the empty board.
      // A removal also shrinks the area that differs from the empty board; an addition never does.
      if (eNow < eBefore && this.removal(before, frame, det)) events.push({ type: 'removed', board: apply(this.Hi, det.tip) });
      else events.push({ type: 'dart', det, board: apply(this.Hi, det.tip) });
    } else if (vsStable > this.minChange) events.push({ type: 'nodart', changed: vsStable });
    return events;
  }

  /** True when, along the detected dart, `after` matches the empty board better than `before` does. */
  private removal(before: Img, after: Img, det: Detection): boolean {
    const E = this.emptyFull!;
    let dB = 0, dA = 0, n = 0;
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      const x = Math.round(det.tip.x + (det.tail.x - det.tip.x) * t - 0.5);
      const y = Math.round(det.tip.y + (det.tail.y - det.tip.y) * t - 0.5);
      if (x < 0 || y < 0 || x >= E.width || y >= E.height) continue;
      const i = (y * E.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        dB += Math.abs(before.data[i + c] - E.data[i + c]);
        dA += Math.abs(after.data[i + c] - E.data[i + c]);
      }
      n++;
    }
    return n > 0 && dA < dB;
  }
}
