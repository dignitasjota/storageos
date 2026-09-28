/**
 * Smoke del login del portal con CONTRASEÑA en navegador real + revocación
 * de sesiones desde el staff.
 *
 * Complementa al 06 (magic link): el login por contraseña guarda la sesión en
 * localStorage y redirige a `/portal/consume`; y cuando el staff cierra las
 * sesiones del portal («Cerrar sesiones del portal», `portal_session_version`)
 * la sesión guardada deja de valer → al recargar, el portal debe mostrar la
 * pantalla de volver a entrar en vez de un muro de errores.
 */
import { expect, test } from '@playwright/test';

import { API_URL, WEB_URL, apiCreateCustomer, apiLogin, seedTestTenant } from './helpers';

const PASSWORD = 'PortalE2e-2026!';

test('el inquilino entra con contraseña y, al revocar sus sesiones, vuelve al login', async ({
  page,
}) => {
  // --- Setup por API: tenant + inquilino con contraseña del portal ---
  const tenant = await seedTestTenant('portalpw');
  const { accessToken } = await apiLogin(tenant.slug, tenant.email, tenant.password);
  const email = `portalpw-${Date.now().toString(36)}@e2e.local`;
  const customer = await apiCreateCustomer(accessToken, { firstName: 'Ana', email });

  const linkRes = await fetch(`${API_URL}/customers/${customer.id}/portal-link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(linkRes.ok).toBeTruthy();
  const token = new URL(((await linkRes.json()) as { url: string }).url).searchParams.get('token');
  const consume = await fetch(`${API_URL}/portal/login/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  expect(consume.ok).toBeTruthy();
  const portalToken = ((await consume.json()) as { accessToken: string }).accessToken;
  const setPassword = await fetch(`${API_URL}/portal/me/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${portalToken}` },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(setPassword.ok).toBeTruthy();

  // --- Navegador: login con contraseña ---
  await page.goto(`${WEB_URL}/portal/login`);
  const acceptCookies = page.getByRole('button', { name: 'Aceptar' });
  if (await acceptCookies.isVisible().catch(() => false)) await acceptCookies.click();

  await page.getByRole('button', { name: 'Contraseña', exact: true }).click();
  await page.locator('input[autocomplete="organization"]').fill(tenant.slug);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();

  await expect(page).toHaveURL(/\/portal\/consume/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /Hola, Ana/ })).toBeVisible({
    timeout: 15_000,
  });

  // --- El staff cierra las sesiones del portal del inquilino ---
  const revoke = await fetch(`${API_URL}/customers/${customer.id}/portal-link/revoke-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(revoke.status).toBe(204);

  // La sesión guardada ya no vale: pantalla de volver a entrar, con enlace al login.
  await page.reload();
  await expect(page.getByText('Tu sesión ha caducado')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Pedir un enlace nuevo' })).toHaveAttribute(
    'href',
    '/portal/login',
  );
});
