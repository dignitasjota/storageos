import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { SocialSettingsDto } from '@storageos/shared';

// Meta va simulada (NODE_ENV=test): un token `invalid…` falla y uno `multi…`
// da acceso a dos páginas.
describe('Instagram y Facebook orgánico (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  it('conecta la página con su Instagram y descarga métricas y publicaciones', async () => {
    const owner = await registerVerifiedUser(app, 'social');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin Web Premium no está disponible.
    await http().get('/marketing/social').set(auth).expect(403);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const empty = await http().get('/marketing/social').set(auth).expect(200);
    expect(empty.body).toMatchObject({ connected: false, pageName: null });

    const bad = await http()
      .put('/marketing/social')
      .set(auth)
      .send({ accessToken: 'invalid-token-0000000000000' })
      .expect(400);
    expect(bad.body.code).toBe('social_token_invalid');
    expect(bad.body.message).toContain('caducado');

    // Varias páginas: hay que elegir una.
    const choose = await http()
      .put('/marketing/social')
      .set(auth)
      .send({ accessToken: 'multi-token-000000000000000' })
      .expect(400);
    expect(choose.body.code).toBe('social_choose_page');
    expect(choose.body.details.pages).toEqual([
      { id: '100200300', name: 'Trasteros Centro', instagramUsername: 'trasteros_centro' },
      { id: '100200301', name: 'Trasteros Norte', instagramUsername: null },
    ]);
    const north = await http()
      .put('/marketing/social')
      .set(auth)
      .send({ accessToken: 'multi-token-000000000000000', pageId: '100200301' })
      .expect(200);
    expect(north.body).toMatchObject({
      connected: true,
      status: 'connected',
      pageName: 'Trasteros Norte',
      instagramUsername: null,
    });

    const admin = app.get(PrismaAdminService);
    const tenantId = (await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } })).id;
    const count = async (network: string) =>
      admin.socialDailyMetric.count({ where: { tenantId, network } });
    // Página sin Instagram: solo Facebook, los 30 últimos días.
    expect(await count('facebook')).toBe(30);
    expect(await count('instagram')).toBe(0);

    // Otra página: lo de la anterior se borra y llega su Instagram.
    const demo = await http()
      .put('/marketing/social')
      .set(auth)
      .send({ accessToken: 'page-token-0000000000000000' })
      .expect(200);
    const settings = demo.body as SocialSettingsDto;
    expect(settings).toMatchObject({
      pageName: 'Trasteros Demo',
      instagramUsername: 'trasteros_demo',
    });
    expect(settings.lastSyncedAt).not.toBeNull();
    expect(await count('instagram')).toBe(30);
    const yesterday = await admin.socialDailyMetric.findFirstOrThrow({
      where: { tenantId, network: 'instagram' },
      orderBy: { date: 'desc' },
    });
    expect(yesterday.followers).toBe(1500);
    expect(yesterday.websiteClicks).not.toBeNull();
    const posts = await admin.socialPost.count({ where: { tenantId } });
    expect(posts).toBe(8);

    // El token se guarda cifrado.
    const account = await admin.tenantSocialAccount.findUniqueOrThrow({ where: { tenantId } });
    expect(account.accessTokenEncrypted).not.toContain('page-token');

    // Volver a descargar no duplica nada ni borra los seguidores de otro día.
    await http().post('/marketing/social/sync').set(auth).expect(201);
    expect(await count('instagram')).toBe(30);
    expect(await admin.socialPost.count({ where: { tenantId } })).toBe(8);
    const again = await admin.socialDailyMetric.findUniqueOrThrow({ where: { id: yesterday.id } });
    expect(again.followers).toBe(1500);

    const off = await http().delete('/marketing/social').set(auth).expect(200);
    expect(off.body.connected).toBe(false);
    expect(await admin.socialDailyMetric.count({ where: { tenantId } })).toBe(0);
    expect(await admin.socialPost.count({ where: { tenantId } })).toBe(0);

    await http().get('/marketing/social').expect(401);
  });
});
