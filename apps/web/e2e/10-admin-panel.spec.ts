/**
 * Smoke test 10: panel del super admin — las confirmaciones usan el diálogo
 * propio (no `window.confirm`) y la fecha por defecto de un seguimiento es la
 * local.
 */
import { expect, test } from '@playwright/test';

import { generateTotpCode, seedTestTenant } from './helpers';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@storageos.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Admin69!';
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET;

test('borrar un seguimiento del tenant pide confirmación en un diálogo', async ({ page }) => {
  const tenant = await seedTestTenant('admpanel');
  // Si quedara algún `window.confirm`, el test lo detectaría aquí.
  page.on('dialog', (d) => {
    throw new Error(`Diálogo nativo inesperado: ${d.message()}`);
  });

  await page.goto('/admin/login');
  await page.getByLabel(/^Email$/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/Contraseña/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  if (ADMIN_TOTP_SECRET) {
    await page.getByLabel(/Código de 6 dígitos/i).fill(generateTotpCode(ADMIN_TOTP_SECRET));
    await page.getByRole('button', { name: /Verificar/i }).click();
  }
  await expect(page).toHaveURL(/\/admin\/(metrics|tenants|today)/, { timeout: 15_000 });

  const tenantsLink = page.getByRole('link', { name: 'Tenants', exact: true });
  if (!(await tenantsLink.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Tenants' }).click();
  }
  await tenantsLink.click();
  await page.locator('button', { hasText: tenant.slug }).first().click();
  await expect(page).toHaveURL(/\/admin\/tenants\/[a-f0-9-]+/);

  await page.getByRole('tab', { name: 'Seguimientos' }).click();
  const now = new Date();
  now.setDate(now.getDate() + 7);
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await expect(page.locator('input[type="date"]').first()).toHaveValue(expected);

  await page.getByPlaceholder(/Recordatorio/).fill('Llamar para renovar');
  await page.getByRole('button', { name: /Añadir recordatorio/ }).click();
  await expect(page.getByText('Llamar para renovar')).toBeVisible();

  await page.getByRole('button', { name: 'Borrar' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('¿Borrar este seguimiento?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByText('Llamar para renovar')).toBeVisible();

  await page.getByRole('button', { name: 'Borrar' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Llamar para renovar')).toHaveCount(0);
});
