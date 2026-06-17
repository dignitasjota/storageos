/**
 * Smoke test 4: super admin login (con 2FA opcional) + impersonación.
 *
 * Requiere un super admin precreado. El seed `seed:superadmin` NO crea
 * 2FA por defecto, así que este test soporta ambos modos:
 *
 *   - `E2E_ADMIN_TOTP_SECRET` definido: hacemos el reto 2FA después del login.
 *   - Sin secret: asumimos que el super admin no tiene 2FA activo.
 *
 * Variables de entorno:
 *   - `E2E_ADMIN_EMAIL`     (default `admin@storageos.local`)
 *   - `E2E_ADMIN_PASSWORD`  (default `Admin69!`)
 *   - `E2E_ADMIN_TOTP_SECRET` (opcional, base32)
 *
 * Para preparar el super admin:
 *   pnpm --filter @storageos/database seed:superadmin -- \
 *     --email admin@storageos.local --password 'Admin69!' --name 'Admin E2E'
 */
import { expect, test } from '@playwright/test';

import { generateTotpCode, seedTestTenant } from './helpers';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@storageos.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Admin69!';
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET;

test.describe('Super admin + impersonación', () => {
  test('login admin + lista tenants + abrir dialog impersonate', async ({ page }) => {
    // Aseguramos que existe al menos un tenant que poder impersonar.
    const tenant = await seedTestTenant('imp');

    // Login admin
    await page.goto('/admin/login');
    await page.getByLabel(/^Email$/i).fill(ADMIN_EMAIL);
    await page.getByLabel(/Contraseña/i).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();

    // Reto 2FA si está configurado
    if (ADMIN_TOTP_SECRET) {
      const code = generateTotpCode(ADMIN_TOTP_SECRET);
      await page.getByLabel(/Código de 6 dígitos/i).fill(code);
      await page.getByRole('button', { name: /Verificar/i }).click();
    }

    // Dashboard admin: /admin/metrics
    await expect(page).toHaveURL(/\/admin\/(metrics|tenants)/, { timeout: 15_000 });

    // Navegación DENTRO de la SPA (clic en el nav), no `page.goto`: una recarga
    // dura pierde el token admin en memoria y el bootstrap redirige a
    // /admin/login. El endpoint de tenants no está capado y ordena por
    // createdAt desc, así que el tenant recién creado sale el primero.
    await page.getByRole('link', { name: 'Tenants' }).click();
    await expect(page).toHaveURL(/\/admin\/tenants$/, { timeout: 10_000 });
    const tenantCard = page.locator('button', { hasText: tenant.slug });
    await expect(tenantCard.first()).toBeVisible({ timeout: 10_000 });
    await tenantCard.first().click();

    // Botón "Impersonar"
    await expect(page).toHaveURL(/\/admin\/tenants\/[a-f0-9-]+/);
    const impBtn = page.getByRole('button', { name: /Impersonar/i }).first();
    await expect(impBtn).toBeVisible({ timeout: 10_000 });
    await impBtn.click();

    // Modal con campo motivo
    await expect(page.getByRole('heading', { name: /Impersonar tenant/i })).toBeVisible();
    await page.getByPlaceholder(/Investigación|Investigacion/i).fill('Smoke test impersonación');

    // El submit abre nueva pestaña con window.open: capturamos el popup.
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: /Iniciar impersonación/i }).click();
    const popup = await popupPromise;
    // El popup hace window.open('/dashboard'). La consumición del token de
    // impersonación (desde localStorage) NO está cubierta por este smoke, así
    // que el guard del panel puede redirigir a /login?next=%2Fdashboard antes
    // de que se establezca la sesión. Nos basta con verificar que el popup se
    // abrió apuntando al dashboard (ruta directa o vía el parámetro `next`).
    expect(popup.url()).toMatch(/dashboard/i);
  });
});
