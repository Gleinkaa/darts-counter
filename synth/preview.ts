// Dev helper: render a few synthetic frames to look at.  node synth/preview.ts <outdir>
import { makeScene, randomDart, renderFrame, rng } from './render.ts';
import { writePPM } from './ppm.ts';

const out = process.argv[2] ?? '.';
for (const seed of [1, 2, 3]) {
  const t = Date.now();
  const sc = makeScene(seed);
  const R = rng(seed * 7);
  const darts = [randomDart(R, { x: 0, y: 103 }), randomDart(R, { x: 10, y: 95 }), randomDart(R, { x: 0, y: 0 })];
  writePPM(`${out}/p${seed}.ppm`, renderFrame(sc, darts, seed));
  console.log(seed, Date.now() - t, 'ms');
}
