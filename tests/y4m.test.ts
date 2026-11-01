import { describe, expect, it } from 'vitest';
import { makeImg, type Img } from '../src/img.ts';
import { frameToI420, y4mHeader } from '../synth/y4m.ts';

/** Solid-colour 4x2 RGBA image. */
function solid(r: number, g: number, b: number): Img {
  const im = makeImg(4, 2);
  for (let i = 0; i < 4 * 2; i++) {
    im.data[i * 4] = r;
    im.data[i * 4 + 1] = g;
    im.data[i * 4 + 2] = b;
    im.data[i * 4 + 3] = 255;
  }
  return im;
}

/** Split an I420 buffer into its planes. */
function planes(buf: Buffer, w: number, h: number) {
  const ny = w * h;
  const nc = (w >> 1) * (h >> 1);
  return { y: buf.subarray(0, ny), u: buf.subarray(ny, ny + nc), v: buf.subarray(ny + nc, ny + 2 * nc) };
}

const all = (b: Uint8Array, v: number) => Array.from(b).every((x) => x === v);

describe('y4m header', () => {
  it('is the exact string Chromium expects', () => {
    expect(y4mHeader(640, 480, 10)).toBe('YUV4MPEG2 W640 H480 F10:1 Ip A1:1 C420jpeg\n');
  });
});

describe('frameToI420', () => {
  it('has length w*h*3/2 (one Y plane + two quarter-size chroma planes)', () => {
    const buf = frameToI420(solid(10, 20, 30));
    expect(buf.length).toBe((4 * 2 * 3) / 2);
    const p = planes(buf, 4, 2);
    expect(p.y.length).toBe(8);
    expect(p.u.length).toBe(2);
    expect(p.v.length).toBe(2);
  });

  it('maps white to 255/128/128', () => {
    const p = planes(frameToI420(solid(255, 255, 255)), 4, 2);
    expect(all(p.y, 255)).toBe(true);
    expect(Array.from(p.u)).toEqual([128, 128]);
    expect(Array.from(p.v)).toEqual([128, 128]);
  });

  it('maps black to 0/128/128', () => {
    const p = planes(frameToI420(solid(0, 0, 0)), 4, 2);
    expect(all(p.y, 0)).toBe(true);
    expect(Array.from(p.u)).toEqual([128, 128]);
    expect(Array.from(p.v)).toEqual([128, 128]);
  });

  it('maps pure red to Y 76 and V 255 (full-range BT.601)', () => {
    const p = planes(frameToI420(solid(255, 0, 0)), 4, 2);
    expect(Array.from(p.y)).toEqual([76, 76, 76, 76, 76, 76, 76, 76]);
    expect(Array.from(p.u)).toEqual([85, 85]);
    expect(Array.from(p.v)).toEqual([255, 255]);
  });

  it('averages chroma over each 2x2 block', () => {
    // Left column black, right column white in every row.
    const im = makeImg(4, 2);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 4; x++) {
        const v = x < 2 ? 0 : 255;
        const i = (y * 4 + x) * 4;
        im.data[i] = v;
        im.data[i + 1] = v;
        im.data[i + 2] = v;
        im.data[i + 3] = 255;
      }
    const p = planes(frameToI420(im), 4, 2);
    expect(Array.from(p.u)).toEqual([128, 128]);
    expect(Array.from(p.v)).toEqual([128, 128]);
    expect(Array.from(p.y)).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
  });

  it('rejects odd dimensions', () => {
    expect(() => frameToI420(makeImg(3, 2))).toThrow();
  });
});
