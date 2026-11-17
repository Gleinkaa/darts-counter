import { describe, expect, it } from 'vitest';
import { makeScore, polar, sectorCenterDeg, type Pt } from '../src/board.ts';
import { Game, type GameConfig } from '../src/game.ts';
import { BoardCycle } from '../src/handover.ts';
import { cloneImg, type Img } from '../src/img.ts';
import { ThrowTracker, type TrackerEvent } from '../src/tracker.ts';
import { type Dart, makeScene, randomDart, renderFrame, rng } from '../synth/render.ts';

const T20 = polar(103, 0);
const S5 = polar(140, sectorCenterDeg(5));
const S1 = polar(140, sectorCenterDeg(1));
const BULL = { x: 1, y: -1 };

const cam = (board: Pt): TrackerEvent => ({
  type: 'dart',
  board,
  det: { tip: board, axis: { x: 0, y: 1 }, tail: board, area: 100, length: 50, confidence: 1 },
});
const PULLED: TrackerEvent = { type: 'empty' };

function setup(cfg: Partial<GameConfig> = {}) {
  const game = new Game({ kind: 'x01', start: 501, doubleOut: true, players: ['A', 'B'], ...cfg });
  const cycle = new BoardCycle();
  const feed = (...evs: TrackerEvent[]) => evs.map((e) => cycle.apply(game, e).type);
  return { game, cycle, feed };
}

describe('pull-out hand-over', () => {
  it('pulling the darts hands the board to the next player; Undo takes it back', () => {
    const { game, cycle, feed } = setup();
    expect(feed(cam(T20), cam(S5), cam(BULL), PULLED)).toEqual(['dart', 'dart', 'dart', 'handover']);
    let st = game.state;
    expect(st.current).toBe(1);
    expect(st.players[0].score).toBe(501 - 115);
    expect(st.history[0].total).toBe(115);
    expect(cycle.canNext(game)).toBe(false); // a Next tap right now would skip B
    game.undo();
    st = game.state;
    expect(st.current).toBe(0);
    expect(st.visit.darts.map((d) => d.label)).toEqual(['T20', '5', 'Bull']);
    expect(cycle.canNext(game)).toBe(true);
  });

  it('a pull after fewer than three darts ends the visit early', () => {
    const { game, feed } = setup();
    expect(feed(cam(T20), PULLED)).toEqual(['dart', 'handover']);
    expect(game.state.current).toBe(1);
    expect(game.state.players[0].dartsThrown).toBe(3);
  });

  it('rotates through four players and back, one player plays visit after visit', () => {
    const { game, feed } = setup({ players: ['A', 'B', 'C', 'D'] });
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      order.push(game.state.current);
      feed(cam(S1), PULLED);
    }
    expect(order).toEqual([0, 1, 2, 3, 0]);
    const solo = setup({ players: ['A'] });
    solo.feed(cam(S1), PULLED, cam(S1), PULLED);
    expect(solo.game.state.history.length).toBe(2);
    expect(solo.game.state.players[0].score).toBe(499);
  });

  it('301 double-out: a bust closes the visit, the pull hands over and the score is restored', () => {
    const { game, feed } = setup({ start: 301 });
    feed(cam(T20), cam(T20), cam(T20), PULLED); // A 121
    feed(cam(S1), PULLED); // B
    expect(feed(cam(T20), cam(T20))).toEqual(['dart', 'dart']); // 121 -> 61 -> 1: bust under double-out
    let st = game.state;
    expect(st.visit.bust).toBe(true);
    expect(st.visitClosed).toBe(true);
    expect(feed(cam(S5))).toEqual(['dart']); // a dart into a bust visit is not counted …
    expect(game.state.visit.darts.length).toBe(2);
    expect(feed(PULLED)).toEqual(['handover']); // … and does not stop the pull handing over
    st = game.state;
    expect(st.current).toBe(1);
    expect(st.players[0].score).toBe(121);
    expect(st.history.at(-1)!.bust).toBe(true);
  });

  it('double-out: reaching 0 on a single busts, and Undo of that hand-over reopens nothing', () => {
    const { game, feed } = setup({ start: 40, players: ['A'] });
    feed(cam(polar(140, sectorCenterDeg(20))), cam(polar(140, sectorCenterDeg(20))), PULLED);
    expect(game.state.players[0].score).toBe(40);
    expect(game.state.history[0].bust).toBe(true);
    game.undo(); // back into the bust visit: still closed, still 40
    expect(game.state.visitClosed).toBe(true);
    expect(game.state.players[0].score).toBe(40);
  });

  it('cricket: marks and points count, the pull hands over', () => {
    const { game, feed } = setup({ kind: 'cricket', start: 0, doubleOut: false });
    expect(feed(cam(T20), cam(T20), cam(BULL), PULLED)).toEqual(['dart', 'dart', 'dart', 'handover']);
    const st = game.state;
    expect(st.current).toBe(1);
    expect(st.players[0].marks[20]).toBe(3);
    expect(st.players[0].marks[25]).toBe(2);
    expect(st.players[0].score).toBe(60); // the second T20 scores while B has 20 open
  });

  it('a pull only ends the visit its darts were scored in (Next with the darts still in)', () => {
    const { game, cycle, feed } = setup();
    feed(cam(T20)); // A's dart, still in the board
    game.next(true); // A taps Next
    game.addDart(makeScore('miss')); // B types a miss
    expect(feed(PULLED)).toEqual(['empty']); // A's dart comes out: B's visit goes on
    const st = game.state;
    expect(st.current).toBe(1);
    expect(st.visit.darts.length).toBe(1);
    expect(cycle.empty).toBe(true);
  });

  it("once the next player's darts are scored, pulling everything ends their visit", () => {
    const { game, feed } = setup();
    feed(cam(T20));
    game.next(true);
    expect(feed(cam(S5), cam(S1), PULLED)).toEqual(['dart', 'dart', 'handover']);
    expect(game.state.current).toBe(0);
    expect(game.state.history.map((v) => v.total)).toEqual([60, 6]);
  });

  it('Undo of a manual Next gives the board back to its visit', () => {
    const { game, feed } = setup();
    feed(cam(T20));
    game.next(true);
    game.undo();
    expect(feed(PULLED)).toEqual(['handover']);
    expect(game.state.current).toBe(1);
  });

  it('a dart seen but not found claims the board for the player throwing', () => {
    const { game, feed } = setup();
    feed({ type: 'nodart', changed: 0.01 });
    game.addDart(makeScore('single', 7)); // typed in with ＋ Dart
    expect(feed(PULLED)).toEqual(['handover']);
    expect(game.state.current).toBe(1);
  });

  it('board check: a complete visit is handed over on "Board is empty", an open one goes on', () => {
    const a = setup();
    a.feed(cam(T20), cam(T20), cam(T20), { type: 'check', changed: 0.5 });
    expect(a.cycle.checking).toBe(true);
    expect(a.cycle.confirmEmpty(a.game)).toBe(true);
    expect(a.cycle.checking).toBe(false);
    expect(a.game.state.current).toBe(1);
    const b = setup();
    b.feed(cam(T20), { type: 'check', changed: 0.5 });
    expect(b.cycle.confirmEmpty(b.game)).toBe(false);
    expect(b.game.state.current).toBe(0);
    expect(b.feed(cam(S5))).toEqual(['dart']);
    expect(b.game.state.visit.darts.length).toBe(2);
  });

  it('throw-then-undo back to the auto-advance point re-enables a manual Next', () => {
    const { game, cycle, feed } = setup();
    feed(cam(T20), cam(S5), cam(BULL), PULLED); // auto hand-over: the guard is armed
    expect(cycle.canNext(game)).toBe(false);
    feed(cam(S1)); // B throws …
    game.undo(); // … then undoes it, back to the same event length as the hand-over
    expect(game.state.visit.darts.length).toBe(0);
    expect(cycle.canNext(game)).toBe(true); // a manual "Darts pulled" is allowed again
  });

  it('a new game clears a stale board check and empty flag', () => {
    const { cycle, feed } = setup();
    feed(cam(T20), { type: 'check', changed: 0.5 });
    expect(cycle.checking).toBe(true);
    expect(cycle.empty).toBe(false);
    cycle.newGame();
    expect(cycle.checking).toBe(false);
    expect(cycle.empty).toBe(true);
  });

  it('the pull after a checkout does not start a new leg', () => {
    const { game, feed } = setup({ start: 40 });
    feed(cam(polar(166, 0))); // D20
    expect(game.state.winner).toBe(0);
    expect(feed(PULLED)).toEqual(['empty']);
    expect(game.state.winner).toBe(0);
  });
});

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

describe('hand-over through the camera tracker', () => {
  const sc = makeScene(4242, { tilt: [38, 42] });
  const R = rng(77);
  const darts: Dart[] = [T20, S5, BULL].map((t) => randomDart(R, t));

  /** Throw `darts` one by one, reach in, pull them all, and hold the empty board for 1 s. */
  function visit(tr: ThrowTracker, game: Game, cycle: BoardCycle, thrown: Dart[], seed: number, t0: number) {
    const out: string[] = [];
    let t = t0;
    const feed = (im: Img) => tr.feed(im, (t += 100)).forEach((e) => e.type !== 'busy' && out.push(cycle.apply(game, e).type));
    for (let k = 1; k <= thrown.length; k++) for (let i = 0; i < 6; i++) feed(renderFrame(sc, thrown.slice(0, k), seed++));
    for (let i = 0; i < 3; i++) feed(withHand(renderFrame(sc, thrown, seed++)));
    for (let i = 0; i < 10; i++) feed(renderFrame(sc, [], seed++));
    return { out, t };
  }

  it('501: three darts, the pull hands over to the next player', () => {
    const game = new Game({ kind: 'x01', start: 501, doubleOut: true, players: ['A', 'B'] });
    const cycle = new BoardCycle();
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    tr.reset(renderFrame(sc, [], 1));
    const { out } = visit(tr, game, cycle, darts, 10, 0);
    expect(out).toEqual(['dart', 'dart', 'dart', 'handover']);
    expect(game.state.current).toBe(1);
    expect(game.state.players[0].score).toBe(386);
  });

  it('cricket, then a bust in 301: each pull hands over exactly once', () => {
    const cr = new Game({ kind: 'cricket', start: 0, doubleOut: false, players: ['A', 'B'] });
    const cycle = new BoardCycle();
    const tr = new ThrowTracker(sc.H, sc.cam.w, sc.cam.h);
    tr.reset(renderFrame(sc, [], 2));
    const a = visit(tr, cr, cycle, darts, 200, 0);
    expect(a.out).toEqual(['dart', 'dart', 'dart', 'handover']);
    expect(cr.state.players[0].marks[20]).toBe(3);
    expect(cr.state.players[0].marks[25]).toBe(2);
    expect(cr.state.current).toBe(1);

    // 301, A on 61: T20 leaves 1, a bust under double-out. The second dart is not counted.
    const x = new Game({ kind: 'x01', start: 301, doubleOut: true, players: ['A', 'B'] });
    for (const s of [makeScore('treble', 20), makeScore('treble', 20), makeScore('treble', 20)]) x.addDart(s);
    x.next();
    x.next(true);
    x.addDart(makeScore('treble', 20)); // A: 121 -> 61, typed in
    const cyc2 = new BoardCycle();
    const b = visit(tr, x, cyc2, darts.slice(0, 2), 400, a.t);
    expect(b.out).toEqual(['dart', 'dart', 'handover']);
    expect(x.state.history.at(-1)!.bust).toBe(true);
    expect(x.state.players[0].score).toBe(121);
    expect(x.state.current).toBe(1);
  });
});
