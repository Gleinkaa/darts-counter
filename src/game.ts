// Game rules as a replayable event log. Undo pops an event; a correction rewrites one.
// The UI never mutates derived state directly, so undo/correct can never desync scores.

import { type Pt, type Score, scoreLabel } from './board.ts';

export type GameKind = 'x01' | 'cricket';

export interface GameConfig {
  kind: GameKind;
  /** X01 starting score (501, 301). Ignored for cricket. */
  start: number;
  doubleOut: boolean;
  players: string[];
}

export type GameEvent =
  | { type: 'dart'; score: Score; auto: boolean; point?: Pt }
  /** The visit is over: darts pulled, or the Next button. Unthrown darts count as misses. */
  | { type: 'next' };

export interface DartView {
  event: number;
  score: Score;
  label: string;
  auto: boolean;
}

export interface Visit {
  player: number;
  darts: DartView[];
  /** Points that counted (0 on a bust). For cricket: points scored this visit. */
  total: number;
  bust: boolean;
  checkout: boolean;
  /** Darts that count towards the average (3 unless the leg was won mid-visit). */
  dartsUsed: number;
}

export interface PlayerState {
  name: string;
  /** X01: points left. Cricket: points scored. */
  score: number;
  /** Cricket marks per target (15..20, 25). */
  marks: Record<number, number>;
  pointsScored: number;
  dartsThrown: number;
  /** Three-dart average (X01) or marks per round (cricket). */
  average: number;
  totalMarks: number;
}

export interface GameState {
  config: GameConfig;
  players: PlayerState[];
  current: number;
  /** The visit in progress (possibly full/closed and waiting for the darts to be pulled). */
  visit: Visit;
  /** True once the current visit takes no more darts (3 thrown, bust or checkout). */
  visitClosed: boolean;
  history: Visit[];
  winner: number | null;
}

export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25] as const;

function emptyVisit(player: number): Visit {
  return { player, darts: [], total: 0, bust: false, checkout: false, dartsUsed: 0 };
}

export function replay(config: GameConfig, events: GameEvent[]): GameState {
  if (config.players.length < 1 || config.players.length > 4) throw new Error('1-4 players');
  const players: PlayerState[] = config.players.map((name) => ({
    name,
    score: config.kind === 'x01' ? config.start : 0,
    marks: Object.fromEntries(CRICKET_TARGETS.map((t) => [t, 0])),
    pointsScored: 0,
    dartsThrown: 0,
    average: 0,
    totalMarks: 0,
  }));
  const st: GameState = {
    config,
    players,
    current: 0,
    visit: emptyVisit(0),
    visitClosed: false,
    history: [],
    winner: null,
  };
  // X01 remaining at the start of the current visit, to roll back on a bust.
  let visitStartScore = players[0].score;

  const finishVisit = () => {
    const v = st.visit;
    v.dartsUsed = v.checkout ? v.darts.length : 3;
    players[v.player].dartsThrown += v.dartsUsed;
    st.history.push(v);
    if (st.winner === null) {
      st.current = (st.current + 1) % players.length;
      st.visit = emptyVisit(st.current);
      st.visitClosed = false;
      visitStartScore = players[st.current].score;
    }
  };

  events.forEach((ev, i) => {
    if (ev.type === 'next') {
      if (st.winner !== null) return;
      finishVisit();
      return;
    }
    if (st.winner !== null || st.visitClosed) return; // extra darts are ignored until pulled
    const p = players[st.current];
    const v = st.visit;
    v.darts.push({ event: i, score: ev.score, label: scoreLabel(ev.score), auto: ev.auto });

    if (config.kind === 'x01') {
      const left = p.score - ev.score.points;
      const bust = left < 0 || (config.doubleOut && left === 1) || (left === 0 && config.doubleOut && ev.score.multiplier !== 2);
      if (bust) {
        v.bust = true;
        v.total = 0;
        p.score = visitStartScore;
        st.visitClosed = true;
      } else {
        p.score = left;
        v.total += ev.score.points;
        if (left === 0) {
          v.checkout = true;
          st.visitClosed = true;
          st.winner = st.current;
        }
      }
    } else {
      const t = ev.score.sector;
      if ((CRICKET_TARGETS as readonly number[]).includes(t) && ev.score.multiplier > 0) {
        const before = p.marks[t];
        const after = before + ev.score.multiplier;
        p.marks[t] = Math.min(3, after);
        p.totalMarks += ev.score.multiplier;
        const extra = after - Math.max(3, before);
        const othersOpen = players.some((o, j) => j !== st.current && o.marks[t] < 3);
        if (extra > 0 && othersOpen) {
          const pts = extra * t;
          p.score += pts;
          v.total += pts;
        }
      }
      const allClosed = CRICKET_TARGETS.every((tt) => p.marks[tt] >= 3);
      if (allClosed && players.every((o) => o.score <= p.score)) {
        v.checkout = true;
        st.visitClosed = true;
        st.winner = st.current;
      }
    }
    if (v.darts.length >= 3) st.visitClosed = true;
    if (st.winner !== null) finishVisit();
  });

  players.forEach((p, i) => {
    // The visit in progress counts too: its points are already in the score, so its darts must be.
    const darts = p.dartsThrown + (st.winner === null && st.current === i ? st.visit.darts.length : 0);
    p.dartsThrown = darts; // the same denominator everywhere it is shown
    if (config.kind === 'x01') {
      p.pointsScored = config.start - p.score;
      p.average = darts ? (p.pointsScored / darts) * 3 : 0;
    } else {
      p.pointsScored = p.score;
      p.average = darts ? (p.totalMarks / darts) * 3 : 0;
    }
  });
  return st;
}

/** Thin mutable wrapper the UI holds. All state is derived from `events`. */
export class Game {
  readonly config: GameConfig;
  events: GameEvent[] = [];
  corrections: { at: string; event: number; from: string; to: string }[] = [];

  constructor(config: GameConfig) {
    this.config = config;
  }

  get state(): GameState {
    return replay(this.config, this.events);
  }

  /** Returns false when the dart was not counted (visit closed or game over). */
  addDart(score: Score, auto = false, point?: Pt): boolean {
    const before = this.state;
    if (before.winner !== null || before.visitClosed) return false;
    this.events.push({ type: 'dart', score, auto, point });
    return true;
  }

  /** End the visit (darts pulled / Next). No-op on an empty, open visit unless forced. */
  next(force = false): boolean {
    const s = this.state;
    if (s.winner !== null) return false;
    if (!force && s.visit.darts.length === 0 && !s.visitClosed) return false;
    this.events.push({ type: 'next' });
    return true;
  }

  undo(): GameEvent | undefined {
    return this.events.pop();
  }

  correct(event: number, score: Score, point?: Pt): void {
    const ev = this.events[event];
    if (!ev || ev.type !== 'dart') throw new Error(`event ${event} is not a dart`);
    this.corrections.push({ at: new Date().toISOString(), event, from: scoreLabel(ev.score), to: scoreLabel(score) });
    this.events[event] = { type: 'dart', score, auto: false, point: point ?? ev.point };
  }
}

/** Standard checkout suggestion for X01 double-out (<= 170), or null. */
export function checkoutHint(left: number, dartsLeft: number): string | null {
  if (left > 170 || left < 2 || dartsLeft < 1) return null;
  const singles = Array.from({ length: 20 }, (_, i) => ({ l: String(i + 1), v: i + 1 }));
  const throws = [
    ...singles.map((s) => ({ l: `T${s.l}`, v: s.v * 3 })),
    ...singles,
    ...singles.map((s) => ({ l: `D${s.l}`, v: s.v * 2 })),
    { l: '25', v: 25 },
    { l: 'Bull', v: 50 },
  ];
  const doubles = [...singles.map((s) => ({ l: `D${s.l}`, v: s.v * 2 })), { l: 'Bull', v: 50 }];
  // Prefer fewest darts; among those the throw order above (trebles first) is the conventional one.
  for (const d of doubles) if (d.v === left) return d.l;
  if (dartsLeft >= 2) for (const a of throws) for (const d of doubles) if (a.v + d.v === left) return `${a.l} ${d.l}`;
  if (dartsLeft >= 3)
    for (const a of throws) for (const b of throws) for (const d of doubles) if (a.v + b.v + d.v === left) return `${a.l} ${b.l} ${d.l}`;
  return null;
}
