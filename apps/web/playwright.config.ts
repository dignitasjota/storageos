import { defineConfig, devices } from '@playwright/test';

/**
 * Configuración Playwright para los smoke tests del frontend.
 *
 * - `fullyParallel: false` + `workers: 1`: los tests comparten la misma BD
 *   real (Postgres dev) y crean tenants únicos por suite. Serializamos para
 *   evitar interferencias y race conditions entre suites.
 * - No usamos `webServer`: asumimos que `pnpm dev` corre aparte (en otra
 *   terminal o en CI). Esto agiliza el ciclo dev y evita el coste de un
 *   build cada vez.
 * - Trace + video + screenshot solo en fallo para minimizar I/O.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // webServer omitido a propósito: el usuario lanza `pnpm -F web dev` aparte.
  // Si se quiere en CI, descomentar y ajustar:
  // webServer: { command: 'pnpm dev', port: 3000, reuseExistingServer: true, timeout: 120_000 },
});
