import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('SEO técnico (Search Console + GA4) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('por defecto ambos campos son null; se pueden fijar y borrar', async () => {
    const owner = await registerVerifiedUser(app, 'seo-tech-branding');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const before = await request(app.getHttpServer()).get('/settings/tenant/branding').set(auth);
    expect(before.status).toBe(200);
    expect(before.body.googleSiteVerification).toBeNull();
    expect(before.body.googleAnalyticsId).toBeNull();

    // Formato inválido de GA4 -> 400.
    const invalid = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ googleAnalyticsId: 'no-es-un-id' });
    expect(invalid.status).toBe(400);

    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ googleSiteVerification: 'abc123verificationtoken', googleAnalyticsId: 'G-TEST1234' });
    expect(patch.status).toBe(200);
    expect(patch.body.googleSiteVerification).toBe('abc123verificationtoken');
    expect(patch.body.googleAnalyticsId).toBe('G-TEST1234');

    // Borrar con ''.
    const cleared = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ googleSiteVerification: '', googleAnalyticsId: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.googleSiteVerification).toBeNull();
    expect(cleared.body.googleAnalyticsId).toBeNull();
  });

  it('se reflejan en la landing pública y en la página del local', async () => {
    const owner = await registerVerifiedUser(app, 'seo-tech-public');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local SEO',
      unitsCount: 1,
      pricePerUnit: 60,
    });

    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ googleSiteVerification: 'search-console-token', googleAnalyticsId: 'G-ABCDE12345' })
      .expect(200);

    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.body.googleSiteVerification).toBe('search-console-token');
    expect(landing.body.googleAnalyticsId).toBe('G-ABCDE12345');

    const facility = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/local-seo`,
    );
    expect(facility.body.googleAnalyticsId).toBe('G-ABCDE12345');
  });

  it('se refleja en el listado del blog (web_premium)', async () => {
    const owner = await registerVerifiedUser(app, 'seo-tech-blog');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ googleAnalyticsId: 'G-BLOGID1234' })
      .expect(200);

    const list = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}/blog`);
    expect(list.status).toBe(200);
    expect(list.body.googleAnalyticsId).toBe('G-BLOGID1234');
  });
});
