import request from 'supertest';

import { TenantLifecycleEmailsService } from '../src/modules/admin/tenant-lifecycle-emails.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { PublicSitemapDto, PublicTenantBrandDto } from '@storageos/shared';

const DAY = 86_400_000;

describe('Revisión del alta de un tenant (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    process.env.E2E_SKIP_READINESS = 'false';
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    process.env.E2E_SKIP_READINESS = 'true';
    await app.close();
    await cleanupTestTenants();
  });

  const register = async (prefix: string) => {
    const { slug, email } = uniqueTestIds(prefix);
    await http()
      .post('/auth/register')
      .send({
        tenantName: `Alta ${prefix}`,
        tenantSlug: slug.toUpperCase(),
        fullName: 'Nueva Persona',
        email,
        password: 'Prueba1234',
        acceptTerms: true,
      })
      .expect(201);
    return { slug, email };
  };

  const backdate = (slug: string, days: number) =>
    admin.tenant.update({
      where: { slug },
      data: { createdAt: new Date(Date.now() - days * DAY) },
    });

  it('guarda la aceptación de los términos y pasa el identificador a minúsculas', async () => {
    const { slug, email } = await register('alta-terms');
    const user = await admin.user.findFirstOrThrow({
      where: { email, tenant: { slug } },
    });
    expect(user.termsAcceptedAt).not.toBeNull();
    expect(user.termsAcceptedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('la web no se publica sin cuenta activada ni local, y sin datos no se reserva', async () => {
    const { slug } = await register('alta-web');
    const brand = async (s: string) =>
      (await http().get(`/public/landing/brand/${s}`).expect(200)).body as PublicTenantBrandDto;
    expect((await brand(slug)).webPending).toBe(true);
    await http().get(`/public/landing/${slug}`).expect(404);
    const inSitemap = async (s: string) =>
      ((await http().get('/public/landing/sitemap').expect(200)).body as PublicSitemapDto).entries
        .map((e) => e.tenantSlug)
        .includes(s);
    expect(await inSitemap(slug)).toBe(false);

    const owner = await registerVerifiedUser(app, 'alta-ready');
    expect((await brand(owner.slug)).webPending).toBe(true);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const ready = await brand(owner.slug);
    expect(ready.webPending).toBe(false);
    await http().get(`/public/landing/${owner.slug}`).expect(200);
    expect(await inSitemap(owner.slug)).toBe(true);

    expect((await brand(owner.slug)).bookingPending).toBe(true);
    await http().get(`/public/move-in/book/${owner.slug}/availability`).expect(409);

    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .post('/settings/saas-billing/billing-details')
      .set(auth)
      .send({
        legalName: 'Alta Ready SL',
        taxId: '00000000T',
        address: 'C/ Mayor 1',
        city: 'Valencia',
        postalCode: '46001',
      })
      .expect(200);
    await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ transferIban: 'ES9121000418450200051332' })
      .expect(200);
    expect((await brand(owner.slug)).bookingPending).toBe(false);
    await http().get(`/public/move-in/book/${owner.slug}/availability`).expect(200);
  });

  it('recuerda el identificador por correo sin decir si el email existe', async () => {
    await deleteAllMessages();
    const { slug, email } = await register('alta-forgot');
    await http().post('/auth/forgot-tenant').send({ email }).expect(204);
    await http().post('/auth/forgot-tenant').send({ email: 'nadie@e2e.local' }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'identificador' });
    expect(mail.Text).toContain(slug);
  });

  it('recuerda activar la cuenta y borra la que nunca se activó', async () => {
    const lifecycle = app.get(TenantLifecycleEmailsService);
    const { slug } = await register('alta-purge');
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug } });

    await backdate(slug, 2);
    expect(await lifecycle.runVerificationReminders()).toBeGreaterThanOrEqual(1);
    await backdate(slug, 4);
    await lifecycle.runVerificationReminders();
    const sent = await admin.tenantLifecycleEmail.findMany({ where: { tenantId: tenant.id } });
    expect(sent.map((e) => e.type).sort()).toEqual(['verify_reminder_1', 'verify_reminder_2']);

    // Antes de los 30 días, o sin los 7 días desde el último aviso, no se toca.
    await backdate(slug, 31);
    await lifecycle.purgeUnverifiedAccounts();
    expect(await admin.tenant.count({ where: { slug } })).toBe(1);

    await admin.tenantLifecycleEmail.updateMany({
      where: { tenantId: tenant.id, type: 'verify_reminder_2' },
      data: { sentAt: new Date(Date.now() - 8 * DAY) },
    });
    await lifecycle.purgeUnverifiedAccounts();
    expect(await admin.tenant.count({ where: { slug } })).toBe(0);
    expect(await admin.user.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('la bienvenida y los avisos de activación solo van a quien puede entrar', async () => {
    const lifecycle = app.get(TenantLifecycleEmailsService);
    const { slug } = await register('alta-nudge');
    await backdate(slug, 8);
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug } });
    await admin.tenant.update({
      where: { id: tenant.id },
      data: { billingEmail: 'facturas@e2e.local' },
    });
    await lifecycle.runActivationNudges();
    expect(await admin.tenantLifecycleEmail.count({ where: { tenantId: tenant.id } })).toBe(0);

    // Con la cuenta activa y sin local, el del día 7 (da por hecho el local) no sale.
    const owner = await registerVerifiedUser(app, 'alta-nudge2');
    await admin.tenant.update({
      where: { slug: owner.slug },
      data: { createdAt: new Date(Date.now() - 8 * DAY) },
    });
    await lifecycle.runActivationNudges();
    const t2 = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const rows = await admin.tenantLifecycleEmail.findMany({ where: { tenantId: t2.id } });
    expect(rows.map((r) => r.type)).not.toContain('activation_customer');
  });

  it('solo propietario y gestor ven la puesta en marcha', async () => {
    const owner = await registerVerifiedUser(app, 'alta-roles');
    await admin.user.update({ where: { id: owner.userId }, data: { role: 'staff' } });
    const relogin = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: owner.email, password: owner.password });
    await http()
      .get('/dashboard/onboarding')
      .set({ Authorization: `Bearer ${relogin.body.accessToken as string}` })
      .expect(403);
  });
});
