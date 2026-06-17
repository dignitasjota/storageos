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
  // En CI (gate bloqueante) reintentamos para absorber flakes puntuales de
  // red/timing sin dejar pasar fallos reales; en local, 0 para feedback rápido.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // Evita que un `test.only` olvidado deje el gate verde habiendo ejecutado
  // solo un test.
  forbidOnly: !!process.env.CI,
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
