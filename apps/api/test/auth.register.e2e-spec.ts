import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('POST /auth/register (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  function validBody(prefix = 'reg') {
    const ids = uniqueTestIds(prefix);
    return {
      tenantName: `Test ${prefix}`,
      tenantSlug: ids.slug,
      fullName: 'Test User',
      email: ids.email,
      password: 'Secret123',
      acceptTerms: true,
    };
  }

  it('crea tenant + owner, devuelve requiresEmailVerification=true sin cookie', async () => {
    const body = validBody();
    const res = await request(app.getHttpServer()).post('/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(body.email);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.tenant.slug).toBe(body.tenantSlug);
    expect(res.body.tenant.status).toBe('trial');
    expect(res.body.subscription.planSlug).toBe('starter');
    expect(res.body.requiresEmailVerification).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();

    // Nace con una serie de facturación por defecto (la 1ª factura de una
    // reserva online no se emite sin ella).
    const series = await app.get(PrismaAdminService).invoiceSeries.findMany({
      where: { tenant: { slug: body.tenantSlug } },
    });
    expect(series).toEqual([
      expect.objectContaining({ code: 'A', prefix: 'FA', isDefault: true, isActive: true }),
    ]);

    // El correo de verificación lleva el identificador con el que se entra.
    const email = await waitForEmail(body.email);
    expect(email.HTML).toContain(body.tenantSlug);
  });

  it('genera slug automaticamente cuando no se pasa', async () => {
    const ids = uniqueTestIds('auto');
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        tenantName: `Test Auto ${ids.slug}`,
        fullName: 'Test',
        email: ids.email,
        password: 'Secret123',
        acceptTerms: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).toMatch(/^test-auto-/);
  });

  it('rechaza con 409 cuando el slug ya esta en uso', async () => {
    const body = validBody('dup');
    const first = await request(app.getHttpServer()).post('/auth/register').send(body);
    expect(first.status).toBe(201);

    const ids = uniqueTestIds('dup2');
    const second = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...body, email: ids.email });
    expect(second.status).toBe(409);
  });

  it.each([
    ['password debil sin mayuscula', { password: 'secret12' }],
    ['password debil sin digito', { password: 'Secretooo' }],
    ['password debil sin minuscula', { password: 'SECRET123' }],
    ['email invalido', { email: 'no-es-email' }],
    ['acceptTerms en false', { acceptTerms: false }],
    ['tenantName muy corto', { tenantName: 'a' }],
    ['slug con guion al inicio', { tenantSlug: '-bad-slug' }],
  ])('devuelve 400 cuando %s', async (_label, override) => {
    const body = { ...validBody('val'), ...override };
    const res = await request(app.getHttpServer()).post('/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});
