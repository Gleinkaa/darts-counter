// Tracker-level eval: the held-out landscape scenes of synth/eval.ts, but every frame goes through
// ThrowTracker as in the app (settling, "darts pulled", removals). Prints to the console.
//   node synth/eval-tracker.ts [scenes = 20]
// Written by the final-review Opus reviewer; docs/eval.md "Detector only" quotes its 20-scene result.
import { CALIBRATION_POINTS, scoreAt, scoreLabel } from '../src/board.ts';
import { apply, fitHomography } from '../src/homography.ts';
import { refineCalibration } from '../src/refine.ts';
import { ThrowTracker, type TrackerEvent } from '../src/tracker.ts';
import { type Dart, makeScene, randomDart, randomTip, renderFrame as renderRGB, rng } from './render.ts';
import { frameToI420, i420ToFrame } from './y4m.ts';
const renderFrame = (...a: Parameters<typeof renderRGB>) => { const im = renderRGB(...a); return i420ToFrame(frameToI420(im), im.width, im.height); };
const SCENES = Number(process.argv[2] ?? 20);
let throws = 0, okScore = 0, misType: Record<string, number> = {}, extraEv = 0, visits = 0, visitOk = 0;
for (let s = 0; s < SCENES; s++) {
  const seed = 10_000_000 + s * 101;
  const sc = makeScene(seed, { tilt: [25, 55], w: 960, h: 540 });
  const R = rng(seed + 5);
  const taps = CALIBRATION_POINTS.map((p) => { const q = apply(sc.H, p); return { x: q.x + R.normal() * 2, y: q.y + R.normal() * 2 }; });
  const empty = renderFrame(sc, [], seed * 13, 1);
  const H = refineCalibration(empty, fitHomography(CALIBRATION_POINTS, taps), CALIBRATION_POINTS).H;
  const tr = new ThrowTracker(H, sc.cam.w, sc.cam.h);
  tr.reset(empty);
  let t = 0, fseed = seed * 17;
  const hold = (st: Dart[]) => { const ev: TrackerEvent[] = []; const ex = 1 + R.normal() * 0.01; for (let i = 0; i < 6; i++) ev.push(...tr.feed(renderFrame(sc, st, fseed++, ex), (t += 100))); return ev.filter((e) => e.type !== 'busy'); };
  for (let turn = 0; turn < 2; turn++) {
    const darts: Dart[] = [];
    const line: string[] = [];
    let vOk = true;
    for (let k = 0; k < 3; k++) {
      const d = randomDart(R, randomTip(R));
      darts.push(d);
      const ev = hold(darts);
      throws++;
      const truth = scoreAt(d.tip.x, d.tip.y);
      const dartEv = ev.filter((e) => e.type === 'dart');
      if (ev.length !== 1 || dartEv.length !== 1) { const key = ev.map((e) => e.type).join('+') || 'none'; misType[key] = (misType[key] ?? 0) + 1; vOk = false; line.push(`${scoreLabel(truth)}→[${key}]`); continue; }
      const e = dartEv[0] as Extract<TrackerEvent, { type: 'dart' }>;
      const got = scoreAt(e.board.x, e.board.y);
      if (got.points === truth.points && got.ring === truth.ring) okScore++; else vOk = false;
      line.push(`${scoreLabel(truth)}→${scoreLabel(got)}`);
    }
    const pull = hold([]);
    if (!(pull.length === 1 && pull[0].type === 'empty')) { extraEv++; vOk = false; line.push(`pull→[${pull.map((e) => e.type).join('+')}]`); }
    visits++; if (vOk) visitOk++;
    console.log(`scene ${s} turn ${turn}: ${line.join(' ')}`);
  }
}
console.log({ throws, okScore, acc: (okScore / throws).toFixed(3), misType, badPulls: extraEv, visits, visitOk });
