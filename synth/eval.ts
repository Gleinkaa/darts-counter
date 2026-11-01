// Detection eval on synthetic throws. Writes docs/eval.md.
//   node synth/eval.ts [--scenes 80] [--quick]
// Each scene: random camera/lighting, a simulated user calibration (true wire points + tap
// noise), then turns of 3 darts. Every throw is scored from the detected tip through the
// fitted homography and compared with the ground truth.

import { writeFileSync } from 'node:fs';
import { CALIBRATION_POINTS, scoreAt, scoreLabel, type Pt } from '../src/board.ts';
import { apply, fitHomography, invert } from '../src/homography.ts';
import { detectDart } from '../src/detect.ts';
import { boardMask } from '../src/mask.ts';
import { refineCalibration } from '../src/refine.ts';
import { writePPM } from './ppm.ts';
import type { Img } from '../src/img.ts';
import { type Dart, makeScene, project, randomDart, randomTip, renderFrame as renderRGB, rng } from './render.ts';
import { frameToI420, i420ToFrame } from './y4m.ts';

/** Every frame goes through a 4:2:0 camera stream (chroma at half resolution), like a phone camera. */
const renderFrame = (...a: Parameters<typeof renderRGB>) => {
  const im = renderRGB(...a);
  return i420ToFrame(frameToI420(im), im.width, im.height);
};

const args = process.argv.slice(2);
const argNum = (k: string, d: number) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const SCENES = argNum('--scenes', 80);
const TURNS = argNum('--turns', 2);
const TAP_NOISE_PX = 2.0;
const write = !args.includes('--no-write');
// Debugging: --dump <scene>:<turn>:<dart> <outdir> writes the before/after frames and the change mask
// of that throw in every bucket that runs; --only <prefix> runs just the buckets whose name starts with it.
const argStr = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const DUMP = new Set((argStr('--dump') ?? '').split(',').filter(Boolean));
const DUMP_DIR = DUMP.size ? args[args.indexOf('--dump') + 2] : undefined;
const ONLY = argStr('--only');

interface Row {
  bucket: string;
  scene: number;
  dart: number;
  overlap: boolean;
  detected: boolean;
  errMm: number;
  truth: string;
  got: string;
  ok: boolean;
  reason?: string;
  along?: number;
  across?: number;
}

function segDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const ps = (p: Pt, q: Pt, r: Pt) => {
    const dx = r.x - q.x, dy = r.y - q.y;
    const t = Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(q.x + t * dx - p.x, q.y + t * dy - p.y);
  };
  // Not exact for crossing segments; check a crossing first.
  const cr = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0) return 0;
  return Math.min(ps(a, c, d), ps(b, c, d), ps(c, a, b), ps(d, a, b));
}

function dumpThrow(dir: string, bucket: string, prev: Img, next: Img, bin: Uint8Array | undefined, tip: Pt | undefined, truth: Pt, d: Dart, walk?: string) {
  const tag = bucket.split(' ')[0];
  const vis = { width: next.width, height: next.height, data: new Uint8ClampedArray(next.data) };
  for (let i = 0; i < next.width * next.height; i++) if (bin?.[i]) vis.data[i * 4] = 255;
  const mark = (p: Pt, c: number[]) => {
    for (let k = -5; k <= 5; k++)
      for (const [x, y] of [[Math.round(p.x) + k, Math.round(p.y)], [Math.round(p.x), Math.round(p.y) + k]]) {
        if (x < 0 || y < 0 || x >= vis.width || y >= vis.height) continue;
        const i = (y * vis.width + x) * 4;
        vis.data[i] = c[0]; vis.data[i + 1] = c[1]; vis.data[i + 2] = c[2];
      }
  };
  mark(truth, [0, 255, 0]);
  if (tip) mark(tip, [0, 140, 255]);
  writePPM(`${dir}/${tag}_before.ppm`, prev);
  writePPM(`${dir}/${tag}_after.ppm`, next);
  writePPM(`${dir}/${tag}_mask.ppm`, vis);
  console.log('DUMP', bucket, 'truth px', truth, 'det px', tip, 'dir', d.dir.map((v) => v.toFixed(2)).join(','));
  console.log('WALK', walk);
}

function runBucket(bucket: string, tilt: [number, number], scenes: number, seed0: number, size: [number, number], snap = true): Row[] {
  const rows: Row[] = [];
  if (ONLY && !bucket.startsWith(ONLY)) return rows;
  for (let s = 0; s < scenes; s++) {
    const seed = seed0 + s * 101;
    const sc = makeScene(seed, { tilt, w: size[0], h: size[1] });
    const R = rng(seed + 5);
    // Simulated calibration taps.
    const taps = CALIBRATION_POINTS.map((p) => {
      const q = apply(sc.H, p);
      return { x: q.x + R.normal() * TAP_NOISE_PX, y: q.y + R.normal() * TAP_NOISE_PX };
    });
    const Htaps = fitHomography(CALIBRATION_POINTS, taps);
    const empty = renderFrame(sc, [], seed * 13, 1);
    const H = snap ? refineCalibration(empty, Htaps, CALIBRATION_POINTS).H : Htaps;
    const Hi = invert(H);
    const mask = boardMask(H, sc.cam.w, sc.cam.h);
    const c0 = apply(H, { x: 0, y: 0 }), c1 = apply(H, { x: 100, y: 0 });
    const pxPerMm = Math.hypot(c1.x - c0.x, c1.y - c0.y) / 100;
    for (let turn = 0; turn < TURNS; turn++) {
      const darts: Dart[] = [];
      let prev = turn === 0 ? empty : renderFrame(sc, darts, seed * 13 + turn * 7, 1);
      for (let k = 0; k < 3; k++) {
        const d = randomDart(R, randomTip(R));
        const seg = (x: Dart) => {
          const a = project(sc.cam, [x.tip.x, x.tip.y, 0]);
          const b = project(sc.cam, [x.tip.x + x.dir[0] * 150, x.tip.y + x.dir[1] * 150, x.dir[2] * 150]);
          return [a, b] as const;
        };
        const [a, b] = seg(d);
        const overlap = darts.some((o) => {
          const [c, e] = seg(o);
          // Within the half-width of a flight (16 mm) plus a few px: the darts touch in the image.
          return segDist(a, b, c, e) < 4 + 16 * pxPerMm;
        });
        darts.push(d);
        const exposure = 1 + R.normal() * 0.02;
        const next = renderFrame(sc, darts, seed * 13 + turn * 7 + k + 1, exposure);
        const dbg: { reason?: string; bin?: Uint8Array; walk?: string; cands?: string[] } = {};
        const det = detectDart(prev, next, { mask, H, debug: dbg });
        const truth = scoreAt(d.tip.x, d.tip.y);
        if (DUMP.has(`${s}:${turn}:${k}`) && DUMP_DIR) dumpThrow(DUMP_DIR, `${s}-${turn}-${k} ${bucket}`, prev, next, dbg.bin, det?.tip, apply(sc.H, d.tip), d, (dbg.cands ?? []).filter((c) => !/score=[0-9]\./.test(c)).join('\n  '));
        let got = scoreAt(1e6, 0);
        let errMm = Infinity;
        let along: number | undefined, across: number | undefined;
        if (det) {
          const tp = apply(sc.H, d.tip);
          const ex = det.tip.x - tp.x, ey = det.tip.y - tp.y;
          along = -(ex * det.axis.x + ey * det.axis.y); // + = beyond the true tip
          across = -ex * det.axis.y + ey * det.axis.x;
          const p = apply(Hi, det.tip);
          got = scoreAt(p.x, p.y);
          errMm = Math.hypot(p.x - d.tip.x, p.y - d.tip.y);
        }
        rows.push({
          bucket,
          scene: s,
          dart: k,
          overlap,
          detected: !!det,
          errMm,
          truth: scoreLabel(truth),
          got: det ? scoreLabel(got) : '—',
          ok: !!det && got.points === truth.points && got.ring === truth.ring,
          reason: dbg.reason,
          along,
          across,
        });
        prev = next;
      }
    }
  }
  return rows;
}

function pct(v: number[], q: number) {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function summary(rows: Row[]) {
  const det = rows.filter((r) => r.detected);
  const e = det.map((r) => r.errMm);
  return {
    n: rows.length,
    detected: det.length / rows.length,
    acc: rows.filter((r) => r.ok).length / rows.length,
    mean: e.reduce((a, b) => a + b, 0) / (e.length || 1),
    median: pct(e, 0.5),
    p90: pct(e, 0.9),
    p95: pct(e, 0.95),
    under3: e.filter((x) => x < 3).length / rows.length,
  };
}

const t0 = Date.now();
// Report seeds start at 10 000 000 and were never looked at while developing or tuning the detector.
// Tuning used seeds 1000+ (640×480), 2 000 000+ (landscape) and the e2e fixture, see TUNING below.
const LAND: [number, number] = [960, 540];
const PORT: [number, number] = [540, 960];
const oblique = runBucket('landscape 960×540, oblique 25–55°', [25, 55], SCENES, 10_000_000, LAND);
const portrait = runBucket('portrait 540×960, oblique 25–55°', [25, 55], Math.round(SCENES * 0.66), 11_000_000, PORT);
const front = runBucket('landscape 960×540, near-front 0–20°', [0, 20], Math.max(10, Math.round(SCENES / 3)), 12_000_000, LAND);
const small = runBucket('4:3 640×480, oblique 25–55°', [25, 55], Math.max(10, Math.round(SCENES / 3)), 13_000_000, [640, 480]);
const noSnap = runBucket('oblique, taps only', [25, 55], Math.max(10, Math.round(SCENES / 4)), 10_000_000, LAND, false);
const obliqueAll = [...oblique, ...portrait];
const all = [...oblique, ...portrait, ...front, ...small];
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
/** Wilson 95 % interval for a proportion. */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}
const head = '| set | throws | detected | score accuracy | 95 % CI | mean err mm | median | p90 | p95 | tip err < 3 mm |\n|---|---|---|---|---|---|---|---|---|---|';
const row = (name: string, rows: Row[]) => {
  const s = summary(rows);
  const [lo, hi] = wilson(rows.filter((r) => r.ok).length, rows.length);
  return `| ${name} | ${s.n} | ${f(s.detected * 100)} % | **${f(s.acc * 100)} %** | ${f(lo * 100)}–${f(hi * 100)} % | ${f(s.mean, 2)} | ${f(s.median, 2)} | ${f(s.p90, 2)} | ${f(s.p95, 2)} | ${f(s.under3 * 100)} % |`;
};
const misses = all.filter((r) => !r.ok).slice(0, 60);
// Failure breakdown over ALL oblique failures (both orientations), computed here so docs cannot drift.
const obFails = obliqueAll.filter((r) => !r.ok);
const cats: [string, (r: Row) => boolean][] = [
  ['dart not found', (r) => !r.detected],
  ['overlapping an earlier dart', (r) => r.detected && r.overlap],
  ['within 3 mm, a wire crossed', (r) => r.detected && !r.overlap && r.errMm < 3],
  ['larger error, not overlapping', (r) => r.detected && !r.overlap && r.errMm >= 3],
];
const breakdown = cats
  .map(([name, test]) => {
    const n = obFails.filter(test).length;
    return `| ${name} | ${n} | ${f((100 * n) / Math.max(1, obFails.length), 0)} % |`;
  })
  .join('\n');

const md = `# Detection eval (synthetic)

Generated by \`npm run eval\` (\`synth/eval.ts\`) on ${new Date().toISOString().slice(0, 10)}, ${secs}s.

**Scenes.** Random pinhole camera: focal length 0.8–1.0 × width, board radius 34–44 % of the shorter image side,
roll ±10°, viewing angle from the board normal as listed. Lighting gradient and vignetting, sensor noise
σ 2–4.5, exposure jitter σ 2 % between frames, soft dart shadows. Every frame goes through **4:2:0 chroma
subsampling** (YUV round-trip), as a phone camera stream does. Darts are 3-D: steel point, barrel,
coloured shaft and two crossed flight fins, randomly tilted about 10°, painted far to near so a dart can hide
another. ${TURNS} turns of 3 darts per scene.

**Frame sizes are the ones the app processes.** The app scales the camera stream to 960 px on the long side
(\`PROC_LONG\` in \`src/main.ts\`), so a 1280×720 stream becomes 960×540 in landscape and 540×960 in portrait.
640×480 is a 4:3 stream, such as the e2e fake camera.

**Calibration is simulated user taps** on the four wire points (20, 6, 3, 11) with σ ${TAP_NOISE_PX} px noise,
refined by the app's snap-to-wires step (\`src/refine.ts\`). The numbers therefore include calibration error,
not just detection error.

**Held out.** The report seeds (10 000 000 and up) were never used while developing or tuning the detector.
These are its tuned constants and the data each was set on:

| constant (\`src/detect.ts\`) | value | tuned on |
|---|---|---|
| \`TIP_BACKOFF_PX\` | 1.75 px | along-axis bias, seeds 1000+ at 640×480 |
| \`MAX_GAP_PX\`, \`RESUME_PX\` | 7 px, 1.5 px | e2e fixture frames, then landscape seeds 2 000 000–2 003 232 |
| tip-walk threshold \`low\` | max(11, 2.4 × noise) | the same |
| pose cap on the point length | 1.4 × predicted + 3 px | the same |
| everything else (thresholds, prior weights, merge rules) | — | seeds 1000+ at 640×480, while developing |

**Throws.** 85 % are aimed at T20, bull, T19, D20 and D16 with σ 18 mm; 15 % are uniform over r ≤ 200 mm, which
includes misses on the number ring. A throw "overlaps" when its projected axis passes within one flight
half-width (16 mm) of an earlier dart's axis in the image. A throw is correct when ring and points match the
truth. Every miss scores the same, so a detected miss counts as correct.

**Not modelled.** Lens distortion, an off-centre principal point, glare, numbers on the ring, wires measured to
their outside edge, and motion blur. The renderer shares the app's pinhole assumptions, so real boards will do
worse. These are synthetic numbers, not field results.

**Detector only.** This eval gives the detector clean before/after frame pairs. The app's frame-stream tracker
(settling, "darts pulled", removals) is not exercised. A review probe that feeds the frames through the tracker
(\`node synth/eval-tracker.ts\`: 20 held-out landscape scenes, 2 visits each, 120 throws) scored **87.5 %** (105/120, 95 % CI about 80–92 %),
with 2 throws producing no event and every pull recognised. Expect the app to score somewhat below the numbers
here.

| | |
|---|---|
| Brief targets | tip error < 3 mm; score accuracy ≥ 95 % over ≥ 200 throws, overlapping darts included |

${head}
${row('**landscape 960×540, oblique 25–55° (recommended)**', oblique)}
${row('… overlapping an earlier dart', oblique.filter((r) => r.overlap))}
${row('**portrait 540×960, oblique 25–55°**', portrait)}
${row('… overlapping an earlier dart', portrait.filter((r) => r.overlap))}
${row('**oblique, both orientations**', obliqueAll)}
${row('4:3 640×480, oblique', small)}
${row('landscape 960×540, near-front 0–20° (not recommended)', front)}
${row('*ablation: landscape oblique, first ' + noSnap.length + ' throws, taps only (no snap)*', noSnap)}
${row('*… the same throws with snap*', oblique.slice(0, noSnap.length))}

"Tip err < 3 mm" is the share of all throws, with undetected throws counted as failures. Error is measured on
the board plane, between the detected tip (mapped through the fitted homography) and the true tip.
The 95 % CI is a Wilson interval on score accuracy.

## Why throws fail (all ${obFails.length} oblique failures, both orientations)

| cause | throws | share |
|---|---|---|
${breakdown}

## Failures (first ${misses.length})

| set | scene | dart | overlap | truth | detected | err mm |
|---|---|---|---|---|---|---|
${misses.map((r) => `| ${r.bucket} | ${r.scene} | ${r.dart + 1} | ${r.overlap ? 'yes' : ''} | ${r.truth} | ${r.got} | ${f(r.errMm, 1)} |`).join('\n')}
`;

console.log(head);
console.log(row('landscape oblique', oblique));
console.log(row('  overlap', oblique.filter((r) => r.overlap)));
console.log(row('portrait oblique', portrait));
console.log(row('  overlap', portrait.filter((r) => r.overlap)));
console.log(row('640x480 oblique', small));
console.log(row('near-front', front));
console.log(row('no snap', noSnap));
console.log(row('same w/ snap', oblique.slice(0, noSnap.length)));
console.log(`${secs}s`);
if (args.includes('--bias')) {
  const ok = all.filter((r) => r.along !== undefined && r.errMm < 20);
  const al = ok.map((r) => r.along!), ac = ok.map((r) => Math.abs(r.across!));
  console.log('along px: median', f(pct(al, 0.5), 2), 'p10', f(pct(al, 0.1), 2), 'p90', f(pct(al, 0.9), 2), '| |across| median', f(pct(ac, 0.5), 2), 'p90', f(pct(ac, 0.9), 2));
}
if (args.includes('--fails')) for (const r of all.filter((x) => !x.ok)) console.log(r.bucket, r.scene, r.dart, r.truth, r.got, f(r.errMm), r.reason ?? '');
if (write) writeFileSync(new URL('../docs/eval.md', import.meta.url), md);
