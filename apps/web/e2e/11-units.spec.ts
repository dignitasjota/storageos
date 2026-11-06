/**
 * Smoke test 11: Trasteros en un navegador real.
 *
 * Lista en orden natural (A-2 antes que A-10), filtro por las tiras de estado,
 * ficha, edición, cambio de estado y plano, sin errores de página.
 */
import { expect, test } from '@playwright/test';

import { API_URL, apiLogin, seedTestTenant, trackRequests } from './helpers';

async function api<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

test('trasteros: lista, ficha, edición, estado y plano', async ({ page }) => {
  test.setTimeout(60_000);
  const tenant = await seedTestTenant('units');
  const { accessToken: token } = await apiLogin(tenant.slug, tenant.email, tenant.password);
  const facility = await api<{ id: string }>('/facilities', token, {
    name: 'Local Smoke',
    city: 'Madrid',
    country: 'ES',
    timezone: 'Europe/Madrid',
  });
  const type = await api<{ id: string }>('/unit-types', token, {
    name: 'Mediano',
    defaultPriceMonthly: 50,
    color: '#3366ff',
  });
  const unit = (code: string) =>
    api<{ id: string }>('/units', token, {
      facilityId: facility.id,
      unitTypeId: type.id,
      code,
      widthM: 2,
      depthM: 3,
      heightM: 2.5,
    });
  await unit('A-10');
  const second = await unit('A-2');

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requests = trackRequests(page);
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.getByLabel(/Empresa/i).fill(tenant.slug);
  await page.getByLabel(/^Email$/i).fill(tenant.email);
  await page.getByLabel(/Contraseña/i).fill(tenant.password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

  await page.goto('/units');
  const codes = page.getByRole('link', { name: /^A-\d+$/ });
  await expect(codes).toHaveCount(2);
  await expect(codes.first()).toHaveText('A-2');
  // Los filtros se aplican sobre la lista cargada.
  await page.getByRole('button', { name: 'Fuera de servicio' }).click();
  await expect(codes).toHaveCount(0);
  await page.getByRole('button', { name: 'Fuera de servicio' }).click();
  await expect(codes).toHaveCount(2);

  // Ficha: se edita el precio y se pasa a mantenimiento.
  await page.goto(`/units/${second.id}`);
  await expect(page.getByRole('heading', { name: 'A-2' })).toBeVisible();
  await page.getByRole('button', { name: /Editar trastero/i }).click();
  await page.getByLabel(/Precio mensual sin IVA/i).fill('65');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('Trastero actualizado.')).toBeVisible();
  await requests.idle();

  await page.getByRole('button', { name: 'Cambiar estado' }).click();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Mantenimiento' }).click();
  await page.getByLabel(/Qué hay que hacer/i).fill('Cambiar la cerradura');
  await page.getByRole('button', { name: 'Cambiar', exact: true }).click();
  await expect(page.getByText(/En mantenimiento|Estado actualizado/)).toBeVisible();
  await expect(page.getByText('Cambiar la cerradura').first()).toBeVisible();
  await requests.idle();

  // Etiqueta de puerta con su QR.
  await page.goto(`/units/labels?id=${second.id}`);
  await expect(page.locator('.unit-label').getByText('A-2', { exact: true })).toBeVisible();
  await expect(page.locator('.unit-label svg')).toBeVisible();

  // Un trastero que no existe no se queda cargando.
  await page.goto('/units/01a1ae29-0000-7000-8000-000000000000');
  await expect(page.getByText('Este trastero no existe o ya no está.')).toBeVisible();

  // Plano del local.
  await page.goto('/units');
  await page.getByRole('button', { name: 'Plano' }).click();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Buscar en el plano').fill('A-10');
  await page.getByRole('combobox', { name: 'Color' }).click();
  await page.getByRole('option', { name: 'Color por días libre' }).click();
  await expect(page.getByText('Menos de 30 días')).toBeVisible();
  await requests.idle();

  expect(errors).toEqual([]);
});
