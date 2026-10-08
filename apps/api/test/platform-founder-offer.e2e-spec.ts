import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgresql://storageos:storageos@localhost:5432/storageos?schema=public';

/** Oferta fundador de la web de TrasterOS: desactivada por defecto, editable por el admin. */
describe('Oferta fundador de la web (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    await cleanupSuperAdmins();
    prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await prisma.platformFounderOffer.deleteMany();
    await prisma.platformWebsite.deleteMany();
    app = await createTestApp();
    const admin = await seedSuperAdmin('founder');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await prisma.platformFounderOffer.deleteMany();
    await prisma.platformWebsite.deleteMany();
    await prisma.$disconnect();
    await app.close();
    await cleanupSuperAdmins();
  });

  it('no se muestra hasta activarla y luego sale con su texto', async () => {
    const http = () => request(app.getHttpServer());
    // Por defecto: la web no la muestra.
    const pub = await http().get('/platform-founder-offer').expect(200);
    expect(pub.body).toEqual({ offer: null });

    // El admin ve los textos por defecto, desactivada.
    const current = await http().get('/admin/platform/founder-offer').set(adminAuth).expect(200);
    expect(current.body).toMatchObject({ enabled: false, title: 'Oferta fundador' });

    const saved = await http()
      .put('/admin/platform/founder-offer')
      .set(adminAuth)
      .send({
        enabled: true,
        title: 'Oferta de lanzamiento',
        text: 'Los 10 primeros: −30 % el primer año.',
        setupStrike: '',
        setupText: '',
      })
      .expect(200);
    expect(saved.body.enabled).toBe(true);

    const after = await http().get('/platform-founder-offer').expect(200);
    expect(after.body.offer).toEqual({
      enabled: true,
      title: 'Oferta de lanzamiento',
      text: 'Los 10 primeros: −30 % el primer año.',
      setupStrike: '',
      setupText: '',
    });

    // Sin título o sin texto no se guarda; sin sesión de admin, nada.
    await http()
      .put('/admin/platform/founder-offer')
      .set(adminAuth)
      .send({ enabled: true, title: '', text: 'x', setupStrike: '', setupText: '' })
      .expect(400);
    await http()
      .put('/admin/platform/founder-offer')
      .send({ enabled: false, title: 'a', text: 'b', setupStrike: '', setupText: '' })
      .expect(401);
  });

  it('logo de la web: subir, guardar y volver al de la marca', async () => {
    const http = () => request(app.getHttpServer());
    expect((await http().get('/platform-website').expect(200)).body).toEqual({ logoUrl: null });

    const up = await http()
      .post('/admin/platform/website/logo-upload-url')
      .set(adminAuth)
      .send({ mimeType: 'image/png', sizeBytes: 2048 })
      .expect(200);
    expect(up.body.key).toMatch(/^platform\/logo\/.+\.png$/);
    expect(up.body.uploadUrl).toEqual(expect.any(String));
    // Sin SVG (puede llevar scripts).
    await http()
      .post('/admin/platform/website/logo-upload-url')
      .set(adminAuth)
      .send({ mimeType: 'image/svg+xml', sizeBytes: 2048 })
      .expect(400);

    const set = await http()
      .put('/admin/platform/website/logo')
      .set(adminAuth)
      .send({ key: up.body.key })
      .expect(200);
    expect(set.body.logoUrl).toContain(up.body.key);
    expect((await http().get('/platform-website').expect(200)).body.logoUrl).toContain(up.body.key);

    await http()
      .put('/admin/platform/website/logo')
      .set(adminAuth)
      .send({ key: 'tenant-x/otra-cosa.png' })
      .expect(400);
    await http().put('/admin/platform/website/logo').send({ key: null }).expect(401);
    const reset = await http()
      .put('/admin/platform/website/logo')
      .set(adminAuth)
      .send({ key: null })
      .expect(200);
    expect(reset.body.logoUrl).toBeNull();
  });
});
