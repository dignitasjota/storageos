import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformLeadsService } from '../src/modules/admin/leads/platform-leads.service';

import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { PlatformLeadDetailDto } from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const SUPER = 'admin-leads-super@storageos.local';
const SUPPORT = 'admin-leads-support@storageos.local';
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Leads del panel admin: entran por el formulario de la web, a mano o al
 * registrarse; el equipo los trabaja (fases, actividad, seguimientos, correo,
 * propuesta) y pasan a «En prueba» con su cuenta y a «Cliente» al pagar.
 */
describe('Leads del panel admin (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let supportToken: string;
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function login(email: string): Promise<string> {
    const res = await http().post('/admin/auth/login').send({ email, password: 'AdminTest!23' });
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [SUPER, SUPPORT] } } });
    const passwordHash = await argonHash('AdminTest!23');
    await db.superAdmin.createMany({
      data: [
        { email: SUPER, passwordHash, fullName: 'Ana Ventas', role: 'superadmin' },
        { email: SUPPORT, passwordHash, fullName: 'Sergio Soporte', role: 'support' },
      ],
    });
    app = await createTestApp();
    token = await login(SUPER);
    supportToken = await login(SUPPORT);
  });

  afterAll(async () => {
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: { in: [SUPER, SUPPORT] } } });
    await db.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function detail(id: string): Promise<PlatformLeadDetailDto> {
    const res = await http().get(`/admin/leads/${id}`).set(auth()).expect(200);
    return res.body as PlatformLeadDetailDto;
  }

  it('el formulario de la web crea el lead y un segundo mensaje se suma a él', async () => {
    await http()
      .put('/admin/platform/contact')
      .set(auth())
      .send({
        enabled: true,
        email: 'ventas-leads@e2e.local',
        title: 'Hablemos',
        subtitle: '',
        showPhone: true,
        requirePhone: false,
        showCompany: true,
        showUnits: true,
        showProfile: true,
      })
      .expect(200);
    const email = `web-${stamp()}@e2e.local`;
    await http()
      .post('/platform-contact')
      .send({
        name: 'Marta Web',
        email,
        company: 'Trasteros Marta',
        units: '150',
        message: 'Quiero ver una demo del programa, tengo dos locales.',
        acceptPrivacy: true,
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'marca',
      })
      .expect(204);
    await http()
      .post('/platform-contact')
      .send({
        name: 'Marta Web',
        email: email.toUpperCase(),
        message: 'Os vuelvo a escribir: ¿tenéis precio para dos locales?',
        acceptPrivacy: true,
      })
      .expect(204);
    const leads = await db.platformLead.findMany({ where: { email } });
    expect(leads).toHaveLength(1);
    const lead = await detail(leads[0]!.id);
    expect(lead).toEqual(
      expect.objectContaining({
        status: 'new',
        source: 'web_contact',
        companyName: 'Trasteros Marta',
        units: '150',
        utmSource: 'google',
        utmCampaign: 'marca',
      }),
    );
    expect(lead.activities.filter((a) => a.type === 'web_form')).toHaveLength(2);

    const today = await http().get('/admin/today').set(auth()).expect(200);
    expect(today.body.newLeads.some((l: { id: string }) => l.id === lead.id)).toBe(true);

    const board = await http()
      .get(`/admin/leads?search=${encodeURIComponent('Trasteros Marta')}`)
      .set(auth())
      .expect(200);
    expect(board.body.items.map((i: { id: string }) => i.id)).toEqual([lead.id]);
    expect(board.body.counts.new).toBe(1);
  });

  it('alta a mano, duplicado, fases, actividad, seguimientos, perder y reabrir', async () => {
    const email = `feria-${stamp()}@e2e.local`;
    const created = await http()
      .post('/admin/leads')
      .set(auth())
      .send({
        companyName: 'Guardamuebles Feria',
        contactName: 'Pedro Feria',
        email,
        phone: '+34 611 22 33 44',
        source: 'event',
        units: '80',
        currentSoftware: 'Excel',
        message: 'Le conocimos en la feria de Madrid.',
      })
      .expect(201);
    const lead = created.body as PlatformLeadDetailDto;
    expect(lead.status).toBe('new');
    expect(lead.assignedToName).toBe('Ana Ventas');
    expect(lead.activities[0]?.type).toBe('note');

    // Mismo teléfono escrito de otra forma: ya existe.
    const dup = await http()
      .post('/admin/leads')
      .set(auth())
      .send({ contactName: 'Otro', phone: '611223344', source: 'phone' })
      .expect(409);
    expect(dup.body.code).toBe('lead_exists');
    expect(dup.body.details.leadId).toBe(lead.id);

    // Una llamada lo pasa a «Contactado» y cuenta como primera respuesta.
    const called = await http()
      .post(`/admin/leads/${lead.id}/activities`)
      .set(auth())
      .send({ type: 'call', content: 'Le interesa, pide propuesta para 80 trasteros.' })
      .expect(201);
    expect(called.body.status).toBe('contacted');
    expect(called.body.firstResponseAt).toBeTruthy();

    const moved = await http()
      .post(`/admin/leads/${lead.id}/move`)
      .set(auth())
      .send({ status: 'interested' })
      .expect(200);
    expect(moved.body.status).toBe('interested');
    // «En prueba» la marca su cuenta, no se elige a mano.
    await http()
      .post(`/admin/leads/${lead.id}/move`)
      .set(auth())
      .send({ status: 'trial' })
      .expect(400);

    const withFollowup = await http()
      .post(`/admin/leads/${lead.id}/followups`)
      .set(auth())
      .send({ title: 'Llamar tras la demo', dueDate: '2026-01-10' })
      .expect(201);
    const followup = withFollowup.body.followups[0];
    expect(withFollowup.body.nextFollowup.title).toBe('Llamar tras la demo');
    const pending = await http().get('/admin/leads/followups?mine=1').set(auth()).expect(200);
    expect(pending.body.some((f: { id: string }) => f.id === followup.id)).toBe(true);
    const today = await http().get('/admin/today').set(auth()).expect(200);
    expect(today.body.leadFollowupsDue.some((f: { id: string }) => f.id === followup.id)).toBe(
      true,
    );
    await http()
      .patch(`/admin/leads/followups/${followup.id}`)
      .set(auth())
      .send({ status: 'done' })
      .expect(200);

    const lost = await http()
      .post(`/admin/leads/${lead.id}/lose`)
      .set(auth())
      .send({ reasonCode: 'price', reason: 'Le parece caro el plan', recontactOn: '2027-03-01' })
      .expect(200);
    expect(lost.body).toEqual(expect.objectContaining({ status: 'lost', lostReasonCode: 'price' }));
    expect(lost.body.nextFollowup).toEqual(
      expect.objectContaining({ title: 'Volver a contactar', dueDate: '2027-03-01' }),
    );
    const reopened = await http().post(`/admin/leads/${lead.id}/reopen`).set(auth()).expect(200);
    expect(reopened.body).toEqual(
      expect.objectContaining({ status: 'contacted', lostReasonCode: null }),
    );

    // Las notas se borran; los avisos automáticos, no.
    const system = reopened.body.activities.find((a: { type: string }) => a.type === 'system');
    await http().delete(`/admin/leads/${lead.id}/activities/${system.id}`).set(auth()).expect(400);

    // Soporte trabaja los leads pero no los borra.
    await http()
      .post(`/admin/leads/${lead.id}/move`)
      .set({ Authorization: `Bearer ${supportToken}` })
      .send({ status: 'interested' })
      .expect(200);
    await http()
      .delete(`/admin/leads/${lead.id}`)
      .set({ Authorization: `Bearer ${supportToken}` })
      .expect(403);
    await http().delete(`/admin/leads/${lead.id}`).set(auth()).expect(204);
    expect(await db.platformLead.count({ where: { id: lead.id } })).toBe(0);
  });

  it('responder por correo lo pasa a contactado y «No es un lead» lo saca del tablero', async () => {
    const email = `correo-${stamp()}@e2e.local`;
    const created = await http()
      .post('/admin/leads')
      .set(auth())
      .send({ contactName: 'Lucía Correo', email, source: 'email' })
      .expect(201);
    const sent = await http()
      .post(`/admin/leads/${created.body.id}/email`)
      .set(auth())
      .send({ subject: 'Tu demo de TrasterOS', body: 'Hola Lucía, ¿te va bien el martes?' })
      .expect(200);
    expect(sent.body.status).toBe('contacted');
    const out = sent.body.activities.find((a: { type: string }) => a.type === 'email_out');
    expect(out).toEqual(expect.objectContaining({ subject: 'Tu demo de TrasterOS' }));
    const log = await db.platformEmailLog.findFirst({
      where: { recipient: email },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.subject).toBe('Tu demo de TrasterOS');

    await http().post(`/admin/leads/${created.body.id}/discard`).set(auth()).expect(204);
    const board = await http()
      .get(`/admin/leads?search=${encodeURIComponent('Lucía Correo')}`)
      .set(auth())
      .expect(200);
    expect(board.body.items).toHaveLength(0);
    await http().get(`/admin/leads/${created.body.id}`).set(auth()).expect(404);
  });

  it('al registrarse con el email de un lead se vincula; sin lead, entra en prueba', async () => {
    const s = stamp();
    const email = `registro-${s}@e2e.local`;
    const created = await http()
      .post('/admin/leads')
      .set(auth())
      .send({ companyName: 'Trasteros Registro', email, source: 'phone' })
      .expect(201);
    await http()
      .post('/auth/register')
      .send({
        tenantName: 'Trasteros Registro SL',
        tenantSlug: `test-lreg-${s}`,
        fullName: 'Rosa Registro',
        email,
        password: 'Secret123',
        acceptTerms: true,
      })
      .expect(201);
    const linked = await detail(created.body.id);
    expect(linked.status).toBe('trial');
    expect(linked.tenant?.slug).toBe(`test-lreg-${s}`);
    expect(linked.activities.some((a) => a.type === 'signup')).toBe(true);
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'platform_lead.signed_up', link: `/admin/leads?lead=${linked.id}` },
    });
    expect(notice).toBeTruthy();
    // En la ficha del tenant queda el enlace a su historial de lead.
    const note = await db.tenantInteraction.findFirst({
      where: { tenantId: linked.tenant!.id, link: `/admin/leads?lead=${linked.id}` },
    });
    expect(note).toBeTruthy();

    const s2 = stamp();
    await http()
      .post('/auth/register')
      .send({
        tenantName: 'Trasteros Nuevo',
        tenantSlug: `test-lnew-${s2}`,
        fullName: 'Nuevo Registro',
        email: `nuevo-${s2}@e2e.local`,
        password: 'Secret123',
        acceptTerms: true,
        utmSource: 'instagram',
        utmCampaign: 'otono',
      })
      .expect(201);
    const fresh = await db.platformLead.findFirst({
      where: { email: `nuevo-${s2}@e2e.local` },
    });
    expect(fresh).toEqual(
      expect.objectContaining({
        status: 'trial',
        source: 'signup',
        utmSource: 'instagram',
        utmCampaign: 'otono',
      }),
    );
    expect(fresh?.tenantId).toBeTruthy();
  });

  it('propuesta a un lead sin cuenta, crear su cuenta y la propuesta pasa a su tenant', async () => {
    const s = stamp();
    const email = `propuesta-${s}@e2e.local`;
    const created = await http()
      .post('/admin/leads')
      .set(auth())
      .send({ companyName: 'Trasteros Propuesta', contactName: 'Pablo', email, source: 'referral' })
      .expect(201);
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    const quoted = await http()
      .post(`/admin/leads/${created.body.id}/quote`)
      .set(auth())
      .send({ planId: plan.id, cycle: 'monthly', addons: [], followupDays: 3 })
      .expect(200);
    expect(quoted.body.status).toBe('interested');
    expect(quoted.body.planSlug).toBe('starter');
    expect(quoted.body.quoteOffers).toHaveLength(1);
    expect(quoted.body.quoteOffers[0]).toEqual(
      expect.objectContaining({ tenantId: null, leadId: created.body.id }),
    );
    expect(quoted.body.quoteOffers[0].acceptUrl).toContain('/register?email=');
    expect(quoted.body.nextFollowup.title).toBe('Llamar por la propuesta');

    // Crear su cuenta: solo superadmin.
    const body = {
      tenantName: 'Trasteros Propuesta SL',
      tenantSlug: `test-lacc-${s}`,
      ownerName: 'Pablo Propuesta',
      ownerEmail: email,
      planSlug: 'starter',
      trialDays: 30,
    };
    await http()
      .post(`/admin/leads/${created.body.id}/create-tenant`)
      .set({ Authorization: `Bearer ${supportToken}` })
      .send(body)
      .expect(403);
    const withAccount = await http()
      .post(`/admin/leads/${created.body.id}/create-tenant`)
      .set(auth())
      .send(body)
      .expect(201);
    expect(withAccount.body.status).toBe('trial');
    expect(withAccount.body.tenant.slug).toBe(`test-lacc-${s}`);
    const offer = await db.platformQuoteOffer.findFirstOrThrow({
      where: { leadId: created.body.id },
    });
    expect(offer.tenantId).toBe(withAccount.body.tenant.id);
    // No queda un segundo lead para la misma cuenta.
    expect(await db.platformLead.count({ where: { tenantId: offer.tenantId } })).toBe(1);
  });

  it('pasa a cliente con el primer pago y a perdido si acaba la prueba sin pagar', async () => {
    const leads = app.get(PlatformLeadsService);
    const mk = async (label: string) => {
      const s = stamp();
      const email = `${label}-${s}@e2e.local`;
      const lead = await http()
        .post('/admin/leads')
        .set(auth())
        .send({ companyName: `Trasteros ${label}`, email, source: 'phone' })
        .expect(201);
      await http()
        .post('/auth/register')
        .send({
          tenantName: `Trasteros ${label}`,
          tenantSlug: `test-l${label}-${s}`,
          fullName: 'Prueba',
          email,
          password: 'Secret123',
          acceptTerms: true,
        })
        .expect(201);
      return (await detail(lead.body.id)) as PlatformLeadDetailDto;
    };
    const payer = await mk('paga');
    const quitter = await mk('deja');

    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: payer.tenant!.id,
        provider: 'manual',
        status: 'paid',
        amount: 79,
        currency: 'EUR',
        paidAt: new Date(),
      },
    });
    await db.tenant.update({
      where: { id: quitter.tenant!.id },
      data: { trialEndedAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    const moved = await leads.syncFromTenants();
    expect(moved.customers).toBeGreaterThanOrEqual(1);
    expect((await detail(payer.id)).status).toBe('customer');
    const lost = await detail(quitter.id);
    expect(lost).toEqual(
      expect.objectContaining({ status: 'lost', lostReasonCode: 'no_conversion' }),
    );
    expect(lost.nextFollowup?.title).toContain('acabó la prueba sin contratar');
    // Una segunda vuelta no repite nada.
    await leads.syncFromTenants();
    expect((await detail(quitter.id)).followups).toHaveLength(1);

    const stats = await http().get('/admin/leads/stats?months=3').set(auth()).expect(200);
    expect(stats.body.funnel.find((f: { stage: string }) => f.stage === 'customer').reached).toBe(
      await db.platformLead.count({
        where: {
          discardedAt: null,
          customerAt: { not: null },
          createdAt: { gte: new Date(stats.body.from) },
        },
      }),
    );
    expect(stats.body.lostReasons.some((r: { code: string }) => r.code === 'no_conversion')).toBe(
      true,
    );
    const csv = await http().get('/admin/leads/export.csv').set(auth()).expect(200);
    expect(csv.text).toContain('Trasteros paga');
  });

  it('avisa una vez de un lead nuevo que lleva horas sin atender', async () => {
    const leads = app.get(PlatformLeadsService);
    const created = await http()
      .post('/admin/leads')
      .set(auth())
      .send({ contactName: 'Sin Atender', email: `atender-${stamp()}@e2e.local`, source: 'phone' })
      .expect(201);
    await db.platformLead.update({
      where: { id: created.body.id },
      data: { createdAt: new Date(Date.now() - 6 * 3_600_000) },
    });
    const first = await leads.unattended();
    expect(first.some((u) => u.id === created.body.id)).toBe(true);
    const second = await leads.unattended();
    expect(second.some((u) => u.id === created.body.id)).toBe(false);
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'platform_lead.unattended', link: `/admin/leads?lead=${created.body.id}` },
    });
    expect(notice?.title).toContain('Sin Atender');
  });
});
