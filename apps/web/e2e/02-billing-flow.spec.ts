/**
 * Smoke test 2: flujo de facturación visible.
 *
 * El sub-bloque manda probar "crear customer, contract, invoice y ver
 * VerifactuBadge". El frontend actual NO tiene `/customers/new` ni
 * `/invoices/new` como rutas (la creación de customer vive en un dialog y
 * las facturas se generan desde contratos o vía API). Para un smoke test
 * práctico hacemos lo siguiente:
 *
 *   1. Sembramos un tenant verificado vía API.
 *   2. Creamos customer + factura draft + emitida vía API directa.
 *   3. Hacemos login por UI (sin 2FA, este tenant no la activa).
 *   4. Navegamos a `/customers` y comprobamos que el customer aparece.
 *   5. Navegamos a `/invoices/[id]` y comprobamos que el VerifactuBadge
 *      renderiza con el estado AEAT.
 *
 * Esto cubre: routing autenticado, fetch de datos via TanStack Query,
 * render del badge Verifactu y el listado de inquilinos. Si algo de eso
 * se rompe, lo detectamos.
 */
import { expect, test } from '@playwright/test';

import { apiCreateCustomer, apiCreateDraftInvoice, apiLogin, seedTestTenant } from './helpers';

test.describe('Flujo de facturación', () => {
  test('login + customer + invoice emitida + VerifactuBadge visible', async ({ page }) => {
    // 1. Seed tenant
    const tenant = await seedTestTenant('bill');
    const { accessToken } = await apiLogin(tenant.slug, tenant.email, tenant.password);

    // 2. Seed customer + factura emitida
    const customer = await apiCreateCustomer(accessToken, {
      firstName: 'Smoke',
      lastName: 'Tester',
    });
    const invoice = await apiCreateDraftInvoice(accessToken, customer.id, {
      unitPrice: 120,
      description: 'Cuota mes (smoke test)',
      issue: true,
    });
    expect(invoice.status).toBe('issued');
    expect(invoice.invoiceNumber).not.toBeNull();

    // 3. Login UI
    await page.goto('/login');
    await page.getByLabel(/Empresa/i).fill(tenant.slug);
    await page.getByLabel(/^Email$/i).fill(tenant.email);
    await page.getByLabel(/Contraseña/i).fill(tenant.password);
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // 4. /customers debe listar el customer recién creado
    await page.goto('/customers');
    await expect(page.getByRole('link', { name: 'Smoke Tester' })).toBeVisible({
      timeout: 10_000,
    });

    // 5. /invoices/[id] muestra VerifactuBadge (el badge AEAT no aparece en
    // draft pero sí en issued; en modo stub estará "Pendiente").
    await page.goto(`/invoices/${invoice.id}`);
    await expect(page.locator('text=AEAT').first()).toBeVisible({ timeout: 10_000 });
    // Tambien debe verse el numero de factura
    if (invoice.invoiceNumber) {
      await expect(page.locator(`text=${invoice.invoiceNumber}`).first()).toBeVisible();
    }
  });
});
