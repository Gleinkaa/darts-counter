// Turns a stream of camera frames into throw events.
//
// It keeps the last *settled* frame. When the picture changes and then holds still for
// `settleMs`, the new settled frame is compared with the old one:
//   - back to the empty-board reference   -> "empty" once the board has stayed so for `emptyHoldMs`
//                                            (the darts were pulled: the visit ends)
//   - otherwise detectDart(old, new)        -> "dart", or "removed" when a dart came out
//   - a change with no dart                 -> "nodart"
//   - most of the board different and still -> "blocked": the old settled frame is kept until the
//     view clears ("unblocked"). Still blocked after `checkMs` (a light switched on or off, the camera
//     was knocked) -> "check": no events at all until the board is confirmed empty (reset).
// A dart's tip is read in each of the last REST_FRAMES still frames and combined (restingTip), so
// one noisy frame does not decide the score.
// Motion is measured on a 4x-downsampled grey image, so the per-frame cost is small; the full
// detector runs only at a settle.

import { type Pt } from './board.ts';
import { type Detection, detectDart, restingTip } from './detect.ts';
import { apply, invert, type Mat3 } from './homography.ts';
import { type Img } from './img.ts';
import { boardMask } from './mask.ts';

/** Still frames whose tips are combined into one (see docs/eval.md: "tip over resting frames"). */
export const REST_FRAMES = 4;

export type TrackerEvent =
  | { type: 'dart'; det: Detection; board: Pt }
  | { type: 'empty' }
  /** A dart was pulled out or fell out mid-visit; never scored. */
  | { type: 'removed'; board: Pt }
  | { type: 'nodart'; changed: number }
  | { type: 'busy'; changed: number }
  /** Most of the board looks different and holds still: a hand resting on it, a light switched. */
  | { type: 'blocked'; changed: number }
  | { type: 'unblocked' }
  /** Blocked for `checkMs`: the empty-board reference is no longer valid. Silent until reset. */
  | { type: 'check'; changed: number };

export interface TrackerOpts {
  settleMs?: number;
  /** Fraction of the board (small image) that must change to count as "something happened". */
  minChange?: number;
  /** Below this fraction of change against the empty reference the board counts as empty. */
  emptyMax?: number;
  /** The board must look empty and still this long, from the first still frame, before "empty". */
  emptyHoldMs?: number;
  /** A settled view that stays blocked this long asks for a board check. */
  checkMs?: number;
}

/** A change bigger than this fraction of the board is a hand or body, never a dart. */
const BIG_CHANGE = 0.08;

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
  private emptyHoldMs: number;
  private checkMs: number;
  private stable: Img | null = null;
  private stableSmall: Small | null = null;
  private empty: Small | null = null;
  private emptyFull: Img | null = null;
  private awaitStill = -1;
  private last: Small | null = null;
  private stillSince = -1;
  /** The last REST_FRAMES still frames since stillSince (the newest last). */
  private rest: Img[] = [];
  /** The first still frame, to notice a change too small or slow for the motion gate. */
  private restStart: Small | null = null;
  private pending = false;
  /** stillSince of a settle that found the board empty; "empty" fires after emptyHoldMs. */
  private emptySince = -1;
  private blocked = false;
  /** Start of the current still, blocked stretch; any motion restarts it. */
  private blockedSince = -1;
  /** Waiting for the user to confirm an empty board: no events. */
  checking = false;
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
    this.emptyHoldMs = opts.emptyHoldMs ?? 700;
    this.checkMs = opts.checkMs ?? 5000;
  }

  /**
   * Take the empty-board reference from the first moment the picture holds still (3 frames), rather
   * than the instant the user tapped "start" (a hand may still be in view). No events until then.
   */
  resetWhenStill(): void {
    this.stable = null;
    this.awaitStill = 0;
    this.checking = false;
  }

  /** Use this frame as the empty board. Only call it when the user has confirmed the board is empty. */
  reset(frame: Img): void {
    this.stable = frame;
    this.stableSmall = shrink(frame);
    this.empty = this.stableSmall;
    this.emptyFull = frame;
    this.last = this.stableSmall;
    this.clearMotion();
    this.checking = false;
  }

  /** Take this frame as the current state of the board (darts may be in it); keeps the empty reference. */
  resync(frame: Img): void {
    if (!this.emptyFull) return this.reset(frame);
    this.stable = frame;
    this.stableSmall = shrink(frame);
    this.last = this.stableSmall;
    this.clearMotion();
  }

  private clearMotion(): void {
    this.pending = false;
    this.stillSince = -1;
    this.rest = [];
    this.emptySince = -1;
    this.blocked = false;
    this.blockedSince = -1;
    this.busy = false;
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
    if (this.checking) return [];
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
      this.rest = [];
      // A hand back in the board before the hold is over: the pull is judged again once it is still.
      this.emptySince = -1;
      this.blockedSince = -1;
      this.pending = true;
      const ch = this.changed(this.stableSmall!, s);
      if (ch > BIG_CHANGE && !this.busy) {
        this.busy = true;
        events.push({ type: 'busy', changed: ch });
      }
      return events;
    }
    // The resting frames must all show one unchanged scene: a far, thin dart can land without
    // tripping the motion gate, and the frames before it would read no tip at all.
    const crept = this.stillSince >= 0 && this.changed(this.restStart!, s) > this.minChange / 4;
    if (this.stillSince < 0 || crept) {
      this.stillSince = tMs;
      this.rest = [];
      this.restStart = s;
    }
    if (crept) {
      this.pending = true;
      this.emptySince = -1;
    }
    this.rest.push(frame);
    if (this.rest.length > REST_FRAMES) this.rest.shift();
    if (this.emptySince >= 0) {
      // The board looked empty at the settle. Only once it has stayed empty and still for
      // emptyHoldMs is it "empty": a hand still reaching in, or a dart only covered for a moment,
      // moves first. This frame becomes the new reference (follows slow lighting drift).
      if (tMs - this.emptySince < this.emptyHoldMs) return events;
      this.reset(frame);
      events.push({ type: 'empty' });
      return events;
    }
    const vsStable = this.changed(this.stableSmall!, s);
    if (!this.pending && vsStable <= this.minChange) return events;
    if (tMs - this.stillSince < this.settleMs) return events;

    // Settled after a change.
    this.busy = false;
    if (vsStable > BIG_CHANGE) {
      // Not a dart (and not the empty board: a board with darts never differs this much from it).
      // Keep the last good frame: when the view clears, what changed meanwhile is judged against
      // it, as if nothing had been in the way.
      if (!this.blocked) events.push({ type: 'blocked', changed: vsStable });
      this.blocked = true;
      if (this.blockedSince < 0) this.blockedSince = this.stillSince;
      // A hand or a body is never this still for long; a light or exposure jump, or a knocked
      // camera, is. The empty-board reference is useless then: only the user can say the board is empty.
      if (tMs - this.blockedSince >= this.checkMs) {
        this.checking = true;
        events.push({ type: 'check', changed: vsStable });
      }
      return events;
    }
    if (this.blocked) {
      this.blocked = false;
      this.blockedSince = -1;
      events.push({ type: 'unblocked' });
    }
    const eNow = this.changed(this.empty!, s);
    const eBefore = this.changed(this.empty!, this.stableSmall!);
    // "Empty" is relative: the board must have gone back to the empty reference. An absolute
    // threshold alone would swallow a small, far-away first dart. The thresholds alone also pass
    // when the darts are pulled in two goes and one small far dart is still in: so the detector
    // must find nothing against the empty board either. The settled frame is not taken yet, so a
    // hand coming back during the hold is judged against the board with the darts in.
    if (eNow <= this.emptyMax && eNow < 0.35 * eBefore && !detectDart(this.emptyFull!, frame, { mask: this.mask, H: this.H })) {
      this.emptySince = this.stillSince;
      return events;
    }
    this.pending = false;
    const before = this.stable;
    this.stable = frame;
    this.stableSmall = s;
    const det = detectDart(before, frame, { mask: this.mask, H: this.H });
    if (det) {
      // Differencing is symmetric: a dart pulled out (or falling out) looks like a new one.
      // Along the detected dart, a removal makes the picture look *more* like the empty board.
      // A removal also shrinks the area that differs from the empty board; an addition never does.
      if (eNow < eBefore && this.removal(before, frame, det)) events.push({ type: 'removed', board: apply(this.Hi, det.tip) });
      else {
        const tips = [det.tip];
        for (const f of this.rest.slice(0, -1)) {
          const d = detectDart(before, f, { mask: this.mask, H: this.H });
          if (d) tips.push(d.tip);
        }
        const tip = restingTip(tips) ?? det.tip;
        events.push({ type: 'dart', det: { ...det, tip }, board: apply(this.Hi, tip) });
      }
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
