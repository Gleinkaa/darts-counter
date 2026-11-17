# Pull-out port review — commits 95c9dc4..a9740e9

> Reviewer: deepseek-v4-pro. The lane was started as `darts-port-review-astra`, but omp fell back off
> gpt-6-astra at spawn (`resolvedModelIsFallback`), so this is a DeepSeek review, not a cross-vendor one.

**Verdict: GO WITH CHANGES** — the hand-over mechanism is correct and actually fixes the pre-port
"stale pull advances the wrong player" bug; tests and typecheck are green. Four findings, all fixable
without design rework. One is a documentation-evidence gap; three are edge-case state leaks/UX guards.

Checks run: `npm test` (86/86 pass, 10 files) and `npm run typecheck` (clean). `npm run eval`/`npm run e2e`
not run (slow); no claim in the findings depends on them.

## Findings

### 1. MAJOR — README "board crop" numbers are asserted, not reproducible

`README.md:156-159` claims the board-crop idea was *"Measured against this app's own eval"* with
two-decimal figures: *"score accuracy is unchanged (79.8 → 79.8/80.0 %, 4 vs 4 throws flip), with only
a smaller p90 tail (4.93 → 3.52 mm)"*.

There is no crop code or ablation anywhere in the repo. `grep -r crop` returns only `README.md:156`
(plus an unrelated colour constant in `src/ui/boardSvg.ts`). `synth/eval.ts` implements two ablations —
`--rest N` (resting frames) and `--bulltap` (5-tap) — plus `--rows` for paired diffs, but no crop path,
and `synth/` contains no crop script (`ls synth/`). By contrast, ideas #1 and #3 in the same section are
reproducible: their "N of 612 throws flip / median shift" figures fall out of
`node synth/eval.ts --scenes 40 --rows a.json` vs `--rest 1` / `--bulltap` (612 is exactly the
`all.concat(noSnap)` row count at `--scenes 40`).

So the section's framing *"Each was measured against this app's own eval"* (`README.md:136-137`) is not
supported for idea #2. The drop decision itself is sound (960 px long side already, ~22 % gain vs the
plain-JS ~2×, per the README's own geometric argument), but the precision is presented as measurement
with no measurement to point at. Recommend either committing a `--crop` ablation to `synth/eval.ts`, or
rewording to "estimated / derived from the geometry".

### 2. MINOR — `BoardCycle.newGame()` does not reset `checking`/`empty`; a stale board check leaks into the next game

`src/handover.ts:89-91` resets only `owner` and `autoAdvancedAt`. `renderSetup()` (`src/main.ts:215`)
and `newGame()` (`src/main.ts:298`) never reset `cycle` beyond that.

Repro: abandon a game while a board check is open (`cycle.checking === true`), then choose
"Play without camera" (manual). `renderPlay()` → `refresh()` sets `check.hidden = !cycle.checking`
(`src/main.ts:773`), so the board-check panel appears in a camera-less game with no way to satisfy it
except tapping "Board is empty". A stale `empty === false` also makes `dartsIn` true on the next
camera calibration (`src/main.ts:458`), wrongly showing "Pull all darts out first".

### 3. MINOR — "Darts pulled ▸" during an open board check leaves the camera stuck in `checking`

The `#next` handler (`src/main.ts:603-614`) calls `tracker.resync(grab(cam))` unconditionally.
`resync` (`src/tracker.ts:147-153`) calls `clearMotion()` (`src/tracker.ts:155-163`), which does not
clear `checking`; only `reset` and `resetWhenStill` do (`src/tracker.ts:132,143`).

Effect: the game advances (`next(true)`), but the tracker keeps returning `[]` (feed early-returns on
`checking`, `src/tracker.ts:195`), and `cycle.checking` is not cleared either — the check panel stays up
while the turn has already moved on. Recovery only by tapping "Board is empty", which then hands over
nothing (the visit already advanced). Not a wrong-turn bug, but the camera and game disagree until then.

### 4. MINOR — `canNext()` auto-advance guard re-engages after a throw-then-undo

`autoAdvancedAt` is cleared only when `events.length < autoAdvancedAt` (`src/main.ts:771`); undoing a
dart back to exactly `autoAdvancedAt` leaves it set. Verified with a throwaway probe:

1. A throws 3 darts and pulls → hand-over; `events.length === 4 === autoAdvancedAt`.
2. B throws 1 dart (`events.length === 5`) and taps Undo (`events.length === 4`).

Now `canNext()` returns false (`src/handover.ts:83-86`: empty, open visit with
`events.length === autoAdvancedAt`), so "Darts pulled ▸" shows "Already B's turn" and is blocked until
B throws or adds a dart. The guard exists to stop a Next tap from skipping the player right after an
auto hand-over, but it does not distinguish "nothing happened yet" from "threw and undid".

## Coverage check (question 3)

`tests/handover.test.ts` covers every case the task enumerates: 501 (test 1), 301 bust (4), double-out
bust + checkout (5, 12), cricket marks/points + hand-over (6), undo of hand-over / bust / manual Next
(1, 5, 9), manual Next with darts still in (7, 8), board check (11), and 1–4-player rotation (3).
`tests/game.test.ts:165-178` covers cricket win and x01 checkout/bust independently. Gaps, none of them
defects: cricket *checkout + pull* is not exercised end-to-end in `handover.test.ts` (the shared
`empty`-handler path is covered by the x01 checkout test 12), and x01 with `doubleOut: false` (301) has
no hand-over test. The empty-handler's owner guard is the part most worth a regression test (finding 4's
throw-then-undo sequence has none).
