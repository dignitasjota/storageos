import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { MarketingSummaryService } from '../src/modules/marketing/summary/marketing-summary.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { MarketingSummaryDto } from '@storageos/shared';

const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1';

/** Mes en curso en hora de España (`YYYY-MM`). */
const thisMonth = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' })
    .format(new Date())
    .slice(0, 7);
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

describe('Resumen mensual de marketing (e2e)', () => {
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

  it('junta la web, los contactos y el gasto del mes y dice qué hacer', async () => {
    const owner = await registerVerifiedUser(app, 'mkt-summary');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const ig = { visitorId: 'visitor-sum-0001', source: 'instagram', medium: 'social' };
    await http()
      .post(`/public/landing/${owner.slug}/events`)
      .set('User-Agent', MOBILE)
      .send({ ...ig, kind: 'page_view', path: `/s/${owner.slug}` })
      .expect(204);
    await http()
      .post(`/public/landing/${owner.slug}/events`)
      .set('User-Agent', MOBILE)
      .send({ ...ig, kind: 'whatsapp_click', path: `/s/${owner.slug}` })
      .expect(204);
    await http()
      .post('/leads')
      .set(auth)
      .send({
        source: 'web',
        firstName: 'Ana',
        email: 'ana@mkt-summary.local',
        utmSource: 'instagram',
      })
      .expect(201);
    await http().post('/leads').set(auth).send({ source: 'phone', firstName: 'Luis' }).expect(201);
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
        amount: 60,
        expenseDate: today(),
        marketingChannelId: channel.body.id,
      })
      .expect(201);

    const res = await http().get(`/marketing/summary?month=${thisMonth()}`).set(auth).expect(200);
    const summary = res.body as MarketingSummaryDto;
    expect(summary.month).toBe(thisMonth());
    expect(summary.current).toMatchObject({
      visitors: 1,
      contactClicks: 1,
      webContacts: 1,
      allContacts: 2,
      bookings: 0,
      spend: 60,
      ga4Sessions: null,
      searchClicks: null,
    });
    expect(summary.previous.visitors).toBe(0);
    expect(summary.sources[0]).toMatchObject({ source: 'instagram', visitors: 1, cost: 60 });
    expect(summary.connections.channelsWithLinks).toBe(1);
    expect(summary.reportEnabled).toBe(true);
    expect(summary.tips[0]).toMatchObject({ kind: 'warning', href: '/marketing/performance' });
    expect(summary.tips[0]!.text).toContain('instagram');

    await http().get('/marketing/summary?month=2026-13').set(auth).expect(400);
  });

  it('correo mensual: se apaga, se envía a mano y el cron no repite el mes', async () => {
    const owner = await registerVerifiedUser(app, 'mkt-report');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const sent = await http().post('/marketing/summary/report/send').set(auth).expect(200);
    expect(sent.body.recipients).toBe(1);

    const admin = app.get(PrismaAdminService);
    const tenant = await admin.tenant.findUniqueOrThrow({
      where: { slug: owner.slug },
      select: { id: true, marketingReportLastMonth: true },
    });
    expect(tenant.marketingReportLastMonth).toBe(sent.body.month);

    // Ya enviado este mes: el cron no lo vuelve a mandar.
    await admin.tenant.update({
      where: { id: tenant.id },
      data: { marketingReportLastMonth: null },
    });
    const service = app.get(MarketingSummaryService);
    await service.sendDueAll();
    const after = await admin.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { marketingReportLastMonth: true },
    });
    // Un mes sin actividad no se envía, pero queda marcado.
    expect(after.marketingReportLastMonth).toBe(sent.body.month);

    await http().put('/marketing/summary/report').set(auth).send({ enabled: false }).expect(204);
    const res = await http().get('/marketing/summary').set(auth).expect(200);
    expect((res.body as MarketingSummaryDto).reportEnabled).toBe(false);

    await http().get('/marketing/summary').expect(401);
  });
});
