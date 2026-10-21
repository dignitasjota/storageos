import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { AdPerformanceDto } from '@storageos/shared';

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('Rendimiento de los anuncios (e2e)', () => {
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

  it('cruza impresiones, clics y gasto con los contactos y reservas del canal', async () => {
    const owner = await registerVerifiedUser(app, 'ads-perf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });

    const google = await http()
      .post('/marketing/channels')
      .set(auth)
      .send({
        type: 'google_ads',
        name: 'Búsqueda local',
        utmSourceMatch: 'gads_local',
        externalCampaignId: '999',
      })
      .expect(201);
    const meta = await http()
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'meta_ads', name: 'Instagram otoño', utmSourceMatch: 'ig_otono' })
      .expect(201);
    // Un canal que no es de anuncios no sale.
    await http()
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'physical', name: 'Flyer' })
      .expect(201);

    // Métricas como las guarda la sincronización (dos días dentro y uno fuera).
    const admin = app.get(PrismaAdminService);
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const metric = (
      date: string,
      cost: number,
      impressions: number,
      clicks: number,
      conversions: number,
    ) => ({
      tenantId: tenant.id,
      marketingChannelId: google.body.id as string,
      platform: 'google_ads',
      campaignId: '999',
      date: new Date(`${date}T00:00:00.000Z`),
      cost,
      impressions,
      clicks,
      conversions,
    });
    await admin.adMetricDaily.createMany({
      data: [
        metric(day(-2), 40, 1000, 20, 1),
        metric(day(-1), 60, 1000, 30, 2),
        metric(day(-60), 500, 9000, 400, 9),
      ],
    });
    // Canal sin métricas todavía: se usa su gasto.
    await http()
      .post('/expenses')
      .set(auth)
      .send({
        category: 'marketing',
        description: 'Anuncios',
        amount: 30,
        expenseDate: day(-1),
        marketingChannelId: meta.body.id,
      })
      .expect(201);

    // Un contacto y una reserva online firmada que llegaron por la campaña de Google.
    await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'web', firstName: 'Luis', email: 'luis@ads.local', utmSource: 'gads_local' })
      .expect(201);
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        startDate: day(1),
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Marta',
          lastName: 'Ruiz',
          email: `ads-${Date.now()}@e2e.local`,
        },
        utmSource: 'gads_local',
        utmMedium: 'cpc',
      })
      .expect(201);
    await http()
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({
        signerName: 'Marta Ruiz',
        method: 'typed',
        typedSignature: 'Marta Ruiz',
        accept: true,
      })
      .expect(201);

    const res = await http()
      .get(`/marketing/channels/ads-performance?from=${day(-29)}&to=${day(0)}`)
      .set(auth)
      .expect(200);
    const report = res.body as AdPerformanceDto;
    expect(report.rows).toHaveLength(2);
    const g = report.rows.find((r) => r.channelId === google.body.id);
    expect(g).toMatchObject({
      platform: 'google_ads',
      impressions: 2000,
      clicks: 50,
      cost: 100,
      platformConversions: 3,
      ctr: 0.025,
      cpc: 2,
      contacts: 2,
      bookings: 1,
      signed: 1,
      costPerContact: 50,
      costPerBooking: 100,
      lastDataDate: day(-1),
    });
    expect(report.rows.find((r) => r.channelId === meta.body.id)).toMatchObject({
      platform: 'meta_ads',
      cost: 30,
      impressions: 0,
      ctr: null,
      lastDataDate: null,
    });
    expect(report.totals).toMatchObject({ cost: 130, clicks: 50, bookings: 1 });

    await http().get('/marketing/channels/ads-performance?from=ayer').set(auth).expect(400);

    // Otro tenant no ve estas campañas.
    const other = await registerVerifiedUser(app, 'ads-perf-b');
    const otherRes = await http()
      .get('/marketing/channels/ads-performance')
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .expect(200);
    expect((otherRes.body as AdPerformanceDto).rows).toHaveLength(0);
  });
});
