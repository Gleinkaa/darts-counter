// Experiment: whole frame scaled to 960 px vs only the board crop, from a native camera stream.
//   node synth/crop-exp.ts [scenes] [native WxH] [cropRadiusMm]
// This is the reproducible measurement behind README.md's "board crop at native resolution" (dropped).
// It compares the app's current whole-frame 960 px pipeline against a native-resolution board crop,
// and against a crop with the snap-to-wires re-run inside the crop.
import { CALIBRATION_POINTS, scoreAt } from '../src/board.ts';
import { detectDart } from '../src/detect.ts';
import { apply, fitHomography, invert, mul, type Mat3 } from '../src/homography.ts';
import { makeImg, type Img } from '../src/img.ts';
import { boardMask } from '../src/mask.ts';
import { refineCalibration } from '../src/refine.ts';
import { type Dart, makeScene, randomDart, randomTip, renderFrame as renderRGB, rng } from './render.ts';
import { frameToI420, i420ToFrame } from './y4m.ts';

const SCENES = Number(process.argv[2] ?? 30);
const [NW, NH] = (process.argv[3] ?? '1280x720').split('x').map(Number);
const CROP_MM = Number(process.argv[4] ?? 330);
const PROC_LONG = 960;
const cam420 = (im: Img) => i420ToFrame(frameToI420(im), im.width, im.height);

/** drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh) with an area (box) filter. */
function resample(src: Img, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Img {
  const axis = (s0: number, sl: number, dl: number) =>
    Array.from({ length: dl }, (_, i) => {
      const a = s0 + (i * sl) / dl, b = s0 + ((i + 1) * sl) / dl;
      const w: [number, number][] = [];
      for (let p = Math.floor(a); p < Math.ceil(b); p++) {
        const c = Math.min(b, p + 1) - Math.max(a, p);
        if (c > 1e-9) w.push([Math.min(src.width - 1, Math.max(0, p)), c / (b - a)]);
      }
      return w;
    });
  const wx = axis(sx, sw, dw), wy = axis(sy, sh, dh);
  const out = makeImg(dw, dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) {
      const acc = [0, 0, 0];
      for (const [py, ky] of wy[y].map(([p, k]) => [Math.min(src.height - 1, p), k]))
        for (const [px, kx] of wx[x]) {
          const i = (py * src.width + px) * 4;
          for (let c = 0; c < 3; c++) acc[c] += src.data[i + c] * kx * ky;
        }
      const o = (y * dw + x) * 4;
      out.data[o] = acc[0]; out.data[o + 1] = acc[1]; out.data[o + 2] = acc[2]; out.data[o + 3] = 255;
    }
  return out;
}

interface View { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number; A: Mat3 }
function view(sx: number, sy: number, sw: number, sh: number): View {
  const k = Math.min(1, PROC_LONG / Math.max(sw, sh));
  const dw = Math.round(sw * k), dh = Math.round(sh * k);
  return { sx, sy, sw, sh, dw, dh, A: [dw / sw, 0, (-sx * dw) / sw, 0, dh / sh, (-sy * dh) / sh, 0, 0, 1] };
}
/** Board crop in native px from the (full-frame proc) calibration. */
function cropView(Hnative: Mat3, FW: number, FH: number): View {
  const pts = Array.from({ length: 72 }, (_, i) => apply(Hnative, { x: CROP_MM * Math.cos((i * Math.PI) / 36), y: CROP_MM * Math.sin((i * Math.PI) / 36) }));
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)))), x1 = Math.min(FW, Math.ceil(Math.max(...pts.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)))), y1 = Math.min(FH, Math.ceil(Math.max(...pts.map((p) => p.y))));
  return view(x0, y0, x1 - x0, y1 - y0);
}
const grab = (im: Img, v: View) => resample(im, v.sx, v.sy, v.sw, v.sh, v.dw, v.dh);

type Res = { ok: boolean; err: number };
const results: Record<string, Res[]> = { whole: [], crop: [], cropResnap: [] };
const pxmm: Record<string, number[]> = { whole: [], crop: [] };
for (const [label, seed0, w, h] of [['land', 10_000_000, NW, NH], ['port', 11_000_000, NH, NW]] as const) {
  for (let s = 0; s < SCENES; s++) {
    const seed = seed0 + s * 101;
    const sc = makeScene(seed, { tilt: [25, 55], w, h });
    const NWs = w, NHs = h;
    const R = rng(seed + 5);
    const whole = view(0, 0, NWs, NHs);
    // Calibration on the full-frame processed image (the calibration screen).
    const Htrue = mul(whole.A, sc.H);
    const taps = CALIBRATION_POINTS.map((p) => {
      const q = apply(Htrue, p);
      return { x: q.x + R.normal() * 2, y: q.y + R.normal() * 2 };
    });
    const emptyN = cam420(renderRGB(sc, [], seed * 13, 1));
    const Hfull = refineCalibration(grab(emptyN, whole), fitHomography(CALIBRATION_POINTS, taps), CALIBRATION_POINTS).H;
    const Hnat = mul(invert(whole.A), Hfull);
    const cv = (() => { const v = cropView(Hnat, NWs, NHs); return v.sw > NWs || v.sh > NHs ? whole : v; })();
    const paths: Record<string, { v: View; H: Mat3 }> = {
      whole: { v: whole, H: Hfull },
      crop: { v: cv, H: mul(cv.A, Hnat) },
    };
    paths.cropResnap = { v: cv, H: refineCalibration(grab(emptyN, cv), paths.crop.H, CALIBRATION_POINTS).H };
    const masks = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, boardMask(p.H, p.v.dw, p.v.dh)]));
    for (const k of ['whole', 'crop'] as const) {
      const a = apply(paths[k].H, { x: 0, y: 0 }), b = apply(paths[k].H, { x: 100, y: 0 });
      pxmm[k].push(Math.hypot(b.x - a.x, b.y - a.y) / 100);
    }
    for (let turn = 0; turn < 2; turn++) {
      const darts: Dart[] = [];
      let prevN = turn === 0 ? emptyN : cam420(renderRGB(sc, [], seed * 13 + turn * 7, 1));
      const prev: Record<string, Img> = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, grab(prevN, p.v)]));
      for (let k = 0; k < 3; k++) {
        const d = randomDart(R, randomTip(R));
        darts.push(d);
        const exposure = 1 + R.normal() * 0.02;
        const nextN = cam420(renderRGB(sc, darts, seed * 13 + turn * 7 + k + 1, exposure));
        const truth = scoreAt(d.tip.x, d.tip.y);
        for (const [name, p] of Object.entries(paths)) {
          const next = grab(nextN, p.v);
          const det = detectDart(prev[name], next, { mask: masks[name], H: p.H });
          let res: Res = { ok: false, err: Infinity };
          if (det) {
            const q = apply(invert(p.H), det.tip);
            const g = scoreAt(q.x, q.y);
            res = { ok: g.points === truth.points && g.ring === truth.ring, err: Math.hypot(q.x - d.tip.x, q.y - d.tip.y) };
          }
          results[name].push(res);
          prev[name] = next;
        }
      }
    }
    process.stderr.write(`${label} ${s} crop ${cv.sw}x${cv.sh}->${cv.dw}x${cv.dh}\n`);
  }
}
const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
const n = results.whole.length;
for (const [k, r] of Object.entries(results)) {
  const e = r.filter((x) => Number.isFinite(x.err)).map((x) => x.err);
  console.log(k, `acc ${(100 * r.filter((x) => x.ok).length / n).toFixed(1)}%`, `median ${med(e).toFixed(2)} mm`, `p90 ${[...e].sort((a, b) => a - b)[Math.floor(0.9 * e.length)].toFixed(2)}`, `<3mm ${(100 * e.filter((x) => x < 3).length / n).toFixed(1)}%`);
}
console.log('px/mm median whole', med(pxmm.whole).toFixed(2), 'crop', med(pxmm.crop).toFixed(2));
for (const k of ['crop', 'cropResnap']) {
  let b = 0, c = 0;
  results.whole.forEach((r, i) => { if (r.ok && !results[k][i].ok) b++; if (!r.ok && results[k][i].ok) c++; });
  console.log(`${k} vs whole: only-whole-right ${b}, only-${k}-right ${c} of ${n}`);
}
