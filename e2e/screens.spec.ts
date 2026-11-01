// Mobile layout evidence: setup, calibration and play screens at 390x844 and 844x390, written to docs/screens/.
// The screenshots are reviewed by eye (nothing may be cut off or overlap); this spec only produces them.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Fixture {
  w: number;
  h: number;
  calibrationPx: { x: number; y: number }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, '..', 'docs', 'screens');
const fx: Fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'darts.json'), 'utf8')) as Fixture;

/** video px -> page px, for an object-fit: contain video inside the camera box. */
async function clickCalibrationPoints(page: Page): Promise<void> {
  const cam = page.getByTestId('camera');
  const box = await cam.boundingBox();
  expect(box).not.toBeNull();
  const b = box!;
  const k = Math.min(b.width / 640, b.height / 480);
  const ox = (b.width - 640 * k) / 2;
  const oy = (b.height - 480 * k) / 2;
  for (const p of fx.calibrationPx) await page.mouse.click(b.x + ox + p.x * k, b.y + oy + p.y * k);
}

for (const [w, h] of [
  [390, 844],
  [844, 390],
] as const) {
  const tag = `${w}x${h}`;
  test(`layout at ${tag}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });

    await page.goto('/');
    await expect(page.getByTestId('start')).toBeVisible();
    await page.screenshot({ path: join(shots, `setup-${tag}.png`), fullPage: true });

    await page.getByTestId('start').click();
    const cam = page.getByTestId('camera');
    await expect(cam).toBeVisible();
    await expect
      .poll(() => cam.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 })
      .toBe(640);

    await clickCalibrationPoints(page);
    // Four points placed: the fitted board overlay is drawn on the camera picture.
    await expect(page.getByTestId('calib-ok')).toBeEnabled();
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `calibrate-${tag}.png`), fullPage: true });

    await page.getByTestId('calib-ok').click();
    // Wait for the third dart, then log what the app scored: the turn total is the regression signal.
    await expect(page.getByTestId('dart-2')).not.toBeEmpty({ timeout: 30_000 });
    const labels = await Promise.all([0, 1, 2].map((i) => page.getByTestId(`dart-${i}`).innerText()));
    console.log(`  ${tag} darts: ${labels.map((l) => l.split('\n')[0]).join(' ')}`);
    await expect(page.getByTestId('visit-total')).toHaveText('115', { timeout: 5_000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(shots, `play-${tag}.png`), fullPage: true });

    console.log(`  wrote docs/screens/{setup,calibrate,play}-${tag}.png`);
  });
}
