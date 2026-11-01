import { describe, expect, it } from 'vitest';
import { polar, scoreAt, scoreLabel, sectorCenterDeg } from '../src/board.ts';
import { cloneImg, type Img } from '../src/img.ts';
import { ThrowTracker, type TrackerEvent } from '../src/tracker.ts';
import { type Dart, makeScene, randomDart, renderFrame, rng } from '../synth/render.ts';

/** A big skin-coloured blob (an arm reaching for the darts). */
function withHand(im: Img): Img {
  const out = cloneImg(im);
  for (let y = 120; y < 420; y++)
    for (let x = 250; x < 420; x++) {
      const i = (y * im.width + x) * 4;
      out.data[i] = 205; out.data[i + 1] = 160; out.data[i + 2] = 130;
    }
  return out;
}

describe('ThrowTracker', () => {
  const sc = makeScene(4242, { tilt: [38, 42] });
  const R = rng(77);
  const tips = [polar(103, 0), polar(140, sectorCenterDeg(5)), { x: 1, y: -1 }];
  const darts: Dart[] = tips.map((t) => randomDart(R, t));

  it('emits three darts with the right scores, then "empty" after the pull', () => {
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    const frames: Img[] = [];
    let seed = 1;
    const hold = (inBoard: Dart[], n: number) => {
      for (let i = 0; i < n; i++) frames.push(renderFrame(sc, inBoard, seed++, 1 + (i % 3) * 0.004));
    };
    hold([], 5);
    hold(darts.slice(0, 1), 6);
    hold(darts.slice(0, 2), 6);
    hold(darts.slice(0, 3), 6);
    const withAll = frames[frames.length - 1];
    for (let i = 0; i < 3; i++) frames.push(withHand(withAll));
    hold([], 6);

    const events: TrackerEvent[] = [];
    frames.forEach((f, i) => events.push(...tr.feed(f, i * 100)));
    const kinds = events.filter((e) => e.type !== 'busy').map((e) => e.type);
    expect(kinds).toEqual(['dart', 'dart', 'dart', 'empty']);
    const labels = events.flatMap((e) => (e.type === 'dart' ? [scoreLabel(scoreAt(e.board.x, e.board.y))] : []));
    expect(labels).toEqual(['T20', '5', 'Bull']);
    expect(events.some((e) => e.type === 'busy')).toBe(true);
  });

  it('ignores sensor noise and small exposure drift on a still board', () => {
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    const events: TrackerEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(...tr.feed(renderFrame(sc, [], 100 + i, 1 + i * 0.002), i * 100));
    expect(events).toEqual([]);
  });

  it('does not fire before the picture has settled', () => {
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h, { settleMs: 350 });
    tr.feed(renderFrame(sc, [], 1), 0);
    const a = renderFrame(sc, darts.slice(0, 1), 2);
    expect(tr.feed(a, 100)).toEqual([]);
    expect(tr.feed(renderFrame(sc, darts.slice(0, 1), 3), 200)).toEqual([]);
    expect(tr.feed(renderFrame(sc, darts.slice(0, 1), 4), 400)).toEqual([]);
    const ev = tr.feed(renderFrame(sc, darts.slice(0, 1), 5), 600);
    expect(ev.map((e) => e.type)).toEqual(['dart']);
  });

  const run = (tr: ThrowTracker, states: Dart[][], perState = 6, seed0 = 500) => {
    const events: TrackerEvent[] = [];
    let t = 0, seed = seed0;
    for (const st of states)
      for (let i = 0; i < perState; i++) events.push(...tr.feed(renderFrame(sc, st, seed++), (t += 100)));
    return events.filter((e) => e.type !== 'busy');
  };

  it('a dart pulled out mid-visit is reported as removed, never scored', () => {
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    const ev = run(tr, [[], [darts[0]], [darts[0], darts[1]], [darts[0]]]);
    expect(ev.map((e) => e.type)).toEqual(['dart', 'dart', 'removed']);
  });

  it('pulling darts one at a time ends with "empty", no phantom darts', () => {
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    const ev = run(tr, [[], [darts[0]], darts.slice(0, 2), darts, darts.slice(1), [darts[2]], []]);
    expect(ev.map((e) => e.type)).toEqual(['dart', 'dart', 'dart', 'removed', 'removed', 'empty']);
  });

  it('"Darts pulled" pressed too early (resync with darts in) keeps the empty reference', () => {
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    run(tr, [[], darts], 6, 900);
    tr.resync(renderFrame(sc, darts, 950));
    const ev = run(tr, [darts, [], [darts[0]]], 6, 960);
    expect(ev.map((e) => e.type)).toEqual(['empty', 'dart']);
  });

  it('small first darts all round the double ring are scored, not taken for an empty board', () => {
    const R2 = rng(5);
    for (const s of [3, 17, 2, 15, 10, 6, 13, 4, 18, 1, 20, 5, 12, 9, 14, 11, 8, 16, 7, 19]) {
      const d = randomDart(R2, polar(166, sectorCenterDeg(s)));
      const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
      const ev = run(tr, [[], [d]], 6, 1200 + s);
      expect(ev.map((e) => e.type), `D${s}`).toEqual(['dart']);
    }
  });

  it('resetWhenStill waits for a still picture before taking the empty reference', () => {
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    tr.resetWhenStill();
    // A hand in view while "start" is tapped, then it leaves.
    let t = 0;
    for (let i = 0; i < 3; i++) expect(tr.feed(withHand(renderFrame(sc, [], 3001 + i)), (t += 100))).toEqual([]);
    for (let i = 0; i < 5; i++) tr.feed(renderFrame(sc, [], 3010 + i), (t += 100));
    const ev: TrackerEvent[] = [];
    let seed = 3100;
    for (const st of [[darts[0]], []])
      for (let i = 0; i < 6; i++) ev.push(...tr.feed(renderFrame(sc, st, seed++), (t += 100)));
    expect(ev.filter((e) => e.type !== 'busy').map((e) => e.type)).toEqual(['dart', 'empty']);
  });

  it('a dart landing almost on top of another is an addition, not a removal', () => {
    const R3 = rng(9);
    const first = randomDart(R3, polar(103, 0));
    const second = randomDart(R3, polar(104, 1)); // ~2 mm away
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    const ev = run(tr, [[], [first], [first, second]], 6, 4000);
    expect(ev.map((e) => e.type)).toEqual(['dart', 'dart']);
  });

  it('darts pulled in two goes, a small far dart last, never score a phantom dart', () => {
    // Final review #1: with one small double-ring dart left, the change was under emptyMax, so
    // "empty" fired and that frame (dart still in) became the empty reference; pulling the last
    // dart then scored it for the next player. These were the 7 failing positions of 20.
    const R4 = rng(77);
    const big = [randomDart(R4, polar(103, 0)), randomDart(R4, { x: 1, y: -1 })];
    const R5 = rng(5);
    const order = [3, 17, 2, 15, 10, 6, 13, 4, 18, 1, 20, 5, 12, 9, 14, 11, 8, 16, 7, 19];
    const smalls = new Map(order.map((s) => [s, randomDart(R5, polar(166, sectorCenterDeg(s)))]));
    for (const s of [4, 18, 1, 20, 5, 12, 9]) {
      const small = smalls.get(s)!;
      const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
      let t = 0, seed = 1000 + s * 50;
      const phase = (states: Dart[][]) => {
        const ev: TrackerEvent[] = [];
        for (const st of states) for (let i = 0; i < 6; i++) ev.push(...tr.feed(renderFrame(sc, st, seed++), (t += 100)));
        return ev.filter((e) => e.type !== 'busy').map((e) => e.type);
      };
      phase([[], [big[0]], [big[0], big[1]], [big[0], big[1], small]]);
      const pulls = phase([[small], [], []]);
      expect(pulls, `D${s}`).not.toContain('dart');
      expect(pulls.at(-1), `D${s}`).toBe('empty');
    }
  });
});
