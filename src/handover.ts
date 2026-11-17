// What a tracker event does to the game, and whose darts are in the board.
//
// Pulling the darts out ends a visit, but only the visit those darts were scored in. A visit owns
// the board from its first camera-scored dart until the board is seen (or confirmed) empty again.
// If that visit was already ended by hand (Next with the darts still in), the pull hands nothing
// over: the next player's visit, even with a dart typed in by hand, goes on. Once the next player's
// own darts are scored, the board is theirs, and pulling everything ends their visit.
// The hand-over is an ordinary "next" event in the game log, so Undo reverts it.

import { scoreAt, type Score } from './board.ts';
import type { Game } from './game.ts';
import type { TrackerEvent } from './tracker.ts';

export type Outcome =
  /** `counted` is false when the visit was already complete (or the game over): the dart is ignored. */
  | { type: 'dart'; score: Score; counted: boolean }
  /** The pull ended the visit; it is `game.state.history.at(-1)`. */
  | { type: 'handover' }
  /** The board is empty again, with nothing to hand over. */
  | { type: 'empty' }
  | { type: Exclude<TrackerEvent['type'], 'dart' | 'empty'> };

/** Position of the visit in progress in the sequence of visits (0, 1, 2, …). */
const visitNo = (game: Game) => game.state.history.length;

export class BoardCycle {
  /** The visit whose darts are in the board, or null. */
  owner: number | null = null;
  /** False from the first change in the board until it is seen or confirmed empty again. */
  empty = true;
  /** A board check is open: the camera scores nothing until the user confirms the board is empty. */
  checking = false;
  /** game.events.length right after an automatic hand-over: a Next tap then would skip a player. */
  autoAdvancedAt = -1;

  apply(game: Game, e: TrackerEvent): Outcome {
    switch (e.type) {
      case 'dart': {
        const score = scoreAt(e.board.x, e.board.y);
        const visit = visitNo(game);
        this.empty = false;
        const counted = game.addDart(score, true, e.board);
        if (counted) {
          this.owner = visit;
          // The next player has thrown: a manual Next tap is allowed again (the auto-advance guard
          // only blocks a Next immediately after the hand-over, before anything else happened).
          this.autoAdvancedAt = -1;
        }
        return { type: 'dart', score, counted };
      }
      case 'nodart':
        // Probably a dart the detector missed; it belongs to whoever is throwing.
        this.empty = false;
        this.owner ??= visitNo(game);
        return { type: 'nodart' };
      case 'empty': {
        const owner = this.owner;
        this.owner = null;
        this.empty = true;
        if (owner === visitNo(game) && game.next()) {
          this.autoAdvancedAt = game.events.length;
          return { type: 'handover' };
        }
        return { type: 'empty' };
      }
      case 'check':
        this.checking = true;
        return { type: 'check' };
      default:
        return { type: e.type };
    }
  }

  /**
   * The user says the board is empty (calibration confirmed, board check answered). A complete
   * visit is handed over, as the pull would have; a visit with darts to go goes on.
   */
  confirmEmpty(game: Game): boolean {
    this.owner = null;
    this.empty = true;
    this.checking = false;
    if (!game.state.visitClosed || !game.next()) return false;
    this.autoAdvancedAt = game.events.length;
    return true;
  }

  /** False right after an automatic hand-over, when a Next tap would skip the next player. */
  canNext(game: Game): boolean {
    const st = game.state;
    return st.visit.darts.length > 0 || st.visitClosed || game.events.length !== this.autoAdvancedAt;
  }

  /** A new game in the same room: the darts in the board (if any) belong to nobody in it. */
  newGame(): void {
    this.owner = null;
    this.empty = true;
    this.checking = false;
    this.autoAdvancedAt = -1;
  }
}
