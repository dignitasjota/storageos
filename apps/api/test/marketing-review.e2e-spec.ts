import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { MarketingRenewalsCron } from '../src/modules/marketing/marketing-renewals.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const isoDate = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

/**
 * Revisión de Marketing (PR 2): canales, rendimiento, anuncios y renovaciones.
 */
describe('Marketing — canales y rendimiento (revisión, e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let renewals: MarketingRenewalsCron;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    renewals = app.get(MarketingRenewalsCron);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('valida el canal: campaña repetida, dirección web, local de otro negocio y coste que se puede vaciar', async () => {
    const owner = await registerVerifiedUser(app, 'mkrev-valid');
    const other = await registerVerifiedUser(app, 'mkrev-other');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const foreign = await createFacilityWithUnits(app, other.accessToken, { unitsCount: 1 });

    const first = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'google_ads', name: 'Búsqueda', externalCampaignId: '777', monthlyCost: 90 });
    expect(first.status).toBe(201);

    // La misma campaña en otro canal: su gasto iría a los dos.
    const dup = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'google_ads', name: 'Búsqueda 2', externalCampaignId: '777' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('external_campaign_taken');

    const js = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'other', name: 'Raro', externalUrl: 'javascript:alert(1)' });
    expect(js.status).toBe(400);

    const foreignFacility = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'physical', name: 'Ajeno', facilityId: foreign.facilityId });
    expect(foreignFacility.status).toBe(400);
    expect(foreignFacility.body.code).toBe('facility_not_found');

    // El coste mensual estimado se puede quitar.
    const cleared = await request(app.getHttpServer())
      .patch(`/marketing/channels/${first.body.id}`)
      .set(auth)
      .send({ monthlyCost: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.monthlyCost).toBeNull();
  });

  it('alcance por local y dinero según permisos', async () => {
    const owner = await registerVerifiedUser(app, 'mkrev-scope');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const a = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const b = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    for (const [name, facilityId] of [
      ['Cartel A', a.facilityId],
      ['Cartel B', b.facilityId],
      ['Todo el negocio', null],
    ] as const) {
      await request(app.getHttpServer())
        .post('/marketing/channels')
        .set(auth)
        .send({ type: 'physical', name, facilityId, monthlyCost: 30 })
        .expect(201);
    }

    // Un gestor del local A ve los de A y los de todo el negocio, no los de B.
    const manager = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [a.facilityId],
      tag: 'mkrev-mgr',
    });
    const list = await request(app.getHttpServer()).get('/marketing/channels').set(manager);
    expect(list.status).toBe(200);
    expect((list.body as { name: string }[]).map((c) => c.name).sort()).toEqual([
      'Cartel A',
      'Todo el negocio',
    ]);
    // No crea canales de todo el negocio, sí de su local.
    const whole = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(manager)
      .send({ type: 'physical', name: 'Nuevo general' });
    expect(whole.status).toBe(403);
    await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(manager)
      .send({ type: 'physical', name: 'Nuevo A', facilityId: a.facilityId })
      .expect(201);

    // Un rol a medida solo de Marketing no ve gastos ni cobros.
    const role = await request(app.getHttpServer())
      .post('/settings/roles')
      .set(auth)
      .send({ name: 'Solo marketing', permissions: ['marketing:read'], baseRole: 'staff' });
    expect(role.status).toBe(201);
    const email = `mkrev-role-${Date.now()}@e2e.local`;
    await request(app.getHttpServer())
      .post('/invitations')
      .set(auth)
      .send({ email, role: 'staff' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await request(app.getHttpServer())
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Marketing', password: 'Passw0rd!' })
      .expect(200);
    const users = await request(app.getHttpServer()).get('/users').set(auth);
    const user = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    await request(app.getHttpServer())
      .patch(`/settings/users/${user.id}/tenant-role`)
      .set(auth)
      .send({ tenantRoleId: role.body.id })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Passw0rd!' })
      .expect(200);
    const marketer = { Authorization: `Bearer ${login.body.accessToken as string}` };

    const channels = await request(app.getHttpServer()).get('/marketing/channels').set(marketer);
    expect(
      (channels.body as { monthlyCost: number | null }[]).every((c) => c.monthlyCost === null),
    ).toBe(true);
    const perf = await request(app.getHttpServer())
      .get('/marketing/channels/performance')
      .set(marketer);
    expect(perf.status).toBe(200);
    expect(perf.body.money).toEqual({ revenue: false, cost: false });
    const summary = await request(app.getHttpServer()).get('/marketing/summary').set(marketer);
    expect(summary.status).toBe(200);
    expect(summary.body.money).toEqual({ revenue: false, cost: false });
  });

  it('rendimiento: fechas no válidas → 400 y un canal borrado con gasto sigue saliendo', async () => {
    const owner = await registerVerifiedUser(app, 'mkrev-perf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .get('/marketing/channels/performance?from=xyz')
      .set(auth)
      .expect(400);

    const channel = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'real_estate_portal', name: 'Idealista' });
    const today = isoDate(0);
    await request(app.getHttpServer())
      .post('/expenses')
      .set(auth)
      .send({
        category: 'marketing',
        description: 'Cuota Idealista',
        amount: 60,
        expenseDate: today,
        marketingChannelId: channel.body.id,
      })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/marketing/channels/${channel.body.id}`)
      .set(auth)
      .expect(204);

    const perf = await request(app.getHttpServer())
      .get(`/marketing/channels/performance?from=${today}&to=${today}`)
      .set(auth);
    expect(perf.status).toBe(200);
    const row = (perf.body.rows as { channelId: string; deleted: boolean; cost: number }[]).find(
      (r) => r.channelId === channel.body.id,
    );
    expect(row).toMatchObject({ deleted: true, cost: 60 });

    // A un canal borrado ya no se le vinculan gastos nuevos.
    const late = await request(app.getHttpServer()).post('/expenses').set(auth).send({
      category: 'marketing',
      description: 'Otra cuota',
      amount: 60,
      expenseDate: today,
      marketingChannelId: channel.body.id,
    });
    expect(late.status).toBe(400);
  });

  it('renovaciones: la fecha avanza sola y se avisa una vez por fecha', async () => {
    const owner = await registerVerifiedUser(app, 'mkrev-renew');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const monthly = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({
        type: 'real_estate_portal',
        name: 'Fotocasa',
        renewsOn: isoDate(-3),
        renewalMonths: 1,
      });
    expect(monthly.status).toBe(201);
    const soon = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'real_estate_portal', name: 'Habitaclia', renewsOn: isoDate(3) });
    expect(soon.status).toBe(201);

    await renewals.run();
    const moved = await admin.marketingChannel.findUniqueOrThrow({
      where: { id: monthly.body.id },
      select: { renewsOn: true },
    });
    expect(moved.renewsOn!.getTime()).toBeGreaterThan(Date.now() - 86_400_000);

    const notices = async () =>
      admin.notification.count({
        where: { tenant: { slug: owner.slug }, type: 'marketing.channel_renewing_soon' },
      });
    const first = await notices();
    expect(first).toBeGreaterThanOrEqual(1);
    await renewals.run();
    expect(await notices()).toBe(first);
  });

  it('credenciales de anuncios: probar antes de activar, borrar y dejar constancia', async () => {
    const owner = await registerVerifiedUser(app, 'mkrev-creds');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const missing = await request(app.getHttpServer())
      .post('/settings/marketing/meta-ads/test')
      .set(auth);
    expect(missing.status).toBe(200);
    expect(missing.body.ok).toBe(false);

    await request(app.getHttpServer())
      .put('/settings/marketing/meta-ads')
      .set(auth)
      .send({ accessToken: 'token-de-prueba', adAccountId: '123', enabled: false })
      .expect(200);
    const removed = await request(app.getHttpServer())
      .delete('/settings/marketing/meta-ads')
      .set(auth);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      enabled: false,
      hasAccessToken: false,
      adAccountId: null,
    });

    const logs = await admin.auditLog.findMany({
      where: { tenant: { slug: owner.slug }, action: { startsWith: 'marketing.meta_ads' } },
      select: { action: true, changes: true },
    });
    expect(logs.map((l) => l.action).sort()).toEqual([
      'marketing.meta_ads_settings_changed',
      'marketing.meta_ads_settings_deleted',
    ]);
    // Nunca el token.
    expect(JSON.stringify(logs)).not.toContain('token-de-prueba');
  });
});
