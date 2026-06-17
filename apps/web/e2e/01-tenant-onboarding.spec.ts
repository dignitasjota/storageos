/**
 * Smoke test 1: onboarding completo de un tenant nuevo.
 *
 * Cubre el flujo más crítico del producto: alguien llega a la landing,
 * crea cuenta, verifica el email, entra al panel y activa 2FA. Si esto se
 * rompe, no entra ni un cliente.
 *
 * Requisitos externos:
 *   - `pnpm dev` corriendo en :3000
 *   - API en :3001
 *   - Mailpit en :8026 (HTTP) / :1026 (SMTP)
 */
import { expect, test } from '@playwright/test';

import {
  clearMailpit,
  extractMailpitToken,
  generateTotpCode,
  uniqueIds,
  waitForEmail,
} from './helpers';

test.describe('Onboarding de tenant', () => {
  test('registro + verificación email + 2FA', async ({ page }) => {
    await clearMailpit();
    const { slug, email } = uniqueIds('onb');
    const password = 'Secret123';

    // 1. Registro vía UI
    await page.goto('/register');
    await page.getByLabel(/Nombre de la empresa/i).fill(`E2E ${slug}`);
    await page.getByLabel(/Subdominio/i).fill(slug);
    await page.getByLabel(/Tu nombre/i).fill('E2E Tester');
    await page.getByLabel(/^Email$/i).fill(email);
    await page.getByLabel(/Contraseña/i).fill(password);
    // El checkbox de acepto términos: lo localizamos por su label.
    await page.getByLabel(/Acepto los términos/i).check();
    await page.getByRole('button', { name: /^Crear cuenta$/i }).click();

    // Pantalla "Revisa tu correo"
    await expect(page).toHaveURL(/\/verify-email-sent/);
    await expect(page.getByText(/Revisa tu correo/i).first()).toBeVisible();

    // 2. Leer email de verificación y consumir token
    const mail = await waitForEmail(email, { subjectIncludes: 'Verifica' });
    const token = extractMailpitToken(mail.Text || mail.HTML, '/verify-email');
    await page.goto(`/verify-email/${token}`);
    // Tras verificar, el frontend redirige al dashboard.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // 3. Activar 2FA en /settings/security
    await page.goto('/settings/security');
    await page.getByRole('button', { name: /Activar 2FA/i }).click();

    // El secret base32 se muestra dentro del único <code> de la tarjeta de
    // setup; lo cogemos como el primero visible tras "Secreto".
    const secretLocator = page.locator('code').first();
    await expect(secretLocator).toBeVisible({ timeout: 10_000 });
    const secret = ((await secretLocator.textContent()) ?? '').replace(/\s+/g, '');
    expect(secret.length).toBeGreaterThanOrEqual(16);

    // Introducir el código TOTP actual y confirmar.
    const code = generateTotpCode(secret);
    await page.getByLabel(/^Código$/i).fill(code);
    await page.getByRole('button', { name: /^Confirmar$/i }).click();

    // Tras verificar, aparecen los recovery codes (paso 3). Usamos el título
    // del paso ("Guarda tus códigos de recuperación") para no chocar con el
    // texto del checkbox de confirmación, que también menciona "códigos de
    // recuperación" (strict mode violation si usamos el match genérico).
    await expect(page.getByText(/Guarda tus códigos de recuperación/i)).toBeVisible({
      timeout: 10_000,
    });

    // 4. Logout + login con TOTP
    // Cerrar la sesión vía cookie clear y volver al login (más estable que
    // depender del UserMenu, que es un dropdown asíncrono).
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel(/Empresa/i).fill(slug);
    await page.getByLabel(/^Email$/i).fill(email);
    await page.getByLabel(/Contraseña/i).fill(password);
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();

    // Reto 2FA: aparece input one-time-code
    const totpInput = page.locator('input[autocomplete="one-time-code"]');
    await expect(totpInput).toBeVisible({ timeout: 10_000 });
    await totpInput.fill(generateTotpCode(secret));
    await page.getByRole('button', { name: /Verificar|Continuar/i }).click();

    // Llegamos al dashboard.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  });
});
