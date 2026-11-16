import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { buildOauthState, oauthStateKey } from '../src/common/marketing/oauth-state';
import { AdConversionsService } from '../src/modules/marketing/ad-platforms/ad-conversions.service';
import { Ga4Service } from '../src/modules/marketing/ga4/ga4.service';
import { MarketingRenewalsCron } from '../src/modules/marketing/marketing-renewals.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type {
  GoogleAdsSettingsDto,
  MarketingChannelDto,
  MarketingPerformanceDto,
  MarketingPerformanceRowDto,
  MarketingUnassignedSourceDto,
  MetaAdsSettingsDto,
  WebAnalyticsDto,
} from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

/** Hoy en España (`YYYY-MM-DD`). */
const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** DNI válido al azar (cada reserva, un cliente distinto). */
const randomDni = () => {
  const n = Math.floor(10_000_000 + Math.random() * 89_999_999);
  return `${n}${'TRWAGMYFPDXBNJZSQVHLCKE'[n % 23]}`;
};

/** Mejoras de Marketing: canales, rendimiento, visitas, conversiones, Meta y avisos. */
describe('Marketing: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  /** Reserva online y firma: el contrato queda firmado y su contacto, enlazado. */
  async function bookAndSign(
    slug: string,
    body: Record<string, unknown> & { facilityId: string; unitTypeId: string; email: string },
  ): Promise<{ contractId: string }> {
    const { email, ...rest } = body;
    const booking = await http()
      .post(`/public/move-in/book/${slug}`)
      .set('User-Agent', UA)
      .send({
        startDate: tomorrow(),
        customer: {
          firstName: 'Marta',
          lastName: 'Ruiz',
          email,
          phone: '600000000',
          documentNumber: randomDni(),
        },
        ...rest,
      })
      .expect(201);
    await http()
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({
        immediateStart: true,
        signerName: 'Marta Ruiz',
        method: 'typed',
        typedSignature: 'Marta Ruiz',
        accept: true,
        generalTermsHash: await generalTermsHash(app, booking.body.signingToken),
      })
      .expect(201);
    return { contractId: booking.body.contractId as string };
  }

  const rowOf = (perf: MarketingPerformanceDto, id: string): MarketingPerformanceRowDto =>
    perf.rows.find((r) => r.channelId === id)!;

  it('canales: enlace de seguimiento, cupón, presupuesto del mes, código corto y orígenes sin canal', async () => {
    const owner = await registerVerifiedUser(app, 'mkf-channels');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const coupon = await http()
      .post('/coupons')
      .set(auth)
      .send({ code: 'BUZON10', name: 'Buzoneo', discountType: 'percentage', discountValue: 10 })
      .expect(201);

    // Un cupón que no es del negocio no se puede vincular.
    const bad = await http()
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'physical', name: 'Buzoneo', couponId: '0190f5c2-0000-7000-8000-000000000001' })
      .expect(400);
    expect(bad.body.code).toBe('coupon_not_found');

    const created = await http()
      .post('/marketing/channels')
      .set(auth)
      .send({
        type: 'physical',
        name: 'Buzoneo',
        utmSourceMatch: 'buzoneo',
        couponId: coupon.body.id,
        monthlyBudget: 100,
      })
      .expect(201);
    const channel = created.body as MarketingChannelDto;
    expect(channel).toMatchObject({
      couponId: coupon.body.id,
      couponCode: 'BUZON10',
      monthlyBudget: 100,
      spentThisMonth: 0,
    });
    // Código fácil de teclear: 6 letras y cifras sin las que se confunden.
    expect(channel.shortCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
    const tracking = new URL(channel.trackingUrl);
    expect(tracking.pathname).toBe(`/s/${owner.slug}`);
    expect(tracking.searchParams.get('utm_source')).toBe('buzoneo');
    expect(tracking.searchParams.get('utm_campaign')).toBe(channel.id);

    // Tecleado en minúsculas, también llega (y lleva a la reserva con el origen).
    const resolved = await http()
      .get(`/public/marketing/go/${channel.shortCode!.toLowerCase()}`)
      .set('User-Agent', UA)
      .expect(200);
    expect(resolved.body.targetUrl).toContain('utm_source=buzoneo');

    // Lo gastado este mes cuenta para el presupuesto.
    await http()
      .post('/expenses')
      .set(auth)
      .send({
        category: 'marketing',
        description: 'Folletos',
        amount: 30,
        expenseDate: madridToday(),
        marketingChannelId: channel.id,
      })
      .expect(201);
    const list = (await http().get('/marketing/channels').set(auth).expect(200))
      .body as MarketingChannelDto[];
    expect(list.find((c) => c.id === channel.id)).toMatchObject({ spentThisMonth: 30 });

    // Visitas de un origen que no recoge ningún canal: se propone crearlo.
    const event = (visitorId: string, source: string) =>
      http()
        .post(`/public/landing/${owner.slug}/events`)
        .set('User-Agent', UA)
        .send({ visitorId, kind: 'page_view', path: `/s/${owner.slug}`, source, medium: 'social' })
        .expect(204);
    await event('mkf-visitor-tiktok-1', 'tiktok');
    await event('mkf-visitor-buzon-1', 'buzoneo');
    const sources = (
      await http().get('/marketing/channels/unassigned-sources?days=30').set(auth).expect(200)
    ).body as MarketingUnassignedSourceDto[];
    expect(sources.find((s) => s.source === 'tiktok')).toMatchObject({ visitors: 1 });
    expect(sources.some((s) => s.source === 'buzoneo')).toBe(false);
  });

  it('rendimiento: primer o último contacto, por local, por cupón y lo cobrado', async () => {
    const owner = await registerVerifiedUser(app, 'mkf-perf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const main = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Principal',
      unitsCount: 3,
      pricePerUnit: 100,
    });
    const other = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Otro',
      unitsCount: 1,
      pricePerUnit: 80,
    });
    const instagram = (
      await http()
        .post('/marketing/channels')
        .set(auth)
        .send({ type: 'other', name: 'Instagram', utmSourceMatch: 'instagram' })
        .expect(201)
    ).body as MarketingChannelDto;
    const google = (
      await http()
        .post('/marketing/channels')
        .set(auth)
        .send({ type: 'google_ads', name: 'Google Ads', utmSourceMatch: 'google' })
        .expect(201)
    ).body as MarketingChannelDto;
    const coupon = await http()
      .post('/coupons')
      .set(auth)
      .send({ code: 'CARTEL5', name: 'Cartel', discountType: 'percentage', discountValue: 5 })
      .expect(201);
    const poster = (
      await http()
        .post('/marketing/channels')
        .set(auth)
        .send({ type: 'physical', name: 'Cartel', couponId: coupon.body.id })
        .expect(201)
    ).body as MarketingChannelDto;
    await http()
      .post('/expenses')
      .set(auth)
      .send({
        category: 'marketing',
        description: 'Anuncios',
        amount: 50,
        expenseDate: madridToday(),
        marketingChannelId: google.id,
      })
      .expect(201);

    // Llega por Instagram (deja su email) y reserva desde un anuncio de Google.
    const email = `mkf-perf-${Date.now()}@e2e.local`;
    await http()
      .post(`/public/move-in/book/${owner.slug}/lead`)
      .set('User-Agent', UA)
      .send({ email, utmSource: 'instagram', utmMedium: 'social' })
      .expect(201);
    const { contractId } = await bookAndSign(owner.slug, {
      facilityId: main.facilityId,
      unitTypeId: main.unitTypeId,
      email,
      utmSource: 'google',
      utmMedium: 'cpc',
    });
    // Otro cliente con el cupón del cartel (sin origen).
    await bookAndSign(owner.slug, {
      facilityId: main.facilityId,
      unitTypeId: main.unitTypeId,
      email: `mkf-cartel-${Date.now()}@e2e.local`,
      couponCode: 'CARTEL5',
    });

    // El primer cliente paga su primera factura.
    const invoice = await db.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
      orderBy: { createdAt: 'asc' },
    });
    if (invoice.status === 'draft') {
      await http().post(`/invoices/${invoice.id}/issue`).set(auth).expect(200);
    }
    const issued = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    await http()
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(issued.total), methodType: 'cash' })
      .expect(200);

    const first = (await http().get('/marketing/channels/performance').set(auth).expect(200))
      .body as MarketingPerformanceDto;
    expect(first.model).toBe('first');
    expect(rowOf(first, instagram.id)).toMatchObject({ bookings: 1, wonCount: 1, paidCount: 1 });
    expect(rowOf(first, instagram.id).collected).toBeGreaterThan(0);
    expect(rowOf(first, google.id)).toMatchObject({ bookings: 0, wonCount: 0, cost: 50 });
    expect(rowOf(first, poster.id)).toMatchObject({ wonCount: 1 });

    const last = (
      await http().get('/marketing/channels/performance?model=last').set(auth).expect(200)
    ).body as MarketingPerformanceDto;
    expect(rowOf(last, google.id)).toMatchObject({ bookings: 1, wonCount: 1, paidCount: 1 });
    expect(rowOf(last, google.id).roas).toBeGreaterThan(0);
    expect(rowOf(last, instagram.id)).toMatchObject({ bookings: 0, wonCount: 0 });

    // Otro local: ninguna reserva.
    const byFacility = (
      await http()
        .get(`/marketing/channels/performance?facilityId=${other.facilityId}`)
        .set(auth)
        .expect(200)
    ).body as MarketingPerformanceDto;
    expect(byFacility.facilityId).toBe(other.facilityId);
    expect(byFacility.rows.reduce((n, r) => n + r.bookings + r.wonCount, 0)).toBe(0);

    const badModel = await http()
      .get('/marketing/channels/performance?model=otro')
      .set(auth)
      .expect(400);
    expect(badModel.body.code).toBe('invalid_model');
    const badFacility = await http()
      .get('/marketing/channels/performance?facilityId=no-es-un-id')
      .set(auth)
      .expect(400);
    expect(badFacility.body.code).toBe('invalid_facility_id');
  });

  it('visitas: embudo de la reserva, qué buscan, horas de contacto y notas en la gráfica', async () => {
    const owner = await registerVerifiedUser(app, 'mkf-visits');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Demanda',
      unitsCount: 1,
    });
    const facility = await http().get(`/facilities/${facilityId}`).set(auth).expect(200);
    const facilitySlug = facility.body.publicSlug as string;
    const outsider = await registerVerifiedUser(app, 'mkf-visits-b');
    const foreign = await createFacilityWithUnits(app, outsider.accessToken, { unitsCount: 1 });

    const event = (body: Record<string, unknown>) =>
      http()
        .post(`/public/landing/${owner.slug}/events`)
        .set('User-Agent', UA)
        .send(body)
        .expect(204);
    const a = { visitorId: 'mkf-visitor-a-0001', source: 'google', medium: 'organic' };
    await event({ ...a, kind: 'page_view', path: `/s/${owner.slug}` });
    await event({ ...a, kind: 'page_view', path: `/book/${owner.slug}` });
    await event({
      ...a,
      kind: 'booking_start',
      path: `/book/${owner.slug}`,
      facilityId,
      unitTypeId,
    });
    // Un local de otro negocio no cuenta.
    await event({
      ...a,
      kind: 'booking_start',
      path: `/book/${owner.slug}`,
      facilityId: foreign.facilityId,
      unitTypeId: foreign.unitTypeId,
    });
    const b = { visitorId: 'mkf-visitor-b-0002' };
    await event({ ...b, kind: 'page_view', path: `/s/${owner.slug}/${facilitySlug}` });
    await event({ ...b, kind: 'whatsapp_click', path: `/s/${owner.slug}/${facilitySlug}` });

    const report = (await http().get('/marketing/web-analytics?days=7').set(auth).expect(200))
      .body as WebAnalyticsDto;
    expect(report.bookingFunnel).toMatchObject({ visitors: 2, bookingPage: 1, started: 1 });
    expect(report).toMatchObject({ newVisitors: 2, returningVisitors: 0 });
    expect(report.demand).toEqual([
      expect.objectContaining({
        facilityId,
        pageViews: 1,
        bookingStarts: 1,
        sizes: [expect.objectContaining({ unitTypeId, bookingStarts: 1 })],
      }),
    ]);
    expect(report.contactHours.reduce((n, h) => n + h.whatsapp, 0)).toBe(1);

    // Notas en la gráfica.
    const note = await http()
      .post('/marketing/web-analytics/annotations')
      .set(auth)
      .send({ day: madridToday(), text: 'Buzoneo en el barrio' })
      .expect(201);
    expect(note.body).toMatchObject({ kind: 'manual', text: 'Buzoneo en el barrio' });
    const withNote = (await http().get('/marketing/web-analytics?days=7').set(auth).expect(200))
      .body as WebAnalyticsDto;
    expect(withNote.annotations.some((n) => n.id === note.body.id)).toBe(true);
    // Otro negocio no la puede borrar.
    await http()
      .delete(`/marketing/web-analytics/annotations/${note.body.id}`)
      .set({ Authorization: `Bearer ${outsider.accessToken}` })
      .expect(404);
    await http()
      .delete(`/marketing/web-analytics/annotations/${note.body.id}`)
      .set(auth)
      .expect(204);
    const gone = await http()
      .delete(`/marketing/web-analytics/annotations/${note.body.id}`)
      .set(auth)
      .expect(404);
    expect(gone.body.code).toBe('annotation_not_found');
  });

  it('conversiones: el contrato firmado de quien llegó por un anuncio se devuelve a Google y a Meta', async () => {
    const owner = await registerVerifiedUser(app, 'mkf-conv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
      pricePerUnit: 60,
    });
    await http()
      .put('/settings/marketing/google-ads')
      .set(auth)
      .send({
        clientId: 'client-abc',
        clientSecret: 'super-secret-1',
        developerToken: 'dev-token-1',
        refreshToken: 'refresh-token-1',
        customerId: '123-456-7890',
        conversionActionId: '987654321',
        enabled: true,
      })
      .expect(200);
    await http()
      .put('/settings/marketing/meta-ads')
      .set(auth)
      .send({
        accessToken: 'meta-token-xyz',
        adAccountId: '999888777',
        pixelId: '555666777',
        enabled: true,
      })
      .expect(200);

    await bookAndSign(owner.slug, {
      facilityId,
      unitTypeId,
      email: `mkf-conv-ok-${Date.now()}@e2e.local`,
      utmSource: 'google',
      utmMedium: 'cpc',
      clickIds: { gclid: 'gclid-ok-123', fbclid: 'fbclid-ok-456', at: Date.now() },
    });
    // Sin identificadores de clic (no aceptó las cookies): no se envía nada.
    await bookAndSign(owner.slug, {
      facilityId,
      unitTypeId,
      email: `mkf-conv-none-${Date.now()}@e2e.local`,
      utmSource: 'google',
      utmMedium: 'cpc',
    });

    const conversions = app.get(AdConversionsService);
    expect(await conversions.runTenant(owner.tenantId)).toEqual({ sent: 2, failed: 0 });
    // Una sola vez por contrato y plataforma.
    expect(await conversions.runTenant(owner.tenantId)).toEqual({ sent: 0, failed: 0 });
    const uploads = await db.adConversionUpload.findMany({ where: { tenantId: owner.tenantId } });
    expect(uploads.map((u) => [u.platform, u.status, Number(u.value)]).sort()).toEqual([
      ['google_ads', 'sent', 60],
      ['meta', 'sent', 60],
    ]);

    // Un clic que la plataforma no reconoce queda como fallido, con el motivo.
    await bookAndSign(owner.slug, {
      facilityId,
      unitTypeId,
      email: `mkf-conv-fail-${Date.now()}@e2e.local`,
      clickIds: { gclid: 'fail-gclid-1' },
    });
    expect(await conversions.runTenant(owner.tenantId)).toEqual({ sent: 0, failed: 1 });
    const google = (await http().get('/settings/marketing/google-ads').set(auth).expect(200))
      .body as GoogleAdsSettingsDto;
    expect(google.conversionActionId).toBe('987654321');
    expect(google.conversions).toMatchObject({ sent: 1, failed: 1 });
    expect(google.conversions.lastError).toContain('simulado');
    const meta = (await http().get('/settings/marketing/meta-ads').set(auth).expect(200))
      .body as MetaAdsSettingsDto;
    expect(meta).toMatchObject({ pixelId: '555666777', conversions: { sent: 1, failed: 0 } });

    // Al cambiar los ajustes, los fallidos se vuelven a intentar.
    await http()
      .put('/settings/marketing/google-ads')
      .set(auth)
      .send({ conversionActionId: '987654322', enabled: true })
      .expect(200);
    expect(
      await db.adConversionUpload.count({
        where: { tenantId: owner.tenantId, status: 'failed' },
      }),
    ).toBe(0);
    expect(await conversions.runTenant(owner.tenantId)).toEqual({ sent: 0, failed: 1 });
  });

  it('Meta: «Conectar con Facebook» comprueba el estado firmado y conecta con la vuelta', async () => {
    const owner = await registerVerifiedUser(app, 'mkf-oauth');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    // Sin la app de Meta configurada en la plataforma, se pega el token.
    const settings = await http().get('/marketing/social').set(auth).expect(200);
    expect(settings.body.oauthAvailable).toBe(false);
    const start = await http().get('/marketing/social/oauth/start').set(auth).expect(400);
    expect(start.body.code).toBe('social_oauth_unavailable');

    const key = oauthStateKey(app.get(ConfigService).get<string>('MASTER_ENCRYPTION_KEY')!);
    const callback = (query: string) =>
      http().get(`/marketing/social/oauth/callback?${query}`).expect(302);

    // Estado inventado o caducado: no se conecta nada.
    const forged = await callback('code=abc123&state=xxx');
    expect(forged.headers.location).toContain('oauth_error=state');
    const expired = buildOauthState(
      key,
      owner.tenantId,
      owner.userId,
      60_000,
      Date.now() - 120_000,
    );
    expect((await callback(`code=abc123&state=${expired}`)).headers.location).toContain(
      'oauth_error=state',
    );
    const state = buildOauthState(key, owner.tenantId, owner.userId);
    const cancelled = await callback(`error=access_denied&state=${state}`);
    expect(cancelled.headers.location).toContain('oauth_error=cancelled');

    const ok = await callback(`code=abc123&state=${state}`);
    const back = new URL(ok.headers.location as string);
    expect(back.pathname).toBe('/marketing/social');
    const oauthKey = back.searchParams.get('oauth')!;
    expect(oauthKey).toMatch(/^[A-Za-z0-9_-]{20,64}$/);

    // La sesión de la vuelta es solo de ese negocio.
    const outsider = await registerVerifiedUser(app, 'mkf-oauth-b');
    await setTenantFeatureOverride(outsider.slug, 'web_premium', true);
    const stolen = await http()
      .put('/marketing/social')
      .set({ Authorization: `Bearer ${outsider.accessToken}` })
      .send({ oauthKey })
      .expect(400);
    expect(stolen.body.code).toBe('social_oauth_expired');

    const connected = await http()
      .put('/marketing/social')
      .set(auth)
      .send({ oauthKey })
      .expect(200);
    expect(connected.body).toMatchObject({ connected: true, pageId: '100200300' });
    // Se usa una vez.
    await http().put('/marketing/social').set(auth).send({ oauthKey }).expect(400);
  });

  it('avisos: presupuesto superado, gasto sin reservas y conexión rota', async () => {
    const owner = await registerVerifiedUser(app, 'mkf-alerts');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const month = madridToday().slice(0, 7);
    const channel = (
      await http()
        .post('/marketing/channels')
        .set(auth)
        .send({ type: 'other', name: 'Radio local', utmSourceMatch: 'radio', monthlyBudget: 20 })
        .expect(201)
    ).body as MarketingChannelDto;
    await http()
      .post('/expenses')
      .set(auth)
      .send({
        category: 'marketing',
        description: 'Cuña de radio',
        amount: 50,
        expenseDate: `${month}-02`,
        marketingChannelId: channel.id,
      })
      .expect(201);

    // A mitad de mes: pasado de presupuesto y sin ninguna reserva.
    const cron = app.get(MarketingRenewalsCron);
    const midMonth = new Date(`${month}-20T12:00:00Z`);
    await cron.runBudgets(midMonth);
    await cron.runBudgets(midMonth);
    const notices = await db.notification.findMany({
      where: {
        tenantId: owner.tenantId,
        type: { in: ['marketing.channel_over_budget', 'marketing.channel_no_results'] },
      },
    });
    expect(notices.map((n) => n.type).sort()).toEqual([
      'marketing.channel_no_results',
      'marketing.channel_over_budget',
    ]);

    // Google Analytics deja de funcionar: un aviso hasta que vuelva a ir bien.
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { googleAnalyticsId: 'G-123456789' },
    });
    await http()
      .put('/marketing/ga4')
      .set(auth)
      .send({ propertyId: 'properties/123456789' })
      .expect(200);
    await db.tenantGa4.update({
      where: { tenantId: owner.tenantId },
      data: { propertyId: '403403403' },
    });
    const ga4 = app.get(Ga4Service);
    await ga4.syncAllDue();
    await ga4.syncAllDue();
    const broken = () =>
      db.notification.count({
        where: { tenantId: owner.tenantId, type: 'marketing.connection_broken' },
      });
    expect(await broken()).toBe(1);
    // Vuelve a funcionar y, si se rompe otra vez, se avisa de nuevo.
    await db.tenantGa4.update({
      where: { tenantId: owner.tenantId },
      data: { propertyId: '123456789' },
    });
    await ga4.syncAllDue();
    expect(
      (await db.tenantGa4.findUniqueOrThrow({ where: { tenantId: owner.tenantId } }))
        .errorNotifiedAt,
    ).toBeNull();
    await db.tenantGa4.update({
      where: { tenantId: owner.tenantId },
      data: { propertyId: '403403403' },
    });
    await ga4.syncAllDue();
    expect(await broken()).toBe(2);
  });
});
