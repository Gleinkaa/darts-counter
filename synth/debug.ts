// Dev helper: dump one synthetic throw (frames, change mask, detection).
//   node synth/debug.ts <outdir> <tiltMin> <tiltMax> <scene> <throw 0..2> [seed0]
import { CALIBRATION_POINTS, scoreAt, scoreLabel } from '../src/board.ts';
import { apply, fitHomography, invert } from '../src/homography.ts';
import { detectDart } from '../src/detect.ts';
import { boardMask } from '../src/mask.ts';
import { makeImg } from '../src/img.ts';
import { type Dart, makeScene, randomDart, randomTip, renderFrame, rng } from './render.ts';
import { writePPM } from './ppm.ts';

const [out, t0, t1, sIdx, kIdx, seedArg] = process.argv.slice(2);
const seed = Number(seedArg ?? 1000) + Number(sIdx) * 101;
const sc = makeScene(seed, { tilt: [Number(t0), Number(t1)] });
const R = rng(seed + 5);
const taps = CALIBRATION_POINTS.map((p) => {
  const q = apply(sc.H, p);
  return { x: q.x + R.normal(), y: q.y + R.normal() };
});
const H = fitHomography(CALIBRATION_POINTS, taps);
const mask = boardMask(H, sc.cam.w, sc.cam.h);
const darts: Dart[] = [];
let prev = renderFrame(sc, darts, seed * 13, 1);
for (let k = 0; k <= Number(kIdx); k++) {
  const d = randomDart(R, randomTip(R));
  darts.push(d);
  const next = renderFrame(sc, darts, seed * 13 + k + 1, 1 + R.normal() * 0.02);
  if (k === Number(kIdx)) {
    const dbg: NonNullable<NonNullable<Parameters<typeof detectDart>[2]>['debug']> = {};
    const det = detectDart(prev, next, { mask, H, debug: dbg });
    const truePx = apply(sc.H, d.tip);
    console.log('truth', scoreLabel(scoreAt(d.tip.x, d.tip.y)), 'tipPx', truePx, 'dir', d.dir);
    console.log('dbg', { reason: dbg.reason, thr: dbg.thr, elong: dbg.elong, comps: dbg.comps, merged: dbg.merged });
    console.log((dbg.cands ?? []).filter((c) => !/score=0\.|score=[0-9]\./.test(c)).join('\n'));
    if (det) {
      const p = apply(invert(H), det.tip);
      console.log('det', det.tip, 'tail', det.tail, 'conf', det.confidence.toFixed(2), '->', scoreLabel(scoreAt(p.x, p.y)), 'err', Math.hypot(p.x - d.tip.x, p.y - d.tip.y).toFixed(1));
    }
    const vis = makeImg(sc.cam.w, sc.cam.h);
    for (let i = 0; i < vis.width * vis.height; i++) {
      const on = dbg.bin?.[i];
      vis.data[i * 4] = on ? 255 : next.data[i * 4] * 0.4;
      vis.data[i * 4 + 1] = next.data[i * 4 + 1] * 0.4;
      vis.data[i * 4 + 2] = next.data[i * 4 + 2] * 0.4;
    }
    const mark = (p: { x: number; y: number }, c: number[]) => {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy;
        if (x < 0 || y < 0 || x >= vis.width || y >= vis.height || (dx && dy)) continue;
        const i = (y * vis.width + x) * 4;
        vis.data[i] = c[0]; vis.data[i + 1] = c[1]; vis.data[i + 2] = c[2];
      }
    };
    mark(truePx, [0, 255, 0]);
    if (det) mark(det.tip, [0, 160, 255]);
    writePPM(`${out}/dbg_after.ppm`, next);
    writePPM(`${out}/dbg_mask.ppm`, vis);
  }
  prev = next;
}
