/**
 * Smoke test 5: widget público de captación de leads.
 *
 * El widget vive en `/widget/[slug]` sin auth, está pensado para iframe.
 * Verifica:
 *   - Carga sin sesión.
 *   - Muestra el formulario de reserva.
 *   - Permite enviar un lead con datos válidos.
 *   - Tras enviar, muestra la pantalla de "¡Gracias!".
 *
 * Usamos un tenant fresco sembrado vía API para tener un slug válido.
 */
import { expect, test } from '@playwright/test';

import { API_URL, apiLogin, seedTestTenant } from './helpers';

async function api<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

test.describe('Widget público de leads', () => {
  test('renderiza form y acepta envío de lead', async ({ page }) => {
    const tenant = await seedTestTenant('wid');
    // Como la web, el widget solo se sirve si el negocio tiene algún local.
    const { accessToken: token } = await apiLogin(tenant.slug, tenant.email, tenant.password);
    const facility = await api<{ id: string }>('/facilities', token, {
      name: 'Local Widget',
      city: 'Valencia',
      country: 'ES',
      timezone: 'Europe/Madrid',
    });
    const type = await api<{ id: string }>('/unit-types', token, {
      name: 'Mediano',
      defaultPriceMonthly: 50,
      color: '#3366ff',
    });
    await api('/units', token, {
      facilityId: facility.id,
      unitTypeId: type.id,
      code: 'W-1',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 50,
    });

    // Sin login: visitamos el widget directamente.
    await page.goto(`/widget/${tenant.slug}`);

    // Form visible (espera explícita porque facilities se cargan async).
    // `CardTitle` de shadcn renderiza un <div>, no un heading: usamos getByText.
    await expect(page.getByText(/Trasteros disponibles/i)).toBeVisible({
      timeout: 10_000,
    });

    // Rellenar campos obligatorios. Localizamos los inputs por id porque
    // el label incluye un asterisco que no es estable como selector.
    await page.locator('#firstName').fill('Smoke');
    await page.locator('#lastName').fill('Tester');
    await page.locator('#email').fill('smoke-widget@e2e.local');
    await page.locator('#phone').fill('+34600000000');
    await page.locator('#message').fill('Interesado vía smoke test');

    // Consentimiento RGPD: el botón de envío está deshabilitado sin marcarlo.
    await page.locator('#acceptsTerms').click();

    await page.getByRole('button', { name: /Enviar solicitud/i }).click();

    // Pantalla de éxito (CardTitle = <div>, usamos getByText).
    await expect(page.getByText(/¡Gracias!/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/contactaremos/i)).toBeVisible();
  });
});
