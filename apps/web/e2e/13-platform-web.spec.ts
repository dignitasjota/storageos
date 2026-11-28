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

  test('una funcionalidad que no existe da 404 en español con enlace a la portada', async ({
    page,
  }) => {
    const res = await page.goto('/funcionalidades/no-existe');
    expect(res?.status()).toBe(404);
    await expect(page.getByText('Esta página no existe')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a la portada' })).toHaveAttribute('href', '/');
  });

  test('el menú de la cabecera está en el HTML inicial (sin abrirlo)', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain('/funcionalidades/facturacion-veri-factu');
    expect(html).toContain('/soluciones/administradores-de-trasteros');
  });

  test('las páginas interiores declaran imagen para redes y su propia url', async ({ page }) => {
    await page.goto('/terminos');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /\/terminos$/);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      /\/opengraph-image/,
    );
  });

  test('con «Solo necesarias» no se guarda de dónde viene la visita', async ({ page }) => {
    await page.addInitScript(() =>
      window.localStorage.setItem('storageos.cookie-consent', 'necessary'),
    );
    await page.goto('/precios?utm_source=test&utm_medium=cpc');
    const rechazado = await page.evaluate(() =>
      window.localStorage.getItem('storageos.attribution._platform'),
    );
    expect(rechazado).toBeNull();
  });

  test('con «Aceptar todas» sí se guarda el origen', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('storageos.cookie-consent', 'all'));
    await page.goto('/precios?utm_source=test&utm_medium=cpc');
    const aceptado = await page.evaluate(() =>
      window.localStorage.getItem('storageos.attribution._platform'),
    );
    expect(aceptado).not.toBeNull();
  });
});
