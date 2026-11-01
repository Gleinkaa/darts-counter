import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The fake camera is the same synthetic clip the detection eval uses (npm run fake-video writes it).
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_VIDEO = join(here, 'e2e', 'fixtures', 'darts.y4m');
const BASE_URL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    permissions: ['camera'],
    launchOptions: {
      // System Chromium — never download Playwright's bundled browser.
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${FAKE_VIDEO}`,
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  // `npm run e2e` builds first; here we only serve dist/ on loopback (never 0.0.0.0).
  webServer: {
    command: 'npm run preview',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
