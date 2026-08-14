import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { MarketingRenewalsCron } from '../src/modules/marketing/marketing-renewals.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Control de marketing: catálogo de canales + coste vinculado + rendimiento
 * (coste↔leads↔conversión↔MRR) + enlace corto de campaña + avisos de renovación.
 */
describe('Canales de marketing (e2e)', () => {
  let app: INestApplication;
  let renewalsCron: MarketingRenewalsCron;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    renewalsCron = app.get(MarketingRenewalsCron);
    admin = app.get(PrismaAdminService);
    // Limpia el claim diario de re-ejecuciones anteriores del mismo día (local/CI rerun).
    await admin.cronRun.deleteMany({ where: { name: 'marketing-renewals.daily' } });
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('CRUD: crea con enlace corto y utmSourceMatch autogenerados, edita, filtra, borra (soft)', async () => {
    const owner = await registerVerifiedUser(app, 'mkt-crud');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const created = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'real_estate_portal', name: 'Idealista Centro', monthlyCost: 120 });
    expect(created.status).toBe(201);
    expect(created.body.shortCode).toBeTruthy();
    expect(created.body.shortUrl).toContain(`/g/${created.body.shortCode}`);
    expect(created.body.utmSourceMatch).toBe('idealista_centro');
    expect(created.body.status).toBe('active');
    expect(created.body.clickCount).toBe(0);
    const channelId = created.body.id as string;

    // Editar: pausar + fijar utmSourceMatch propio.
    const updated = await request(app.getHttpServer())
      .patch(`/marketing/channels/${channelId}`)
      .set(auth)
      .send({ status: 'paused', utmSourceMatch: 'idealista' });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('paused');
    expect(updated.body.utmSourceMatch).toBe('idealista');

    // Filtro por estado.
    const paused = await request(app.getHttpServer())
      .get('/marketing/channels?status=paused')
      .set(auth);
    expect(paused.body.map((c: { id: string }) => c.id)).toContain(channelId);
    const active = await request(app.getHttpServer())
      .get('/marketing/channels?status=active')
      .set(auth);
    expect(active.body.map((c: { id: string }) => c.id)).not.toContain(channelId);

    // Borrado (soft): desaparece de la lista.
    await request(app.getHttpServer())
      .delete(`/marketing/channels/${channelId}`)
      .set(auth)
      .expect(204);
    const afterDelete = await request(app.getHttpServer()).get('/marketing/channels').set(auth);
    expect(afterDelete.body.map((c: { id: string }) => c.id)).not.toContain(channelId);
  });

  it('rendimiento: coste (gasto vinculado) ↔ leads/conversión (booking con UTM) ↔ MRR', async () => {
    const owner = await registerVerifiedUser(app, 'mkt-perf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });

    const channel = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'google_ads', name: 'Google Ads Verano', utmSourceMatch: 'google_verano' });
    expect(channel.status).toBe(201);
    const channelId = channel.body.id as string;

    // Coste: gasto de categoría marketing vinculado al canal.
    const expense = await request(app.getHttpServer())
      .post('/expenses')
      .set(auth)
      .send({
        category: 'marketing',
        description: 'Campaña Google Ads',
        amount: 200,
        expenseDate: isoDate(0),
        marketingChannelId: channelId,
      });
    expect(expense.status).toBe(201);
    expect(expense.body.marketingChannelId).toBe(channelId);
    expect(expense.body.marketingChannelName).toBe('Google Ads Verano');

    // Lead + conversión: booking self-service con utm_source=google_verano.
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        startDate: isoDate(1),
        customer: { firstName: 'Marta', lastName: 'Ruiz', email: `mkt-${Date.now()}@e2e.local` },
        utmSource: 'google_verano',
        utmMedium: 'cpc',
        utmCampaign: 'verano2026',
      });
    expect(booking.status).toBe(201);
    const signed = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({
        signerName: 'Marta Ruiz',
        method: 'typed',
        typedSignature: 'Marta Ruiz',
        accept: true,
      });
    expect(signed.status).toBe(201);
    expect(signed.body.status).toBe('active');

    const perf = await request(app.getHttpServer())
      .get(`/marketing/channels/performance?from=${isoDate(-1)}&to=${isoDate(1)}`)
      .set(auth);
    expect(perf.status).toBe(200);
    const row = perf.body.rows.find((r: { channelId: string }) => r.channelId === channelId);
    expect(row).toBeDefined();
    expect(row.cost).toBe(200);
    expect(row.leadsCount).toBe(1);
    expect(row.wonCount).toBe(1);
    expect(row.costPerLead).toBe(200);
    expect(row.cac).toBe(200);
    expect(row.mrrGenerated).toBe(100);
    expect(row.paybackMonths).toBe(2);
    expect(perf.body.totals.cost).toBeGreaterThanOrEqual(200);
    expect(perf.body.totals.mrrGenerated).toBeGreaterThanOrEqual(100);
  });

  it('enlace corto: redirige con UTM y cuenta el clic; código inexistente → 404', async () => {
    const owner = await registerVerifiedUser(app, 'mkt-short');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const channel = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'physical', name: 'Cartel Nave 3' });
    const channelId = channel.body.id as string;
    const shortCode = channel.body.shortCode as string;

    const resolved = await request(app.getHttpServer()).get(`/public/marketing/go/${shortCode}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.targetUrl).toContain(`/book/${owner.slug}`);
    expect(resolved.body.targetUrl).toContain('utm_source=cartel_nave_3');
    expect(resolved.body.targetUrl).toContain(`utm_campaign=${channelId}`);

    const afterClick = await request(app.getHttpServer())
      .get(`/marketing/channels?status=active`)
      .set(auth);
    const found = afterClick.body.find((c: { id: string }) => c.id === channelId);
    expect(found.clickCount).toBe(1);

    await request(app.getHttpServer()).get('/public/marketing/go/no-existe-123').expect(404);
  });

  it('avisos de renovación: un canal que renueva en 7 días aparece en «Hoy» y genera notificación', async () => {
    const owner = await registerVerifiedUser(app, 'mkt-renew');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const created = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'real_estate_portal', name: 'Fotocasa Anual', renewsOn: isoDate(7) });
    expect(created.status).toBe(201);

    const today = await request(app.getHttpServer()).get('/dashboard/today').set(auth);
    expect(today.status).toBe(200);
    expect(today.body.marketingRenewalsDue.count).toBeGreaterThanOrEqual(1);
    expect(
      (today.body.marketingRenewalsDue.items as { label: string }[]).some(
        (i) => i.label === 'Fotocasa Anual',
      ),
    ).toBe(true);

    await renewalsCron.daily();
    let notified = false;
    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer()).get('/notifications').set(auth);
      const items = res.body.items as { type: string; link: string | null }[];
      if (items.some((n) => n.type === 'marketing.channel_renewing_soon')) {
        notified = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(notified).toBe(true);
  });

  it('sin autenticación → 401', async () => {
    await request(app.getHttpServer()).get('/marketing/channels').expect(401);
    await request(app.getHttpServer()).get('/marketing/channels/performance').expect(401);
  });
});
