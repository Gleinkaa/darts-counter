/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Never bind 0.0.0.0: put HTTPS in front (GitHub Pages, or `tailscale serve` for self-hosting).
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true, allowedHosts: ['.ts.net'] },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, allowedHosts: ['.ts.net'] },
  build: { target: 'es2022' },
  // The synthetic-image tests render real frames; give them time on a busy machine.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120_000 },
});
