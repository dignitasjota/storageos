/**
 * Smoke test 8: la web pública del tenant renderiza con cada plantilla.
 *
 * Por cada plantilla de Web Premium se crea un tenant con un local y dos
 * trasteros, se le activa el extra (como super admin) y se abren su portada,
 * la ficha del local y la versión en inglés. Se comprueba que la página
 * responde 200, sin errores de JavaScript, con el nombre del negocio, un
 * precio y el enlace de reserva. Con la primera, además, el blog y una
 * landing de promoción.
 *
 * Es la red que faltaba: dos plantillas estuvieron dando 500 meses sin que
 * ningún test lo viera (los e2e del API no pintan la web).
 */
import { expect, test, type Page } from '@playwright/test';

import { API_URL, apiLogin, seedTestTenant } from './helpers';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@storageos.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Admin69!';

const TEMPLATES = [
  'default',
  'modern',
  'industrial',
  'onepage',
  'escaparate',
  'corporate',
  'onepagemovil',
  'trstrom',
  'cabe',
] as const;

async function api<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

let adminToken: string | null = null;
async function superAdminToken(): Promise<string> {
  if (adminToken) return adminToken;
  const res = await fetch(`${API_URL}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`/admin/auth/login → ${res.status}`);
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error('El super admin del smoke no debe tener 2FA');
  adminToken = body.accessToken;
  return adminToken;
}

interface WebTenant {
  slug: string;
  name: string;
  token: string;
  facilitySlug: string;
}

/** Tenant con Web Premium, la plantilla indicada, un local y dos trasteros. */
async function webTenant(template: string): Promise<WebTenant> {
  const tenant = await seedTestTenant(`web${template.slice(0, 4)}`);
  const { accessToken: token } = await apiLogin(tenant.slug, tenant.email, tenant.password);
  await api(`/admin/tenants/${tenant.tenantId}/features`, await superAdminToken(), {
    method: 'PUT',
    body: { overrides: [{ feature: 'web_premium', enabled: true }] },
  });
  const facility = await api<{ id: string; publicSlug: string }>('/facilities', token, {
    method: 'POST',
    body: {
      name: 'Local Centro',
      city: 'Valencia',
      address: 'Calle Mayor 1',
      country: 'ES',
      timezone: 'Europe/Madrid',
    },
  });
  const type = await api<{ id: string }>('/unit-types', token, {
    method: 'POST',
    body: { name: 'Mediano', defaultPriceMonthly: 50, color: '#3366ff' },
  });
  for (const code of ['A1', 'A2']) {
    await api('/units', token, {
      method: 'POST',
      body: {
        facilityId: facility.id,
        unitTypeId: type.id,
        code,
        widthM: 2,
        depthM: 3,
        heightM: 2.5,
        basePriceMonthly: 50,
      },
    });
  }
  await api('/settings/tenant/web', token, { method: 'PATCH', body: { template } });
  return {
    slug: tenant.slug,
    name: `E2E web${template.slice(0, 4)}`,
    token,
    facilitySlug: facility.publicSlug,
  };
}

/** Abre la página y comprueba que se pinta sin errores. */
async function openOk(page: Page, path: string): Promise<void> {
  const errors: string[] = [];
  const onError = (e: Error) => errors.push(e.message);
  page.on('pageerror', onError);
  const res = await page.goto(path);
  expect(res?.status(), `${path} responde 200`).toBe(200);
  await expect(page.locator('h1').first()).toBeVisible();
  await page.waitForLoadState('load');
  page.off('pageerror', onError);
  expect(errors, `${path} sin errores de JavaScript`).toEqual([]);
}

test.describe('Web pública del tenant', () => {
  for (const template of TEMPLATES) {
    test(`plantilla ${template}: portada, local e inglés`, async ({ page }) => {
      const t = await webTenant(template);

      await openOk(page, `/s/${t.slug}`);
      await expect(page.getByText(t.name).first()).toBeVisible();
      await expect(page.getByText(/€/).first()).toBeVisible();
      await expect(page.locator(`a[href*="/book/${t.slug}"]`).first()).toBeAttached();

      await openOk(page, `/s/${t.slug}/${t.facilitySlug}`);
      await expect(page.getByText('Local Centro').first()).toBeVisible();

      await openOk(page, `/s/${t.slug}/l/en`);
      await expect(page.locator(`a[href*="/book/${t.slug}/l/en"]`).first()).toBeAttached();

      if (template === 'default') {
        const post = await api<{ id: string; slug: string }>('/blog-posts', t.token, {
          method: 'POST',
          body: { title: 'Cómo organizar tu trastero', contentMarkdown: '## Por zonas\n\nTexto.' },
        });
        await api(`/blog-posts/${post.id}`, t.token, {
          method: 'PATCH',
          body: { isPublished: true },
        });
        await openOk(page, `/s/${t.slug}/blog`);
        await openOk(page, `/s/${t.slug}/blog/${post.slug}`);
        await expect(page.getByText('Por zonas').first()).toBeVisible();

        await api('/promo-landings', t.token, {
          method: 'POST',
          body: {
            name: 'Verano',
            slug: 'verano',
            headline: 'Un mes gratis este verano',
            isActive: true,
          },
        });
        await openOk(page, `/s/${t.slug}/promo/verano`);
        await expect(page.getByText('Un mes gratis este verano').first()).toBeVisible();
      }
    });
  }
});
