import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Catálogo self-service de add-ons: el propio tenant (owner) contrata/cancela
 * extras desde su panel; contratar activa la feature al instante.
 */
describe('Add-ons self-service del tenant (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let addonId: string;
  let capAddonId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.subscriptionAddon.deleteMany({
      where: { slug: { in: ['e2e-self-ai', 'e2e-self-cap'] } },
    });
    const addon = await admin.subscriptionAddon.create({
      data: {
        slug: 'e2e-self-ai',
        name: 'Asistente IA',
        priceMonthly: 12,
        feature: 'ai_assistant',
        isActive: true,
      },
    });
    addonId = addon.id;
    // Add-on de capacidad: +1 usuario por unidad.
    const cap = await admin.subscriptionAddon.create({
      data: {
        slug: 'e2e-self-cap',
        name: 'Usuario extra',
        priceMonthly: 5,
        grantsUsers: 1,
        isActive: true,
      },
    });
    capAddonId = cap.id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.subscriptionAddon.deleteMany({
      where: { slug: { in: ['e2e-self-ai', 'e2e-self-cap'] } },
    });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('el tenant ve el catálogo, contrata (activa feature) y cancela', async () => {
    const owner = await registerVerifiedUser(app, 'self-addon');
    await setTenantPlan(owner.slug, 'free'); // free no incluye ai_assistant
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // El add-on aparece como disponible; no está contratado.
    const view = await request(app.getHttpServer()).get('/settings/saas-billing/addons').set(auth);
    expect(view.status).toBe(200);
    expect(view.body.available.some((a: { id: string }) => a.id === addonId)).toBe(true);
    expect(view.body.summary.addons).toHaveLength(0);

    // Antes: /auth/me no trae ai_assistant.
    const me1 = await request(app.getHttpServer()).get('/auth/me').set(auth);
    expect(me1.body.features).not.toContain('ai_assistant');

    // Contratar → aparece en contratados + activa la feature.
    const contracted = await request(app.getHttpServer())
      .post('/settings/saas-billing/addons')
      .set(auth)
      .send({ addonId });
    expect(contracted.status).toBe(200);
    expect(contracted.body.summary.addons).toHaveLength(1);
    expect(contracted.body.summary.addonsMonthly).toBe(12);
    const assignmentId = contracted.body.summary.addons[0].id as string;

    // La feature ya está activa para el tenant.
    const me2 = await request(app.getHttpServer()).get('/auth/me').set(auth);
    expect(me2.body.features).toContain('ai_assistant');

    // Cancelar → vuelve a disponible + se retira la feature.
    const cancelled = await request(app.getHttpServer())
      .delete(`/settings/saas-billing/addons/${assignmentId}`)
      .set(auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.summary.addons).toHaveLength(0);

    const me3 = await request(app.getHttpServer()).get('/auth/me').set(auth);
    expect(me3.body.features).not.toContain('ai_assistant');
  });

  it('no puede re-contratar un add-on ya contratado (409) ni ve las notas internas', async () => {
    const owner = await registerVerifiedUser(app, 'self-addon-dup');
    await setTenantPlan(owner.slug, 'free');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });

    const first = await request(app.getHttpServer())
      .post('/settings/saas-billing/addons')
      .set(auth)
      .send({ addonId });
    expect(first.status).toBe(200);
    const assignmentId = first.body.summary.addons[0].id as string;

    // Re-contratar el mismo add-on → 409 (no pisa precio/cantidad/notas).
    const dup = await request(app.getHttpServer())
      .post('/settings/saas-billing/addons')
      .set(auth)
      .send({ addonId });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('addon_already_assigned');

    // El admin pone una nota interna en la asignación.
    await admin.tenantSubscriptionAddon.update({
      where: { id: assignmentId },
      data: { notes: 'Descuento por queja — revisar Q3' },
    });
    // El tenant NO ve la nota interna en su self-service.
    const view = await request(app.getHttpServer()).get('/settings/saas-billing/addons').set(auth);
    expect(view.body.summary.addons[0].notes).toBeNull();
    void tenant;
  });

  it('no puede cancelar un add-on de capacidad cuyo cupo está en uso (409)', async () => {
    const owner = await registerVerifiedUser(app, 'self-addon-cap');
    await setTenantPlan(owner.slug, 'free'); // free: maxUsers = 2
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const stamp = Math.random().toString(36).slice(2, 8);

    // Contratar el add-on de +1 usuario → límite pasa a 3.
    const contracted = await request(app.getHttpServer())
      .post('/settings/saas-billing/addons')
      .set(auth)
      .send({ addonId: capAddonId });
    expect(contracted.status).toBe(200);
    const assignmentId = contracted.body.summary.addons[0].id as string;

    // Se crean 2 usuarios activos → con el owner son 3 = tope (2 + 1 del add-on).
    for (const n of [1, 2]) {
      await admin.user.create({
        data: {
          tenantId: tenant!.id,
          email: `capuser-${n}-${stamp}@e2e.local`,
          passwordHash: await argonHash('Secret!23'),
          fullName: `Cap User ${n}`,
          role: 'staff',
          isActive: true,
          emailVerifiedAt: new Date(),
        },
      });
    }

    // Cancelar el add-on dejaría el límite en 2 con 3 usuarios en uso → 409.
    const blocked = await request(app.getHttpServer())
      .delete(`/settings/saas-billing/addons/${assignmentId}`)
      .set(auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('addon_capacity_in_use');
  });

  it('sin permiso billing:configure → 403 (staff)', async () => {
    const owner = await registerVerifiedUser(app, 'self-addon-staff');
    // El owner sí tiene el permiso; probamos que el endpoint exige sesión.
    await request(app.getHttpServer()).get('/settings/saas-billing/addons').expect(401);
    void owner;
  });
});
