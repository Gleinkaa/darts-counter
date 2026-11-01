// Build the fake-camera assets for the Playwright e2e test:  node synth/make-video.ts  (= npm run fake-video)
//
//   e2e/fixtures/darts.y4m   640x480 @ 10 fps, 4:2:0, 24 s: empty board, three darts thrown one by one,
//                            then the darts are pulled and the board is empty again.
//   e2e/fixtures/darts.json  sidecar with the calibration pixels, the dart scores and the frame timeline.
//
// Camera and board come from the same generator as the detection eval (synth/render.ts), so the video has real
// perspective, lighting gradient, dart shadows and per-frame sensor noise.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALIBRATION_POINTS, polar, scoreAt, scoreLabel, sectorCenterDeg, type Pt, type Ring } from '../src/board.ts';
import { apply } from '../src/homography.ts';
import { makeScene, randomDart, renderFrame, rng, type Dart } from './render.ts';
import { writeY4M } from './y4m.ts';

const W = 640;
const H = 480;
const FPS = 10;

/** Throw order; the tips are three darts (T20, S5, bull). */
const THROWS: { label: string; tip: Pt; ring: Ring; sector: number }[] = [
  { label: 'T20', tip: polar(103, 0), ring: 'treble', sector: 20 },
  { label: 'S5', tip: polar(140, sectorCenterDeg(5)), ring: 'single', sector: 5 },
  { label: 'Bull', tip: { x: 1, y: -1 }, ring: 'bull', sector: 25 },
];

/** Which darts are in the board during each interval, in seconds. */
const TIMELINE = [
  { fromS: 0, toS: 8, darts: 0 },
  { fromS: 8, toS: 11, darts: 1 },
  { fromS: 11, toS: 14, darts: 2 },
  { fromS: 14, toS: 20, darts: 3 },
  { fromS: 20, toS: 24, darts: 0 },
];
const TOTAL_S = 24;
const FRAMES = TOTAL_S * FPS;

const dartsAt = (t: number): number => TIMELINE.find((e) => t >= e.fromS && t < e.toS)?.darts ?? 0;

const round = (v: number, dp = 3): number => Number(v.toFixed(dp));

export function build(): { y4m: string; json: string; frames: number; turnTotal: number } {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixtures = join(here, '..', 'e2e', 'fixtures');
  mkdirSync(fixtures, { recursive: true });

  const scene = makeScene(4242, { tilt: [38, 42] });

  const R = rng(77);
  const darts: Dart[] = THROWS.map((t) => randomDart(R, t.tip));

  // Each tip must score exactly what its label claims, otherwise the sidecar would lie to the test.
  const scored = THROWS.map(({ label, tip, ring, sector }) => {
    const s = scoreAt(tip.x, tip.y);
    if (s.ring !== ring || s.sector !== sector)
      throw new Error(`dart ${label}: tip (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)}) scores ${s.ring}/${s.sector} (${s.points}), expected ${ring}/${sector}`);
    const got = s.ring === 'single' ? `S${s.sector}` : scoreLabel(s);
    if (got !== label) throw new Error(`dart ${label}: tip scores ${got}`);
    return { label, points: s.points };
  });
  const turnTotal = scored.reduce((sum, d) => sum + d.points, 0);
  if (turnTotal !== 115) throw new Error(`turn total is ${turnTotal}, expected 115`);

  function* frames() {
    for (let f = 0; f < FRAMES; f++) {
      const n = dartsAt(f / FPS);
      yield renderFrame(scene, darts.slice(0, n), 1000 + f, 1);
    }
  }

  const y4m = join(fixtures, 'darts.y4m');
  const json = join(fixtures, 'darts.json');
  const framesWritten = writeY4M(y4m, W, H, FPS, frames());

  const sidecar = {
    w: W,
    h: H,
    fps: FPS,
    // The four calibration taps the user makes, in order 20, 6, 3, 11 (see board.CALIBRATION_POINTS).
    calibrationPx: CALIBRATION_POINTS.map((p) => {
      const q = apply(scene.H, p);
      return { x: round(q.x), y: round(q.y) };
    }),
    darts: scored,
    turnTotal,
    timeline: TIMELINE,
  };
  writeFileSync(json, `${JSON.stringify(sidecar, null, 2)}\n`);

  return { y4m, json, frames: framesWritten, turnTotal };
}

const out = build();
console.log(`wrote ${out.y4m}`);
console.log(`wrote ${out.json}`);
console.log(`${out.frames} frames at ${W}x${H} @ ${FPS} fps (${FRAMES / FPS} s), turn total ${out.turnTotal}`);
