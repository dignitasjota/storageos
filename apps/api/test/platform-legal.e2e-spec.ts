import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgresql://storageos:storageos@localhost:5432/storageos?schema=public';

async function resetLegalDocs(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    await prisma.platformLegalDocument.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Documentos legales editables por el super admin: el endpoint público sirve el
 * contenido por defecto hasta que el admin lo edita, y a partir de ahí sirve el
 * texto guardado.
 */
describe('Páginas legales de la plataforma (e2e)', () => {
  let app: INestApplication;
  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await resetLegalDocs();
    app = await createTestApp();
    const admin = await seedSuperAdmin('legal');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  it('sirve el contenido por defecto y luego el editado', async () => {
    // Público sin editar → contenido por defecto (updatedAt null).
    const pub = await request(app.getHttpServer()).get('/platform-legal/terms');
    expect(pub.status).toBe(200);
    expect(pub.body.slug).toBe('terms');
    expect(pub.body.updatedAt).toBeNull();
    expect(pub.body.content).toContain('Información del prestador');

    // Slug inválido → 400.
    await request(app.getHttpServer()).get('/platform-legal/aviso-legal').expect(400);

    // El slug `cookies` sí es válido (contenido por defecto).
    const cookies = await request(app.getHttpServer()).get('/platform-legal/cookies');
    expect(cookies.status).toBe(200);
    expect(cookies.body.content).toContain('cookies');

    // El admin edita los términos.
    const upd = await request(app.getHttpServer())
      .put('/admin/platform/legal/terms')
      .set(adminAuth)
      .send({ title: 'Términos actualizados', content: '# Nuevos términos\n\nTexto de prueba.' })
      .expect(200);
    expect(upd.body.updatedAt).not.toBeNull();

    // Público ahora ve el texto editado.
    const pub2 = await request(app.getHttpServer()).get('/platform-legal/terms');
    expect(pub2.body.title).toBe('Términos actualizados');
    expect(pub2.body.content).toContain('Nuevos términos');
    expect(pub2.body.updatedAt).not.toBeNull();

    // Privacidad sigue en el contenido por defecto (independiente).
    const priv = await request(app.getHttpServer()).get('/platform-legal/privacy');
    expect(priv.body.updatedAt).toBeNull();
    expect(priv.body.content).toContain('RGPD');

    // Sin auth no se puede editar.
    await request(app.getHttpServer())
      .put('/admin/platform/legal/terms')
      .send({ title: 'x', content: 'y' })
      .expect(401);
  });
});
