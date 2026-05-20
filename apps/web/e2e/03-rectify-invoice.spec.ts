/**
 * Smoke test 3: rectificación de factura.
 *
 * El botón "Rectificar" solo aparece sobre facturas F1 en estados
 * `issued|paid|overdue`. Sembramos una factura emitida vía API, abrimos
 * `/invoices/[id]`, lanzamos el modal de rectificación y comprobamos que
 * tras enviarlo:
 *   - El frontend nos lleva a la nueva factura draft.
 *   - La nueva factura muestra el tipo "Rectificativa R1".
 */
import { expect, test } from '@playwright/test';

import { apiCreateCustomer, apiCreateDraftInvoice, apiLogin, seedTestTenant } from './helpers';

test.describe('Rectificación de factura', () => {
  test('emite una rectificativa R1 desde el modal', async ({ page }) => {
    const tenant = await seedTestTenant('rec');
    const { accessToken } = await apiLogin(tenant.slug, tenant.email, tenant.password);
    const customer = await apiCreateCustomer(accessToken);
    const invoice = await apiCreateDraftInvoice(accessToken, customer.id, {
      unitPrice: 200,
      description: 'Cuota original',
      issue: true,
    });
    expect(invoice.status).toBe('issued');

    // Login UI
    await page.goto('/login');
    await page.getByLabel(/Empresa/i).fill(tenant.slug);
    await page.getByLabel(/^Email$/i).fill(tenant.email);
    await page.getByLabel(/Contraseña/i).fill(tenant.password);
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // Detalle de la factura: el botón "Rectificar" debe estar visible.
    await page.goto(`/invoices/${invoice.id}`);
    const rectifyBtn = page.getByRole('button', { name: /Rectificar/i });
    await expect(rectifyBtn).toBeVisible({ timeout: 10_000 });
    await rectifyBtn.click();

    // Modal: tipo R1 ya es el default; rellenamos el motivo.
    await expect(page.getByText(/Emitir factura rectificativa/i)).toBeVisible();
    await page.getByPlaceholder(/NIF erroneo|equivocado/i).fill('Smoke test rectificación');

    // Cambiamos el unitPrice de la línea a -10 para reducir el importe.
    // El input numérico de "P. unit" es el tercero de cada fila; lo
    // localizamos por su atributo step="0.01" + valor inicial 200.
    const priceInput = page.locator('input[type="number"][step="0.01"]').first();
    await priceInput.fill('-10');

    await page.getByRole('button', { name: /Crear rectificativa/i }).click();

    // Redirige a la nueva factura. La URL cambia y vemos badge
    // "Rectificativa R1".
    await expect(page).toHaveURL(/\/invoices\/[a-f0-9-]+/, { timeout: 15_000 });
    await expect(page.getByText(/Rectificativa R1/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
