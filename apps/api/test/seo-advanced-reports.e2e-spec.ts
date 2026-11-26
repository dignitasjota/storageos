import { hash as argonHash } from '@node-rs/argon2';
import { shiftDate } from '@storageos/shared';
import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { seoAdvancedReplaces } from '../src/modules/search-console/seo-advanced-overlap';
import { SeoReportsService } from '../src/modules/seo-advanced/reports/seo-reports.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { waitForEmail } from './helpers/mailpit';
import {
  cleanupTenantsById,
  setTenantFeatureOverride,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const SUPER_EMAIL = 'seo-reports-super@storageos.local';
const SUPPORT_EMAIL = 'seo-reports-support@storageos.local';
const PREFIX = 'E2E informes ';
const PLATFORM_DOMAIN = 'e2e-informes-seo.es';
const EXTRA_EMAIL = 'seo-informe-agencia@e2e.local';
const DEMO_EMAIL = 'seo-informes-demo@e2e.local';

/** Hoy en hora de España (las conversiones se cuentan por ese día). */
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** Espera a que no queden descargas de Search Console en cola ni en curso del tenant. */
async function waitIdle(tenantId: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const n = await withAdminDb((db) =>
      db.seoSyncRun.count({ where: { tenantId, status: { in: ['queued', 'running'] } } }),
    );
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('las descargas no terminaron');
}

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`login ${res.status}`);
  return res.body.accessToken as string;
}

/** Filas de Search Console de un dominio (las del cruce `site` y las que se pasen). */
function metric(
  domainId: string,
  tenantId: string | null,
  grain: string,
  date: string,
  extra: object,
) {
  return {
    tenantId,
    domainId,
    grain,
    date: asDate(date),
    query: '',
    page: '',
    device: '',
    country: '',
    ctr: 0,
    position: 8,
    ...extra,
  };
}

describe('SEO Avanzado: conversiones, alertas e informes (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  let superId = '';
  const http = () => request(app.getHttpServer());
  const asSuper = () => ({ Authorization: `Bearer ${superToken}` });
  const asSupport = () => ({ Authorization: `Bearer ${supportToken}` });
  const tenantIds: string[] = [];
  let platformProject = '';
  let platformDomain = '';
  let owner: VerifiedUser;
  let other: VerifiedUser;
  let tenantProject = '';
  let tenantDomain = '';

  async function cleanupPlatform(): Promise<void> {
    await withAdminDb(async (db) => {
      await db.seoProject.deleteMany({ where: { tenantId: null, name: { startsWith: PREFIX } } });
      await db.platformLead.deleteMany({ where: { email: DEMO_EMAIL } });
      await db.platformContactMessage.deleteMany({ where: { email: DEMO_EMAIL } });
      await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    });
  }

  beforeAll(async () => {
    await cleanupPlatform();
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb(async (db) => {
      superId = (
        await db.superAdmin.create({
          data: {
            email: SUPER_EMAIL,
            passwordHash,
            fullName: 'Super Informes',
            role: 'superadmin',
          },
        })
      ).id;
      await db.superAdmin.create({
        data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Informes', role: 'support' },
      });
    });
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);

    // Proyecto de la plataforma: dos semanas de Search Console (60 días de historia).
    const created = await http()
      .post('/admin/seo/projects')
      .set(asSuper())
      .send({ name: `${PREFIX}plataforma`, strategy: 'national' });
    expect(created.status).toBe(201);
    platformProject = created.body.id;
    platformDomain = (
      await withAdminDb((db) =>
        db.seoProjectDomain.create({
          data: {
            projectId: platformProject,
            domain: PLATFORM_DOMAIN,
            role: 'primary',
            gscProperty: `sc-domain:${PLATFORM_DOMAIN}`,
            dataUntil: asDate(TODAY),
          },
        }),
      )
    ).id;
    const rows: object[] = [];
    for (let d = shiftDate(TODAY, -60); d <= TODAY; d = shiftDate(d, 1)) {
      // La última semana, de 100 clics al día a 20: caída del 80 %.
      const clicks = d > shiftDate(TODAY, -7) ? 20 : 100;
      rows.push(metric(platformDomain, null, 'site', d, { clicks, impressions: 2000 }));
    }
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: rows as Parameters<typeof db.seoGscMetric.createMany>[0]['data'],
      }),
    );

    // El negocio con SEO Avanzado y otro sin el extra.
    owner = await registerVerifiedUser(app, 'seorepa');
    other = await registerVerifiedUser(app, 'seorepb');
    tenantIds.push(owner.tenantId, other.tenantId);
    await setTenantFeatureOverride(owner.slug, 'seo_advanced', true);
    await setVerifiedCustomDomain(owner.slug, `web.${owner.slug}.es`);
    const project = await http()
      .post('/seo-advanced/project')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({});
    expect(project.status).toBe(201);
    tenantProject = project.body.id;
    tenantDomain = await withAdminDb(async (db) => {
      const found = await db.seoProjectDomain.findFirst({
        where: { projectId: tenantProject, role: 'primary' },
      });
      if (found) return found.id;
      return (
        await db.seoProjectDomain.create({
          data: {
            tenantId: owner.tenantId,
            projectId: tenantProject,
            domain: `web.${owner.slug}.es`,
            role: 'primary',
            gscProperty: `sc-domain:web.${owner.slug}.es`,
          },
        })
      ).id;
    });
    // La carga inicial (simulada) termina y se quitan sus filas: las de la prueba, a mano.
    await waitIdle(owner.tenantId);
    await withAdminDb((db) => db.seoGscMetric.deleteMany({ where: { domainId: tenantDomain } }));
    const domain = await withAdminDb((db) =>
      db.seoProjectDomain.findUniqueOrThrow({ where: { id: tenantDomain } }),
    );
    const page = (path: string) => `https://${domain.domain}${path}`;
    const tRows: object[] = [];
    for (let d = shiftDate(TODAY, -60); d <= TODAY; d = shiftDate(d, 1)) {
      tRows.push(metric(tenantDomain, owner.tenantId, 'site', d, { clicks: 10, impressions: 300 }));
      tRows.push(
        metric(tenantDomain, owner.tenantId, 'page', d, {
          page: page('/precios'),
          clicks: 5,
          impressions: 100,
        }),
      );
      tRows.push(
        metric(tenantDomain, owner.tenantId, 'query_page', d, {
          query: 'precio trastero',
          page: page('/precios'),
          clicks: 3,
          impressions: 60,
        }),
      );
      tRows.push(
        metric(tenantDomain, owner.tenantId, 'query_page', d, {
          query: 'trasteros baratos',
          page: page('/Precios/'),
          clicks: 1,
          impressions: 40,
        }),
      );
    }
    await withAdminDb((db) =>
      db.seoGscMetric.createMany({
        data: tRows as Parameters<typeof db.seoGscMetric.createMany>[0]['data'],
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await cleanupPlatform();
    await cleanupTenantsById(tenantIds);
  });

  it('conversiones: solo lo que llega de Google sin anuncios, por página de entrada', async () => {
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local SEO',
      unitsCount: 3,
    });
    const book = (email: string, doc: string, utm: object) =>
      http()
        .post(`/public/move-in/book/${owner.slug}`)
        .send({
          facilityId,
          unitTypeId,
          startDate: TODAY,
          customer: {
            firstName: 'Ana',
            lastName: 'García',
            email,
            phone: '600000000',
            documentNumber: doc,
          },
          ...utm,
        });
    // Desde Google (orgánico): cuenta, por su página de entrada.
    const organic = await book(`organica-${owner.slug}@e2e.local`, '12345678Z', {
      utmSource: 'google',
      utmMedium: 'organic',
      landingPath: '/s/' + owner.slug + '/Precios?utm_source=google',
    });
    expect(organic.status).toBe(201);
    // Desde un anuncio de Google y desde Instagram: no cuentan.
    expect(
      (
        await book(`anuncio-${owner.slug}@e2e.local`, '00000000T', {
          utmSource: 'google',
          utmMedium: 'cpc',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await book(`insta-${owner.slug}@e2e.local`, '11111111H', {
          utmSource: 'instagram',
          utmMedium: 'social',
          landingPath: '/precios',
        })
      ).status,
    ).toBe(201);
    // Firma la reserva de Google.
    const token = organic.body.signingToken as string;
    const signed = await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      });
    expect(signed.status).toBe(201);
    // Lista de espera desde Google (con su página de entrada guardada).
    const waitlist = await http()
      .post(`/public/waitlist/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        contactName: 'Luis',
        contactEmail: `espera-${owner.slug}@e2e.local`,
        utmSource: 'google',
        landingPath: '/trasteros-en-mislata',
      });
    expect([200, 201]).toContain(waitlist.status);

    // La atribución quedó guardada.
    const lead = await withAdminDb((db) =>
      db.lead.findFirst({
        where: { tenantId: owner.tenantId, email: `organica-${owner.slug}@e2e.local` },
      }),
    );
    expect(lead?.landingPath).toBe(`/s/${owner.slug}/Precios?utm_source=google`);

    const recalc = await http().post('/seo-advanced/conversions/recalc').set(a);
    expect(recalc.status).toBe(200);
    // Repetir no duplica.
    expect((await http().post('/seo-advanced/conversions/recalc').set(a)).status).toBe(200);
    const rows = await withAdminDb((db) =>
      db.seoConversionDaily.findMany({ where: { projectId: tenantProject } }),
    );
    expect(rows.every((r) => r.tenantId === owner.tenantId)).toBe(true);

    const res = await http().get('/seo-advanced/conversions?period=28d').set(a);
    expect(res.status).toBe(200);
    const count = (type: string) =>
      (res.body.types as { type: string; count: number }[]).find((t) => t.type === type)?.count;
    expect(res.body.scope).toBe('tenant');
    expect(count('booking_started')).toBe(1);
    expect(count('booking_signed')).toBe(1);
    expect(count('waitlist')).toBe(1);
    expect(res.body.primary.count).toBe(2);
    expect(res.body.complete).toBe(true);
    const precios = (
      res.body.pages as { landing: string; clicks: number; conversions: number }[]
    ).find((p) => p.landing === '/precios');
    expect(precios).toMatchObject({ conversions: 1, clicks: 140 });
    expect(
      (res.body.pages as { landing: string }[]).some((p) => p.landing === '/trasteros-en-mislata'),
    ).toBe(true);
    // Por búsqueda, estimado: 3 de cada 4 clics de /precios vienen de «precio trastero».
    const q = res.body.queries as { query: string; conversions: number }[];
    expect(q.find((x) => x.query === 'precio trastero')?.conversions).toBe(0.75);
    expect(q.find((x) => x.query === 'trasteros baratos')?.conversions).toBe(0.25);
  });

  it('plataforma: demos y altas desde Google, solo en el proyecto que cuenta trasteros.pro', async () => {
    const demo = await http().post('/platform-contact').send({
      kind: 'demo',
      name: 'Demo SEO',
      email: DEMO_EMAIL,
      acceptPrivacy: true,
      utmSource: 'google',
      utmMedium: 'organic',
      landingPath: '/software-trasteros',
    });
    expect([200, 201, 204]).toContain(demo.status);
    const msg = await withAdminDb((db) =>
      db.platformContactMessage.findFirst({ where: { email: DEMO_EMAIL } }),
    );
    expect(msg).toMatchObject({
      kind: 'demo',
      utmSource: 'google',
      landingPath: '/software-trasteros',
    });

    // Sin marcarlo, el proyecto de prueba no es trasteros.pro: no cuenta nada.
    let res = await http()
      .get(`/admin/seo/projects/${platformProject}/conversions?period=28d`)
      .set(asSuper());
    expect(res.body.scope).toBeNull();
    // El soporte no lo puede marcar; el super admin, sí.
    expect(
      (
        await http()
          .put(`/admin/seo/projects/${platformProject}/conversions/settings`)
          .set(asSupport())
          .send({ platformConversions: true })
      ).status,
    ).toBe(403);
    const set = await http()
      .put(`/admin/seo/projects/${platformProject}/conversions/settings`)
      .set(asSuper())
      .send({ platformConversions: true });
    expect(set.status).toBe(200);
    res = await http()
      .get(`/admin/seo/projects/${platformProject}/conversions?period=28d`)
      .set(asSuper());
    expect(res.body.scope).toBe('platform');
    const page = (res.body.pages as { landing: string; byType: Record<string, number> }[]).find(
      (p) => p.landing === '/software-trasteros',
    );
    expect(page?.byType.demo_request).toBeGreaterThanOrEqual(1);
  });

  it('alertas: la caída de clics avisa una vez, se silencia y se resuelve sola', async () => {
    const base = `/admin/seo/projects/${platformProject}/alerts`;
    // El soporte lee pero no comprueba.
    expect((await http().post(`${base}/check`).set(asSupport())).status).toBe(403);
    // (Solo se mira la de clics: en una base compartida puede haber avisos de SISTRIX de la plataforma.)
    const drops = `${base}?type=clicks_drop`;
    const first = await http().post(`${base}/check`).set(asSuper());
    expect(first.status).toBe(200);
    expect(first.body.created).toBeGreaterThanOrEqual(1);
    let list = await http().get(drops).set(asSupport());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const alert = list.body.items[0] as { id: string; type: string; title: string; status: string };
    expect(alert.status).toBe('open');
    expect(alert.type).toBe('clicks_drop');
    expect(alert.title).toContain('80 %');
    const notices = () =>
      withAdminDb((db) =>
        db.superAdminNotification.count({
          where: { type: 'seo.alert', link: `/admin/seo/${platformProject}#alertas` },
        }),
      );
    expect(await notices()).toBe(1);

    // No se repite mientras siga abierta.
    expect((await http().post(`${base}/check`).set(asSuper())).body.created).toBe(0);
    expect(await notices()).toBe(1);
    expect((await http().get(drops).set(asSuper())).body.items).toHaveLength(1);

    // Silenciada: sigue ahí, sin contar como abierta.
    const silenced = await http()
      .post(`${base}/${alert.id}/silence`)
      .set(asSuper())
      .send({ days: 3 });
    expect(silenced.status).toBe(200);
    expect(silenced.body.status).toBe('silenced');
    await http().post(`${base}/check`).set(asSuper());
    list = await http().get(`${drops}&status=silenced`).set(asSuper());
    expect(list.body.items).toHaveLength(1);
    expect((await http().get(`${drops}&status=open`).set(asSuper())).body.items).toHaveLength(0);

    // Vuelven los clics: se resuelve sola.
    await withAdminDb((db) =>
      db.seoGscMetric.updateMany({
        where: {
          domainId: platformDomain,
          grain: 'site',
          date: { gt: asDate(shiftDate(TODAY, -7)) },
        },
        data: { clicks: 100 },
      }),
    );
    const again = await http().post(`${base}/check`).set(asSuper());
    expect(again.body.resolved).toBeGreaterThanOrEqual(1);
    const resolved = await http().get(`${drops}&status=resolved`).set(asSuper());
    expect(resolved.body.items[0]).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });
    expect(await notices()).toBe(1);

    // Ajustes: la regla apagada no avisa.
    const settings = await http()
      .put(`${base}/settings`)
      .set(asSuper())
      .send({ disabled: ['clicks_drop'], thresholds: { clicksDropPct: 40 } });
    expect(settings.status).toBe(200);
    expect(settings.body.thresholds.clicksDropPct).toBe(40);
  });

  it('informe semanal: PDF en el bucket privado, correo con el enlace y sin duplicar', async () => {
    const base = `/admin/seo/projects/${platformProject}/reports`;
    const set = await http()
      .put(`${base}/settings`)
      .set(asSuper())
      .send({ weekly: true, recipientIds: [superId], extraEmails: [EXTRA_EMAIL] });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ weekly: true, extraEmails: [EXTRA_EMAIL] });

    const reports = app.get(SeoReportsService);
    const run = await reports.sendDueAll('weekly');
    expect(run.sent).toBeGreaterThanOrEqual(1);
    const mail = await waitForEmail(EXTRA_EMAIL, { subjectIncludes: 'Informe semanal' });
    expect(mail.HTML).toContain('X-Amz-Signature');
    expect(mail.Text).toContain('Descargar el informe');

    // Repetir el cron no lo vuelve a enviar.
    await reports.sendDueAll('weekly');
    const cron = await withAdminDb((db) =>
      db.seoReport.findMany({ where: { projectId: platformProject, trigger: 'cron' } }),
    );
    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatchObject({ status: 'sent', kind: 'weekly' });
    expect(cron[0]?.recipients.sort()).toEqual([EXTRA_EMAIL, SUPER_EMAIL].sort());

    const list = await http().get(base).set(asSupport());
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ hasPdf: true, status: 'sent' });
    const pdf = await http().get(`${base}/${list.body.items[0].id}/pdf`).set(asSupport());
    expect(pdf.status).toBe(200);
    expect(pdf.body.url).toContain('seo-reports');

    // «Ver el informe».
    const preview = await http().get(`${base}/preview?kind=weekly`).set(asSupport());
    expect(preview.status).toBe(200);
    expect(preview.body.period.kind).toBe('weekly');
    expect(Array.isArray(preview.body.highlights)).toBe(true);
    // El soporte no envía.
    expect(
      (await http().post(`${base}/send`).set(asSupport()).send({ kind: 'weekly' })).status,
    ).toBe(403);
  });

  it('tenant: «Enviármelo ahora» y su informe sustituye al de SEO local', async () => {
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const sent = await http().post('/seo-advanced/reports/send').set(a).send({ kind: 'weekly' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      status: 'sent',
      trigger: 'manual',
      recipients: [owner.email],
    });
    await waitForEmail(owner.email, { subjectIncludes: 'Informe semanal de SEO' });

    // Con el informe mensual del proyecto, el de SEO local no le llega.
    const admin = app.get(PrismaAdminService);
    expect(await seoAdvancedReplaces(admin, owner.tenantId, 'monthly_report')).toBe(true);
    expect(await seoAdvancedReplaces(admin, owner.tenantId, 'clicks_drop')).toBe(true);
    await http().put('/seo-advanced/reports/settings').set(a).send({ monthly: false });
    expect(await seoAdvancedReplaces(admin, owner.tenantId, 'monthly_report')).toBe(false);
    expect(await seoAdvancedReplaces(admin, other.tenantId, 'monthly_report')).toBe(false);
  });

  it('aislamiento entre tenants y el soporte en solo lectura', async () => {
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    const b = { Authorization: `Bearer ${other.accessToken}` };
    // Sin el extra, nada.
    expect((await http().get('/seo-advanced/alerts').set(b)).status).toBe(403);
    expect((await http().get('/seo-advanced/conversions').set(b)).status).toBe(403);
    // El tenant no entra en lo de la plataforma.
    expect((await http().get(`/admin/seo/projects/${platformProject}/alerts`).set(a)).status).toBe(
      401,
    );
    const platformAlert = await withAdminDb((db) =>
      db.seoAlert.findFirst({ where: { projectId: platformProject } }),
    );
    expect(
      (await http().post(`/seo-advanced/alerts/${platformAlert!.id}/resolve`).set(a)).status,
    ).toBe(404);
    // El soporte lee lo del tenant; el super admin no lo cambia.
    const tBase = `/admin/seo/projects/${tenantProject}`;
    expect((await http().get(`${tBase}/conversions`).set(asSupport())).status).toBe(200);
    expect((await http().get(`${tBase}/alerts`).set(asSupport())).status).toBe(200);
    expect((await http().get(`${tBase}/reports`).set(asSupport())).status).toBe(200);
    expect(
      (await http().put(`${tBase}/reports/settings`).set(asSuper()).send({ weekly: true })).status,
    ).toBe(404);
    expect((await http().post(`${tBase}/alerts/check`).set(asSuper())).status).toBe(404);
  });

  it('lo de hoy se cuenta aunque Google vaya por detrás; la tasa usa solo sus días', async () => {
    const a = { Authorization: `Bearer ${owner.accessToken}` };
    // Google solo tiene datos hasta anteayer.
    await withAdminDb((db) =>
      db.seoGscMetric.deleteMany({
        where: { domainId: tenantDomain, date: { gt: asDate(shiftDate(TODAY, -2)) } },
      }),
    );
    const res = await http().get('/seo-advanced/conversions?period=7d').set(a);
    expect(res.status).toBe(200);
    // Los recuentos llegan hasta hoy: la reserva de hoy sale.
    expect(res.body.to).toBe(TODAY);
    expect(res.body.lastDataDate).toBe(shiftDate(TODAY, -2));
    const count = (type: string) =>
      (res.body.types as { type: string; count: number }[]).find((t) => t.type === type)?.count;
    expect(count('booking_started')).toBe(1);
    expect(res.body.primary.count).toBe(2);
    // La tasa: del primer día a anteayer (5 días), con las conversiones de esos días.
    expect(res.body.rateFrom).toBe(shiftDate(TODAY, -6));
    expect(res.body.rateTo).toBe(shiftDate(TODAY, -2));
    expect(res.body.primary).toMatchObject({ clicks: 50, rateCount: 0, rate: 0 });
    // Por página: conversiones hasta hoy, clics y tasa de los días de Google.
    const precios = (
      res.body.pages as { landing: string; clicks: number; conversions: number; rate: number }[]
    ).find((p) => p.landing === '/precios');
    expect(precios).toMatchObject({ conversions: 1, clicks: 25, rate: 0 });
    // A mano hasta hoy: no se recorta al último día de Google.
    const custom = await http()
      .get(`/seo-advanced/conversions?period=custom&from=${shiftDate(TODAY, -6)}&to=${TODAY}`)
      .set(a);
    expect(custom.body.to).toBe(TODAY);
    expect(custom.body.primary.count).toBe(2);
  });
});
