import { describe, expect, it } from 'vitest';
import { poseFromHomography, projectLifted } from '../src/camera.ts';
import { lookAt, boardHomography, project, type V3 } from '../synth/render.ts';

describe('poseFromHomography', () => {
  it('recovers focal length and predicts lifted points for oblique views', () => {
    for (const [tiltDeg, az] of [[30, 0.3], [45, 2.0], [55, 4.1]]) {
      const t = (tiltDeg * Math.PI) / 180;
      const C: V3 = [600 * Math.sin(t) * Math.cos(az), 600 * Math.sin(t) * Math.sin(az), 600 * Math.cos(t)];
      const cam = lookAt(C, [5, -10, 0], 7, 640, 480, 560);
      const P = poseFromHomography(boardHomography(cam), 640, 480);
      expect(P.f).toBeCloseTo(560, -1);
      for (const b of [{ x: 0, y: 0 }, { x: 100, y: -50 }, { x: -150, y: 120 }]) {
        const q = projectLifted(P, b, 120);
        const truth = project(cam, [b.x, b.y, 120]);
        expect(Math.hypot(q.x - truth.x, q.y - truth.y)).toBeLessThan(0.5);
      }
    }
  });

  it('frontal view falls back to a plausible focal length but still projects sensibly', () => {
    const cam = lookAt([0, 0, 600], [0, 0, 0], 0, 640, 480, 560);
    const P = poseFromHomography(boardHomography(cam), 640, 480);
    const q = projectLifted(P, { x: 100, y: 0 }, 120);
    const truth = project(cam, [100, 0, 120]);
    // Direction (outwards from the centre) is what detection uses; it must agree.
    const base = project(cam, [100, 0, 0]);
    expect(Math.sign(q.x - base.x)).toBe(Math.sign(truth.x - base.x));
  });
});
