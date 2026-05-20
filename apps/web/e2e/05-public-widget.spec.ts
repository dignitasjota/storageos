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

import { seedTestTenant } from './helpers';

test.describe('Widget público de leads', () => {
  test('renderiza form y acepta envío de lead', async ({ page }) => {
    const tenant = await seedTestTenant('wid');

    // Sin login: visitamos el widget directamente.
    await page.goto(`/widget/${tenant.slug}`);

    // Form visible (espera explícita porque facilities se cargan async).
    await expect(page.getByRole('heading', { name: /Reservar trastero/i })).toBeVisible({
      timeout: 10_000,
    });

    // Rellenar campos obligatorios. Localizamos los inputs por id porque
    // el label incluye un asterisco que no es estable como selector.
    await page.locator('#firstName').fill('Smoke');
    await page.locator('#lastName').fill('Tester');
    await page.locator('#email').fill('smoke-widget@e2e.local');
    await page.locator('#phone').fill('+34600000000');
    await page.locator('#message').fill('Interesado vía smoke test');

    await page.getByRole('button', { name: /Enviar solicitud/i }).click();

    // Pantalla de éxito
    await expect(page.getByRole('heading', { name: /¡Gracias!/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/contactaremos/i)).toBeVisible();
  });
});
