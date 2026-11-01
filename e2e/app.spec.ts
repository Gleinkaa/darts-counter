// End-to-end: calibrate on the fake-camera video, watch three darts being detected, see the turn total,
// then the darts are pulled and the score drops by 115. Fixture ground truth comes from e2e/fixtures/darts.json.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Fixture {
  w: number;
  h: number;
  fps: number;
  calibrationPx: { x: number; y: number }[];
  darts: { label: string; points: number }[];
  turnTotal: number;
  timeline: { fromS: number; toS: number; darts: number }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fx: Fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'darts.json'), 'utf8')) as Fixture;

/** Start the camera, tap the four calibration points, and hand over to the play screen. */
async function calibrate(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('start').click();
  const cam = page.getByTestId('camera');
  await expect(cam).toBeVisible();
  // The fake capture only delivers frames once the stream is live.
  await expect
    .poll(() => cam.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 })
    .toBe(fx.w);

  const box = await cam.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  // video is object-fit: contain inside the camera box, so map video px -> page px.
  const k = Math.min(b.width / fx.w, b.height / fx.h);
  const ox = (b.width - fx.w * k) / 2;
  const oy = (b.height - fx.h * k) / 2;

  for (const p of fx.calibrationPx) await page.mouse.click(b.x + ox + p.x * k, b.y + oy + p.y * k);

  const ok = page.getByTestId('calib-ok');
  await expect(ok).toBeEnabled();
  await ok.click();
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  try {
    const shot = await page.screenshot({ fullPage: true });
    await testInfo.attach('failure', { body: shot, contentType: 'image/png' });
  } catch {
    /* page already gone */
  }
});

test('calibrate, three darts score 115, darts pulled leaves 386', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const t0 = Date.now();
  await calibrate(page);
  console.log(`  calibrated in ${Date.now() - t0} ms`);

  await expect(page.getByTestId('dart-0')).toContainText('T20', { timeout: 30_000 });
  await expect(page.getByTestId('dart-1')).toContainText('5', { timeout: 30_000 });
  await expect(page.getByTestId('dart-2')).toContainText('Bull', { timeout: 30_000 });
  await expect(page.getByTestId('visit-total')).toHaveText(String(fx.turnTotal), { timeout: 30_000 });
  console.log(`  turn total visible at ${Date.now() - t0} ms`);

  // 20 s into the clip the darts are pulled: the visit closes and 501 - 115 is left.
  await expect(page.getByTestId('score-0')).toHaveText('386', { timeout: 20_000 });
  // ... and the pull itself must be detected: the finished visit is banked and a fresh one starts.
  await expect(page.getByTestId('visit-total')).toHaveText('0', { timeout: 20_000 });
  console.log(`  visit closed at ${Date.now() - t0} ms`);

  await page.screenshot({ path: test.info().outputPath('app-final.png'), fullPage: true });
});

test('Back from a mid-game recalibration scores by tap, and Camera brings auto-scoring back', async ({ page }) => {
  // Final review #2/#3: Back used to leave the game in tap-only mode for good, and the confirm
  // button only warned about darts in the board while the visit had darts.
  await page.setViewportSize({ width: 390, height: 844 });
  await calibrate(page);
  await expect(page.getByTestId('dart-0')).toContainText('T20', { timeout: 30_000 });

  await page.locator('#recal').click();
  await expect(page.getByTestId('calib-ok')).toHaveText('Darts are out — start');
  await page.locator('#back').click();
  await expect(page.getByTestId('camera')).toHaveCount(0);
  await expect(page.getByTestId('dart-0')).toContainText('T20'); // the game is kept
  await expect(page.locator('#recal')).toHaveText('Camera');

  await page.locator('#recal').click(); // reopens the camera; the saved calibration comes back
  const ok = page.getByTestId('calib-ok');
  await expect(ok).toBeEnabled({ timeout: 20_000 });
  await ok.click();
  await expect(page.getByTestId('camera')).toBeVisible();
  await expect(page.locator('#recal')).toHaveText('Calibrate');
});
