/**
 * Smoke test 12: Locales en un navegador real.
 *
 * Borrar dice qué falta y, sin nada pendiente, borra; la dirección pública
 * ocupada propone otra; la ficha de un local que no existe lo dice; y una
 * pestaña desconocida no deja la página en blanco. El resumen, el horario
 * partido, la comparación, la papelera y el cartel funcionan en la ficha.
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

test('locales: borrar, dirección pública y ficha', async ({ page }) => {
  test.setTimeout(60_000);
  const tenant = await seedTestTenant('locales');
  const { accessToken: token } = await apiLogin(tenant.slug, tenant.email, tenant.password);
  const facility = await api<{ id: string }>('/facilities', token, {
    name: 'Local Smoke',
    city: 'Madrid',
    country: 'ES',
    timezone: 'Europe/Madrid',
  });
  await api('/facilities', token, { name: 'Local Libre', publicSlug: 'libre', country: 'ES' });
  const type = await api<{ id: string }>('/unit-types', token, {
    name: 'Mediano',
    defaultPriceMonthly: 50,
    color: '#3366ff',
  });
  const unit = await api<{ id: string }>('/units', token, {
    facilityId: facility.id,
    unitTypeId: type.id,
    code: 'A-1',
    widthM: 2,
    depthM: 3,
    heightM: 2.5,
  });
  const customer = await api<{ id: string }>('/customers', token, {
    customerType: 'individual',
    firstName: 'Ana',
    lastName: 'Lopez',
    email: `ana-${tenant.slug}@e2e.local`,
    country: 'ES',
  });
  await api('/contracts', token, {
    customerId: customer.id,
    unitId: unit.id,
    startDate: '2026-01-01',
    priceMonthly: 50,
  });

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

  // Un local con un contrato a medias no se borra: dice qué falta.
  await page.goto('/facilities');
  const card = (name: string) =>
    page.locator('div.group').filter({ has: page.getByRole('link', { name, exact: true }) });
  await card('Local Smoke').getByRole('button', { name: 'Acciones' }).click();
  await page.getByRole('menuitem', { name: 'Borrar' }).click();
  await expect(page.getByText('Aún no se puede borrar «Local Smoke»')).toBeVisible();
  await expect(page.getByText('1 contrato sin firmar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Borrar el local' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar', exact: true }).first().click();

  // Sin nada pendiente, sí.
  await card('Local Libre').getByRole('button', { name: 'Acciones' }).click();
  await page.getByRole('menuitem', { name: 'Borrar' }).click();
  await page.getByRole('button', { name: 'Borrar el local' }).click();
  await expect(page.getByRole('link', { name: 'Local Libre', exact: true })).toHaveCount(0);
  await requests.idle();

  // Dirección ocupada por una página de la web: propone otra.
  await page.goto(`/facilities/${facility.id}?tab=settings`);
  const slug = page.locator('#slug');
  await slug.fill('blog');
  await slug.locator('xpath=ancestor::div[2]').getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('button', { name: 'Usar «blog-2»' }).click();
  await expect(slug).toHaveValue('blog-2');
  await requests.idle();

  // Una pestaña que no existe enseña la primera.
  await page.goto(`/facilities/${facility.id}?tab=inventada`);
  await expect(page.getByRole('tab', { name: 'Resumen' })).toHaveAttribute('data-state', 'active');
  await requests.idle();

  // Un local que no existe lo dice, en vez de quedarse cargando.
  await page.goto('/facilities/0190e4a0-0000-7000-8000-000000000000');
  await expect(page.getByText('Este local no existe o no tienes acceso a él.')).toBeVisible();

  await requests.idle();

  expect(errors).toEqual([]);
});

test('locales: resumen, horario partido, comparar, papelera y cartel', async ({ page }) => {
  test.setTimeout(60_000);
  const tenant = await seedTestTenant('localesb');
  const { accessToken: token } = await apiLogin(tenant.slug, tenant.email, tenant.password);
  const facility = await api<{ id: string }>('/facilities', token, {
    name: 'Local Mejoras',
    city: 'Sevilla',
    country: 'ES',
    timezone: 'Europe/Madrid',
  });
  const type = await api<{ id: string }>('/unit-types', token, {
    name: 'Pequeño',
    defaultPriceMonthly: 40,
    color: '#3366ff',
  });
  await api('/units', token, {
    facilityId: facility.id,
    unitTypeId: type.id,
    code: 'B-1',
    widthM: 2,
    depthM: 2,
    heightM: 2.5,
    basePriceMonthly: 35,
  });

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

  // El resumen es lo primero que se ve, y dice lo que le falta a la ficha.
  await page.goto(`/facilities/${facility.id}`);
  await expect(page.getByText('Ocupación por tamaño')).toBeVisible();
  await expect(page.getByText(/Ficha al \d+%/)).toBeVisible();
  await requests.idle();

  // Aplicar el precio del tipo a sus trasteros enseña antes qué cambia.
  await page.getByRole('tab', { name: 'Tipos' }).click();
  await page.getByRole('button', { name: 'Acciones' }).click();
  await page.getByRole('menuitem', { name: 'Aplicar su precio en este local' }).click();
  await expect(page.getByText(/Cambia\s+1\s+de 1 trastero/)).toBeVisible();
  await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(page.getByText('Precio aplicado a 1 trastero.')).toBeVisible();
  await requests.idle();

  // Horario partido, copiado a toda la semana.
  await page.getByRole('tab', { name: 'Ajustes' }).click();
  const hours = page.locator('div.rounded-xl.border', { hasText: 'Horario de apertura' });
  await hours.getByLabel('Lunes').check();
  await hours.getByRole('button', { name: 'Turno de tarde' }).first().click();
  await hours.getByRole('button', { name: 'Copiar a toda la semana' }).first().click();
  await hours.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('Horario actualizado.')).toBeVisible();
  await requests.idle();
  const saved = await fetch(`${API_URL}/facilities/${facility.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await saved.json()) as {
    openingHours: { sun?: { open2?: string; close2?: string } };
  };
  expect(body.openingHours.sun).toMatchObject({ open2: '16:00', close2: '20:00' });

  // El cartel lleva el QR de su página.
  await page.goto(`/facilities/${facility.id}/poster`);
  await expect(page.getByRole('heading', { name: 'Cartel con QR' })).toBeVisible();
  await expect(page.getByText('Reserva tu trastero').first()).toBeVisible();
  await requests.idle();

  // Comparar en tabla.
  await page.goto('/facilities');
  await page.getByRole('button', { name: 'Comparar en tabla' }).click();
  await expect(page.getByRole('columnheader', { name: /Ocupación/ })).toBeVisible();
  await page.getByRole('button', { name: 'Ver en tarjetas' }).click();

  // Borrar y recuperar.
  const card = page
    .locator('div.group')
    .filter({ has: page.getByRole('link', { name: 'Local Mejoras', exact: true }) });
  await card.getByRole('button', { name: 'Acciones' }).click();
  await page.getByRole('menuitem', { name: 'Borrar' }).click();
  await page.getByRole('button', { name: 'Borrar el local' }).click();
  await expect(page.getByRole('link', { name: 'Local Mejoras', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Borrados' }).click();
  await expect(page.getByText('Local Mejoras')).toBeVisible();
  await page.getByRole('button', { name: 'Restaurar' }).click();
  await page.getByRole('button', { name: 'Restaurar' }).last().click();
  await expect(page.getByText('No hay locales borrados.')).toBeVisible();
  await requests.idle();

  expect(errors).toEqual([]);
});

test('locales: los días especiales se leen en el idioma de la web', async ({ page }) => {
  test.setTimeout(30_000);
  const tenant = await seedTestTenant('localesen');
  const { accessToken: token } = await apiLogin(tenant.slug, tenant.email, tenant.password);
  const day = new Date(Date.now() + 5 * 86_400_000);
  const facility = await api<{ publicSlug: string }>('/facilities', token, {
    name: 'Local Festivos',
    city: 'Valencia',
    country: 'ES',
    timezone: 'Europe/Madrid',
    openingHours: { mon: { open: '09:00', close: '20:00' } },
    openingExceptions: [
      { date: day.toISOString().slice(0, 10), label: 'Fiesta local', hours: null },
    ],
  });
  const special = (locale: string) =>
    page.locator('li', {
      hasText: `${day.toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })} (Fiesta local)`,
    });

  await page.goto(`/s/${tenant.slug}/${facility.publicSlug}`);
  await expect(special('es-ES').first()).toBeAttached();
  await page.goto(`/s/${tenant.slug}/l/en/${facility.publicSlug}`);
  await expect(special('en-GB').first()).toBeAttached();
});
