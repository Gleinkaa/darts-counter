// Write an Img as a binary PPM (P6); ffmpeg/most viewers read it, no image library needed.
import { writeFileSync } from 'node:fs';
import type { Img } from '../src/img.ts';

export function toPPM(im: Img): Buffer {
  const head = Buffer.from(`P6\n${im.width} ${im.height}\n255\n`);
  const body = Buffer.alloc(im.width * im.height * 3);
  for (let i = 0, n = im.width * im.height; i < n; i++) {
    body[i * 3] = im.data[i * 4];
    body[i * 3 + 1] = im.data[i * 4 + 1];
    body[i * 3 + 2] = im.data[i * 4 + 2];
  }
  return Buffer.concat([head, body]);
}

export function writePPM(path: string, im: Img): void {
  writeFileSync(path, toPPM(im));
}
