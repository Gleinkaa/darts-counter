import { describe, expect, it } from 'vitest';
import { polar, scoreAt, scoreLabel } from '../src/board.ts';
import { detectDart } from '../src/detect.ts';
import { apply, invert } from '../src/homography.ts';
import { boardMask } from '../src/mask.ts';
import { makeScene, randomDart, renderFrame, rng } from '../synth/render.ts';
import { frameToI420, i420ToFrame } from '../synth/y4m.ts';
import type { Img } from '../src/img.ts';

/** Through a 4:2:0 camera stream, like the e2e fake camera: chroma at half resolution. */
const cam420 = (im: Img) => i420ToFrame(frameToI420(im), im.width, im.height);

describe('detectDart', () => {
  // The e2e fixture's first dart: T20, 4 mm inside the treble wire. Its steel point crosses the
  // wire, where point and wire look alike; the tip walk must bridge that gap. Before the fix this
  // scored "20" on about 45 % of noise realisations (tip 7.5 mm short).
  const sc = makeScene(4242, { tilt: [38, 42] });
  const mask = boardMask(sc.H, sc.cam.w, sc.cam.h);
  const Hi = invert(sc.H);
  const dart = randomDart(rng(77), polar(103, 0));

  it('scores a point that crosses a wire on every noise realisation (4:2:0 frames)', () => {
    const before = cam420(renderFrame(sc, [], 1));
    for (let seed = 100; seed < 112; seed++) {
      const det = detectDart(before, cam420(renderFrame(sc, [dart], seed)), { mask, H: sc.H });
      expect(det).not.toBeNull();
      const b = apply(Hi, det!.tip);
      expect(scoreLabel(scoreAt(b.x, b.y)), `seed ${seed}`).toBe('T20');
      expect(Math.hypot(b.x - dart.tip.x, b.y - dart.tip.y)).toBeLessThan(2.5);
    }
  });

  it('finds nothing between two frames of an unchanged board', () => {
    expect(detectDart(renderFrame(sc, [], 1), renderFrame(sc, [], 2), { mask, H: sc.H })).toBeNull();
  });

  it('works without the pose prior (no H) on a clear dart', () => {
    const det = detectDart(renderFrame(sc, [], 1), renderFrame(sc, [dart], 2), { mask });
    expect(det).not.toBeNull();
    const b = apply(Hi, det!.tip);
    expect(Math.hypot(b.x - dart.tip.x, b.y - dart.tip.y)).toBeLessThan(3);
  });
});
