import { expect, test } from '@playwright/test';

/**
 * Web de TrasterOS (trasteros.pro): las páginas para Google cargan sin errores,
 * con un solo H1, su canónica y sus datos estructurados.
 */
const PAGES: { path: string; h1: RegExp }[] = [
  { path: '/', h1: /Software de gestión de trasteros/ },
  { path: '/precios', h1: /Precios del software de gestión de trasteros/ },
  { path: '/funcionalidades', h1: /Funcionalidades/ },
  { path: '/funcionalidades/facturacion-veri-factu', h1: /Veri\*Factu/ },
  { path: '/soluciones/administradores-de-trasteros', h1: /administradores de trasteros/ },
  { path: '/blog', h1: /Guías/ },
  { path: '/calculadora-rentabilidad-trasteros', h1: /Calculadora de rentabilidad/ },
];

test.describe('Web de TrasterOS', () => {
  for (const { path, h1 } of PAGES) {
    test(`${path} carga con su H1 y sus datos para Google`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(h1);
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
      const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
      expect(ld.length).toBeGreaterThan(0);
      for (const block of ld) expect(() => JSON.parse(block)).not.toThrow();
      expect(errors).toEqual([]);
    });
  }

  test('la calculadora recalcula al cambiar los datos', async ({ page }) => {
    await page.goto('/calculadora-rentabilidad-trasteros');
    await expect(page.getByText(/64 trasteros alquilados/)).toBeVisible();
    await page.getByLabel('Número de trasteros').fill('200');
    await expect(page.getByText(/64 trasteros alquilados/)).toBeVisible();
    await page.getByLabel('Precio medio al mes').fill('30');
    await expect(page.getByText(/127 trasteros alquilados/)).toBeVisible();
  });

  test('una funcionalidad que no existe da 404', async ({ page }) => {
    const res = await page.goto('/funcionalidades/no-existe');
    expect(res?.status()).toBe(404);
  });
});
