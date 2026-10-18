/**
 * Smoke test 9: panel del tenant con un local grande.
 *
 * El API pagina los trasteros (50 por defecto): la web debe pedir todas las
 * páginas o los listados, el plano y los selectores se quedan en los 50
 * primeros. Se crean 60 trasteros y se comprueba que el alta de contrato los
 * ofrece todos y que rellena la fianza del tipo de trastero.
 */
import { expect, test } from '@playwright/test';

import { API_URL, apiCreateCustomer, apiLogin, seedTestTenant } from './helpers';

const UNITS = 60;

async function api<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

test.describe('Panel del tenant', () => {
  test('el alta de contrato ofrece los 60 trasteros y la fianza del tipo', async ({ page }) => {
    test.setTimeout(120_000);
    const tenant = await seedTestTenant('panel');
    const { accessToken: token } = await apiLogin(tenant.slug, tenant.email, tenant.password);
    const facility = await api<{ id: string }>('/facilities', token, {
      name: 'Local Grande',
      city: 'Madrid',
      country: 'ES',
      timezone: 'Europe/Madrid',
    });
    const type = await api<{ id: string }>('/unit-types', token, {
      name: 'Pequeño',
      defaultPriceMonthly: 40,
      defaultDepositAmount: 45,
      color: '#3366ff',
    });
    for (let i = 1; i <= UNITS; i++) {
      await api('/units', token, {
        facilityId: facility.id,
        unitTypeId: type.id,
        code: `P${String(i).padStart(3, '0')}`,
        widthM: 1,
        depthM: 2,
        heightM: 2.5,
        basePriceMonthly: 40,
      });
    }
    await apiCreateCustomer(token, { firstName: 'Panel', lastName: 'Tester' });

    await page.goto('/login');
    // Rellenar antes de que React hidrate el formulario lo deja vacío.
    await page.waitForLoadState('networkidle');
    await page.getByLabel(/Empresa/i).fill(tenant.slug);
    await page.getByLabel(/^Email$/i).fill(tenant.email);
    await page.getByLabel(/Contraseña/i).fill(tenant.password);
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    await page.goto('/contracts/new');
    await page.getByText('Panel Tester').first().click();
    // Paso 2: los 60 trasteros (antes, solo los 50 primeros).
    await expect(page.getByText('P060')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('li', { hasText: /^P\d{3}/ })).toHaveCount(UNITS);

    // Paso 3: la fianza sale la del tipo de trastero.
    await page.getByText('P060').click();
    await expect(page.getByText('Paso 3 · Fechas y precio')).toBeVisible();
    const deposit = page.locator('label', { hasText: 'Fianza (€)' }).locator('..').locator('input');
    await expect(deposit).toHaveValue('45');
  });
});
