import { describe, expect, it } from 'vitest';
import { makeScore, type Score } from '../src/board.ts';
import { Game, checkoutHint } from '../src/game.ts';

const S = (n: number) => makeScore('single', n);
const D = (n: number) => makeScore('double', n);
const T = (n: number) => makeScore('treble', n);
const MISS = makeScore('miss');
const BULL = makeScore('bull');

function x01(start = 501, players = ['A', 'B'], doubleOut = true) {
  return new Game({ kind: 'x01', start, doubleOut, players });
}
function throwAll(g: Game, darts: Score[]) {
  for (const d of darts) g.addDart(d);
}

describe('x01', () => {
  it('subtracts a visit and rotates players after the darts are pulled', () => {
    const g = x01();
    throwAll(g, [T(20), T(20), T(20)]);
    expect(g.state.players[0].score).toBe(321);
    expect(g.state.visitClosed).toBe(true);
    expect(g.state.current).toBe(0); // waits for the pull
    expect(g.addDart(S(1))).toBe(false); // 4th dart ignored
    g.next();
    expect(g.state.current).toBe(1);
    expect(g.state.history[0].total).toBe(180);
  });

  it('bust restores the start-of-visit score and closes the visit', () => {
    const g = x01(301, ['A']);
    throwAll(g, [T(20), T(20), T(20)]);
    g.next();
    throwAll(g, [T(20), T(20)]); // 121 -> 61 -> 1: leaving 1 busts under double-out
    const s = g.state;
    expect(s.players[0].score).toBe(121);
    expect(s.visit.bust).toBe(true);
    expect(s.visitClosed).toBe(true);
    expect(g.addDart(S(1))).toBe(false);
  });

  it('bust on leaving 1 and on reaching 0 without a double (double-out)', () => {
    const g = x01(40, ['A']);
    throwAll(g, [S(19), S(20)]); // 40-19=21, 21-20=1 -> bust
    expect(g.state.players[0].score).toBe(40);
    expect(g.state.visit.bust).toBe(true);
    g.next();
    throwAll(g, [S(20), S(20)]); // reaches 0 on a single -> bust
    expect(g.state.players[0].score).toBe(40);
    expect(g.state.winner).toBeNull();
  });

  it('checkout on a double wins; bull counts as a double', () => {
    const g = x01(40, ['A', 'B']);
    g.addDart(D(20));
    expect(g.state.winner).toBe(0);
    expect(g.state.history.at(-1)?.checkout).toBe(true);
    const h = x01(50, ['A']);
    h.addDart(BULL);
    expect(h.state.winner).toBe(0);
  });

  it('without double-out, a single can finish and only < 0 busts', () => {
    const g = x01(20, ['A'], false);
    g.addDart(S(20));
    expect(g.state.winner).toBe(0);
    const h = x01(21, ['A'], false);
    throwAll(h, [S(20)]);
    expect(h.state.players[0].score).toBe(1);
    expect(h.state.visit.bust).toBe(false);
  });

  it('undo removes darts and visit ends, even across a bust and a checkout', () => {
    const g = x01(40, ['A', 'B']);
    throwAll(g, [S(19), S(20)]); // bust
    g.undo();
    expect(g.state.visit.bust).toBe(false);
    expect(g.state.players[0].score).toBe(21);
    g.addDart(S(1));
    g.addDart(D(10)); // checkout 20? 21-1 = 20 -> D10 wins
    expect(g.state.winner).toBe(0);
    g.undo();
    expect(g.state.winner).toBeNull();
    expect(g.state.players[0].score).toBe(20);
    g.addDart(MISS);
    g.next();
    expect(g.state.current).toBe(1);
    g.undo(); // undo the pull
    expect(g.state.current).toBe(0);
    expect(g.state.visit.darts.length).toBe(3);
  });

  it('a correction rewrites history and is logged', () => {
    const g = x01(501, ['A']);
    throwAll(g, [S(20), S(5), S(1)]);
    const ev = g.state.visit.darts[1].event;
    g.correct(ev, T(20));
    expect(g.state.players[0].score).toBe(501 - 20 - 60 - 1);
    expect(g.corrections).toHaveLength(1);
    expect(g.corrections[0]).toMatchObject({ from: '5', to: 'T20' });
  });

  it('averages count 3 darts per visit, fewer on the checkout visit', () => {
    const g = x01(101, ['A']);
    throwAll(g, [S(20), S(20), S(20)]); // 41 left
    g.next();
    throwAll(g, [S(1), D(20)]); // checkout with 2 darts
    const p = g.state.players[0];
    expect(p.dartsThrown).toBe(5);
    expect(p.average).toBeCloseTo((101 / 5) * 3, 6);
  });

  it('the average includes the visit in progress', () => {
    const g = x01(501, ['A']);
    throwAll(g, [T(20), S(5), BULL]);
    expect(g.state.players[0].average).toBeCloseTo(115, 6);
    g.next();
    throwAll(g, [S(1)]);
    expect(g.state.players[0].average).toBeCloseTo((116 / 4) * 3, 6);
  });

  it('busted visits score 0 but count their darts', () => {
    const g = x01(50, ['A']);
    throwAll(g, [T(20)]);
    g.next();
    expect(g.state.players[0].dartsThrown).toBe(3);
    expect(g.state.players[0].average).toBe(0);
  });

  it('next() on an empty visit is a no-op unless forced', () => {
    const g = x01();
    expect(g.next()).toBe(false);
    expect(g.next(true)).toBe(true);
    expect(g.state.current).toBe(1);
  });
});

describe('cricket', () => {
  const cr = () => new Game({ kind: 'cricket', start: 0, doubleOut: false, players: ['A', 'B'] });

  it('marks close a number, extras score while an opponent is open', () => {
    const g = cr();
    throwAll(g, [T(20), D(20)]);
    const a = g.state.players[0];
    expect(a.marks[20]).toBe(3);
    expect(a.score).toBe(40);
  });

  it('no points once everyone has closed the number', () => {
    const g = cr();
    g.addDart(T(20));
    g.next(true);
    g.addDart(T(20));
    g.next(true);
    g.addDart(T(20));
    expect(g.state.players[0].score).toBe(0);
  });

  it('non-targets score nothing; bulls count 1 and 2 marks', () => {
    const g = cr();
    throwAll(g, [T(5), makeScore('outer-bull'), BULL]);
    const a = g.state.players[0];
    expect(a.marks[25]).toBe(3);
    expect(a.totalMarks).toBe(3);
  });

  it('wins when all closed with at least the highest score', () => {
    const g = cr();
    for (const n of [20, 19, 18, 17, 16, 15]) {
      g.addDart(T(n));
      if (g.state.visitClosed) g.next();
      while (g.state.current !== 0) g.next(true);
    }
    expect(g.state.winner).toBeNull();
    g.addDart(BULL);
    g.addDart(makeScore('outer-bull'));
    expect(g.state.winner).toBe(0);
  });
});

describe('checkoutHint', () => {
  it('suggests standard finishes', () => {
    expect(checkoutHint(170, 3)).toBe('T20 T20 Bull');
    expect(checkoutHint(40, 1)).toBe('D20');
    expect(checkoutHint(50, 1)).toBe('Bull');
    expect(checkoutHint(100, 2)).toBe('T20 D20');
    expect(checkoutHint(169, 3)).toBeNull();
    expect(checkoutHint(1, 3)).toBeNull();
  });
});
