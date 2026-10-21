import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { WebAnalyticsDto } from '@storageos/shared';

const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

describe('Analítica propia de la web (e2e)', () => {
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

  it('visitas y clics por origen, con contactos y gasto del canal', async () => {
    const owner = await registerVerifiedUser(app, 'web-analytics');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const event = (ua: string, body: Record<string, unknown>) =>
      http().post(`/public/landing/${owner.slug}/events`).set('User-Agent', ua).send(body);

    const ig = { visitorId: 'visitor-ig-0001', source: 'instagram', medium: 'social' };
    await event(MOBILE, { ...ig, kind: 'page_view', path: `/s/${owner.slug}` }).expect(204);
    // Recargar la misma página no cuenta otra visita.
    await event(MOBILE, { ...ig, kind: 'page_view', path: `/s/${owner.slug}/` }).expect(204);
    await event(MOBILE, { ...ig, kind: 'page_view', path: `/s/${owner.slug}/precios` }).expect(204);
    await event(MOBILE, { ...ig, kind: 'call_click', path: `/s/${owner.slug}/precios` }).expect(
      204,
    );
    await event(DESKTOP, {
      visitorId: 'visitor-direct-01',
      kind: 'page_view',
      path: '/trasteros-en-mislata',
    }).expect(204);
    // Los robots no cuentan.
    await event('Mozilla/5.0 (compatible; Googlebot/2.1)', {
      visitorId: 'visitor-bot-0001',
      kind: 'page_view',
      path: '/',
    }).expect(204);
    // Tipo de evento desconocido → 400.
    await event(MOBILE, { ...ig, kind: 'scroll', path: '/' }).expect(400);

    // Un contacto que vino de Instagram y el gasto del canal de Instagram.
    await http()
      .post('/leads')
      .set(auth)
      .send({
        source: 'web',
        firstName: 'Ana',
        email: 'ana@web-analytics.local',
        utmSource: 'instagram',
      })
      .expect(201);
    const channel = await http()
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'meta_ads', name: 'Instagram', utmSourceMatch: 'instagram' })
      .expect(201);
    await http()
      .post('/expenses')
      .set(auth)
      .send({
        category: 'marketing',
        description: 'Anuncios de Instagram',
        amount: 50,
        expenseDate: new Date().toISOString().slice(0, 10),
        marketingChannelId: channel.body.id,
      })
      .expect(201);

    const res = await http().get('/marketing/web-analytics?days=30').set(auth).expect(200);
    const report = res.body as WebAnalyticsDto;
    expect(report.days).toBe(30);
    expect(report.totals).toMatchObject({
      visitors: 2,
      pageViews: 3,
      calls: 1,
      contacts: 1,
      cost: 50,
    });
    const instagram = report.sources.find((s) => s.source === 'instagram');
    expect(instagram).toMatchObject({
      visitors: 1,
      pageViews: 2,
      calls: 1,
      contacts: 1,
      cost: 50,
      bookings: 0,
      costPerBooking: null,
    });
    expect(report.sources.find((s) => s.source === 'web')).toMatchObject({ visitors: 1 });
    // Rutas como las ve el visitante y clics de contacto por página.
    expect(report.pages.map((p) => p.path).sort()).toEqual(
      ['/', '/precios', '/trasteros-en-mislata'].sort(),
    );
    expect(report.pages.find((p) => p.path === '/precios')?.contactClicks).toBe(1);
    expect(report.devices).toEqual(
      expect.arrayContaining([
        { device: 'mobile', visitors: 1 },
        { device: 'desktop', visitors: 1 },
      ]),
    );
    expect(report.daily.length).toBeGreaterThanOrEqual(30);
    expect(report.daily.reduce((n, d) => n + d.pageViews, 0)).toBe(3);

    // Otro tenant no ve estas visitas.
    const other = await registerVerifiedUser(app, 'web-analytics-b');
    const otherRes = await http()
      .get('/marketing/web-analytics')
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .expect(200);
    expect((otherRes.body as WebAnalyticsDto).totals.pageViews).toBe(0);
  });

  it('una reserva online con origen cuenta como reserva y firmada de ese origen', async () => {
    const owner = await registerVerifiedUser(app, 'web-analytics-book');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        startDate: tomorrow,
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Marta',
          lastName: 'Ruiz',
          email: `wa-book-${Date.now()}@e2e.local`,
        },
        utmSource: 'google',
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

    const res = await http().get('/marketing/web-analytics?days=7').set(auth).expect(200);
    const report = res.body as WebAnalyticsDto;
    expect(report.sources.find((s) => s.source === 'google')).toMatchObject({
      contacts: 1,
      bookings: 1,
      signed: 1,
    });
    expect(report.totals).toMatchObject({ bookings: 1, signed: 1 });
  });

  it('el informe exige sesión', async () => {
    await http().get('/marketing/web-analytics').expect(401);
  });
});
