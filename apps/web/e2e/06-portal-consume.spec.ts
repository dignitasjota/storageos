/**
 * Smoke del flujo NAVEGADOR del portal del inquilino.
 *
 * Motivación (auditoría 2026-07): el portal autentica con un header manual
 * (`Authorization: Bearer <portalToken>` + `requiresAuth: false`) que NO pasa
 * por el auth store del staff. Un bug en `apiFetch` (se comía `options.headers`)
 * dejó el portal roto en producción sin que NINGÚN test lo viera, porque los
 * e2e del API usan supertest. Este smoke ejercita ese camino en un navegador
 * real: consumir el enlace → sesión → cargar facturas con el header manual.
 */
import { expect, test } from '@playwright/test';

import {
  API_URL,
  WEB_URL,
  apiCreateCustomer,
  apiCreateDraftInvoice,
  apiLogin,
  seedTestTenant,
} from './helpers';

test('el inquilino entra por magic link y ve sus facturas', async ({ page }) => {
  // --- Setup por API: tenant + inquilino + factura emitida ---
  const tenant = await seedTestTenant('portal');
  const { accessToken } = await apiLogin(tenant.slug, tenant.email, tenant.password);
  const customer = await apiCreateCustomer(accessToken, { firstName: 'Puri' });
  const invoice = await apiCreateDraftInvoice(accessToken, customer.id, {
    unitPrice: 60,
    description: 'Cuota trastero E2E',
    issue: true,
  });
  expect(invoice.status).toBe('issued');
  expect(invoice.invoiceNumber).toBeTruthy();

  // --- El staff genera el enlace de acceso al portal (single-use, TTL 7d) ---
  const linkRes = await fetch(`${API_URL}/customers/${customer.id}/portal-link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(linkRes.ok).toBeTruthy();
  const { url } = (await linkRes.json()) as { url: string };
  // El host del enlace depende de WEB_BASE_URL del API; usamos el token sobre
  // el WEB_URL del test para no depender de esa config.
  const token = new URL(url).searchParams.get('token');
  expect(token).toBeTruthy();

  // --- Navegador real: consumir el enlace ---
  await page.goto(`${WEB_URL}/portal/consume?token=${encodeURIComponent(token!)}`);

  // La sesión se abre (el POST /portal/login/consume no lleva auth)…
  await expect(page.getByRole('heading', { name: /Hola, Puri/ })).toBeVisible({
    timeout: 15_000,
  });

  // …y las llamadas /portal/me/* (header manual Authorization) NO deben dar
  // 401: la pestaña de inicio muestra el saldo pendiente de la factura.
  await expect(page.getByText('pendiente de pago')).toBeVisible({ timeout: 15_000 });

  // Cerrar el banner de cookies si tapa la navegación inferior/lateral.
  const acceptCookies = page.getByRole('button', { name: 'Aceptar' });
  if (await acceptCookies.isVisible().catch(() => false)) {
    await acceptCookies.click();
  }

  // Ir a Facturas (sidebar en desktop) y ver la factura emitida.
  await page.getByRole('button', { name: 'Facturas' }).first().click();
  await expect(page.getByText(invoice.invoiceNumber!)).toBeVisible({ timeout: 15_000 });

  // La recarga restaura la sesión desde localStorage (el enlace es single-use).
  await page.reload();
  await expect(page.getByRole('heading', { name: /Hola, Puri/ })).toBeVisible({
    timeout: 15_000,
  });
});
