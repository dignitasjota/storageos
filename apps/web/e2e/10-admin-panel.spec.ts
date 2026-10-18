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
  // El CSV recorre todos los tenants del filtro.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Exportar CSV/ }).click();
  expect((await download).suggestedFilename()).toBe('tenants.csv');

  // Acción masiva: seleccionar y etiquetar.
  await page
    .getByRole('checkbox', { name: new RegExp(`Seleccionar E2E admpanel`) })
    .first()
    .check();
  await expect(page.getByText('1 seleccionado(s)')).toBeVisible();
  await page.getByRole('button', { name: 'Etiquetar' }).click();
  await page.getByLabel('Añadir').fill('piloto');
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText(/Etiquetas actualizadas en 1 tenant/)).toBeVisible();
  await page.getByRole('button', { name: /Quitar selección/ }).click();

  await page.locator('button', { hasText: tenant.slug }).first().click();
  await expect(page).toHaveURL(/\/admin\/tenants\/[a-f0-9-]+/);
  await expect(page.getByText('Aporta al mes')).toBeVisible();

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

  // El historial junta el seguimiento creado (aunque ya se haya borrado no;
  // se crea otro para verlo) con el resto de eventos.
  await page.getByPlaceholder(/Recordatorio/).fill('Revisar el uso');
  await page.getByRole('button', { name: /Añadir recordatorio/ }).click();
  await page.getByRole('tab', { name: 'Historial' }).click();
  await expect(page.getByText('Seguimiento: Revisar el uso')).toBeVisible();
  await page.screenshot({ path: 'test-results/admin-timeline.png', fullPage: true });

  // La campana lleva a la página propia de notificaciones.
  await page.getByRole('link', { name: 'Notificaciones' }).click();
  await expect(page).toHaveURL(/\/admin\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notificaciones' })).toBeVisible();
});
