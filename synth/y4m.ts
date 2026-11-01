// YUV4MPEG2 writer (4:2:0, full-range BT.601 "JPEG") for the Playwright fake camera
// (--use-file-for-fake-video-capture). Chromium accepts C420jpeg; ffmpeg/ffprobe read the same file.
//
// The file is streamed to disk frame by frame, so a 240-frame video never sits in memory.
import { closeSync, openSync, writeSync } from 'node:fs';
import type { Img } from '../src/img.ts';

/** Y4M stream header; `fps` must be an integer frame rate. */
export function y4mHeader(w: number, h: number, fps: number): string {
  return `YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`;
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * One frame as planar I420: full Y plane, then U, then V (each w/2 x h/2).
 * Full-range BT.601 (the JPEG variant), so white -> 255/128/128 and black -> 0/128/128.
 * Chroma is the 2x2 average of the RGB block, converted afterwards.
 */
export function frameToI420(img: Img): Buffer {
  const { width: w, height: h, data } = img;
  if (w % 2 || h % 2) throw new Error(`4:2:0 needs even dimensions, got ${w}x${h}`);
  const cw = w >> 1;
  const ch = h >> 1;
  const y = Buffer.allocUnsafe(w * h);
  const u = Buffer.allocUnsafe(cw * ch);
  const v = Buffer.allocUnsafe(cw * ch);

  for (let py = 0, p = 0; py < h; py++) {
    for (let px = 0; px < w; px++, p++) {
      const i = p * 4;
      y[p] = clampByte(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
  }

  for (let cy = 0, c = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++, c++) {
      const i00 = ((cy * 2) * w + cx * 2) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + w * 4;
      const i11 = i01 + 4;
      const r = (data[i00] + data[i10] + data[i01] + data[i11]) / 4;
      const g = (data[i00 + 1] + data[i10 + 1] + data[i01 + 1] + data[i11 + 1]) / 4;
      const b = (data[i00 + 2] + data[i10 + 2] + data[i01 + 2] + data[i11 + 2]) / 4;
      u[c] = clampByte(-0.168736 * r - 0.331264 * g + 0.5 * b + 128);
      v[c] = clampByte(0.5 * r - 0.418688 * g - 0.081312 * b + 128);
    }
  }

  return Buffer.concat([y, u, v], w * h * 3 / 2);
}

/**
 * Write a whole Y4M file: header, then `FRAME\n` + Y/U/V per frame, streamed to `path`.
 * `frames` is iterated lazily, so pass a generator to keep memory flat.
 * Returns the number of frames written.
 */
export function writeY4M(path: string, w: number, h: number, fps: number, frames: Iterable<Img>): number {
  const fd = openSync(path, 'w');
  let n = 0;
  try {
    writeSync(fd, y4mHeader(w, h, fps));
    for (const im of frames) {
      if (im.width !== w || im.height !== h) throw new Error(`frame ${n} is ${im.width}x${im.height}, expected ${w}x${h}`);
      writeSync(fd, 'FRAME\n');
      writeSync(fd, frameToI420(im));
      n++;
    }
  } finally {
    closeSync(fd);
  }
  return n;
}

/**
 * Decode an I420 frame back to RGBA (full-range BT.601, chroma upsampled by pixel replication), i.e. what
 * an app sees from a 4:2:0 camera stream. Tests use it to put synthetic frames through the camera pipeline.
 */
export function i420ToFrame(buf: Buffer, w: number, h: number): Img {
  const cw = w >> 1;
  const U = w * h, V = U + cw * (h >> 1);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      const Y = buf[py * w + px];
      const c = (py >> 1) * cw + (px >> 1);
      const u = buf[U + c] - 128, v = buf[V + c] - 128;
      const i = (py * w + px) * 4;
      data[i] = Y + 1.402 * v;
      data[i + 1] = Y - 0.344136 * u - 0.714136 * v;
      data[i + 2] = Y + 1.772 * u;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}
