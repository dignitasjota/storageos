import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { buildUnsubscribeToken, unsubscribeKey } from '../src/common/marketing/unsubscribe-token';
import { CampaignInsightsService } from '../src/modules/campaigns/campaign-insights.service';
import { WinbackService } from '../src/modules/campaigns/winback.service';
import { CommunicationsService } from '../src/modules/communications/communications.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Campañas y Comunicaciones: textos con variables mal escritas,
 * alcance por local, enlaces con código en el historial, enlaces legibles en
 * el correo, bajas por email, win-back sin deudores y lo que faltaba (editar,
 * duplicar, borrar, registro, filtros).
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const BREVO_TOKEN = process.env.EMAIL_WEBHOOK_TOKEN ?? 'email-webhook-token-e2e';

describe('Revisión de Campañas y Comunicaciones (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

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

  async function waitCampaign(auth: Record<string, string>, id: string) {
    for (let i = 0; i < 60; i++) {
      const r = await http().get(`/campaigns/${id}`).set(auth);
      if (r.body.status !== 'sending') return r.body as { status: string; sentCount: number };
      await new Promise((res) => setTimeout(res, 200));
    }
    return (await http().get(`/campaigns/${id}`).set(auth)).body;
  }

  async function waitSent(tenantId: string, source: string, n: number) {
    for (let i = 0; i < 100; i++) {
      const rows = await db.communication.findMany({
        where: { tenantId, source, status: { in: ['sent', 'delivered'] } },
      });
      if (rows.length >= n) return rows;
      await new Promise((res) => setTimeout(res, 200));
    }
    return db.communication.findMany({ where: { tenantId, source } });
  }

  it('rechaza variables mal escritas en campañas, plantillas y win-back', async () => {
    const owner = await registerVerifiedUser(app, 'crva');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createCustomer(app, owner.accessToken);
    const base = { name: 'Rota', segment: { audience: 'customers', contractStatus: 'any' } };

    const unclosed = await http()
      .post('/campaigns')
      .set(auth)
      .send({ ...base, subject: 'Hola {{customer.firstName', bodyText: 'Oferta para ti' })
      .expect(400);
    expect(unclosed.body.code).toBe('invalid_template_text');
    expect(unclosed.body.message).toContain('sin cerrar');

    const unknown = await http()
      .post('/campaigns')
      .set(auth)
      .send({ ...base, subject: 'Hola', bodyText: 'Tu cupón {{coupon.code}} te espera' })
      .expect(400);
    expect(unknown.body.message).toContain('{{coupon.code}}');

    // A contactos no se les puede poner el nombre de inquilino.
    await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Contactos',
        subject: 'Hola {{customer.firstName}}',
        bodyText: 'Texto',
        segment: { audience: 'leads' },
      })
      .expect(400);

    const preview = await http()
      .post('/campaigns/preview-email')
      .set(auth)
      .send({ subject: 'Hola {{#if}}', bodyText: 'Texto', audience: 'customers' })
      .expect(400);
    expect(preview.body.code).toBe('invalid_template_text');

    await http()
      .patch('/campaigns/winback-settings')
      .set(auth)
      .send({ bodyText: 'Hola {{customer.firstName vuelve' })
      .expect(400);

    await http()
      .post('/campaigns/templates')
      .set(auth)
      .send({ name: 'Rota', subject: 'Hola {{tenant.nombre}}', bodyText: 'Texto' })
      .expect(400);
    await http()
      .post('/campaigns/templates')
      .set(auth)
      .send({ name: 'Verano', subject: 'Hola {{customer.firstName}}', bodyText: 'Texto' })
      .expect(201);
    const twin = await http()
      .post('/campaigns/templates')
      .set(auth)
      .send({ name: 'verano', subject: 'Otra', bodyText: 'Texto' })
      .expect(409);
    expect(twin.body.code).toBe('campaign_template_name_taken');

    // Fecha pasada y nadie a quien enviar.
    const past = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        ...base,
        subject: 'Hola',
        bodyText: 'Texto',
        scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(400);
    expect(past.body.code).toBe('scheduled_in_past');
    const nobody = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Nadie',
        subject: 'Hola',
        bodyText: 'Texto',
        segment: { audience: 'customers', tag: 'no-existe' },
      })
      .expect(201);
    const send = await http().post(`/campaigns/${nobody.body.id}/send`).set(auth).expect(400);
    expect(send.body.code).toBe('campaign_no_recipients');
    expect((await http().get(`/campaigns/${nobody.body.id}`).set(auth)).body.status).toBe('draft');
  });

  it('cambiar, duplicar y borrar un borrador queda en el registro', async () => {
    const owner = await registerVerifiedUser(app, 'crvb');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createCustomer(app, owner.accessToken);
    const draft = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Otoño',
        subject: 'Hola',
        bodyText: 'Texto',
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    const updated = await http()
      .patch(`/campaigns/${draft.body.id}`)
      .set(auth)
      .send({ name: 'Otoño 2026', bodyText: 'Hola {{customer.firstName}}, nuevo texto' })
      .expect(200);
    expect(updated.body).toMatchObject({ name: 'Otoño 2026', audienceCount: 1 });
    const copy = await http().post(`/campaigns/${draft.body.id}/duplicate`).set(auth).expect(201);
    expect(copy.body).toMatchObject({ name: 'Otoño 2026 (copia)', status: 'draft' });
    await http().delete(`/campaigns/${copy.body.id}`).set(auth).expect(204);
    await http().get(`/campaigns/${copy.body.id}`).set(auth).expect(404);

    await http().post(`/campaigns/${draft.body.id}/send`).set(auth).expect(200);
    await waitCampaign(auth, draft.body.id);
    const editSent = await http()
      .patch(`/campaigns/${draft.body.id}`)
      .set(auth)
      .send({ name: 'x y' })
      .expect(409);
    expect(editSent.body.code).toBe('campaign_not_editable');
    await http().delete(`/campaigns/${draft.body.id}`).set(auth).expect(409);

    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const actions = (
      await db.auditLog.findMany({
        where: { tenantId: tenant.id, entityType: 'Campaign' },
        select: { action: true },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'campaign.created',
        'campaign.updated',
        'campaign.duplicated',
        'campaign.deleted',
        'campaign.sent',
      ]),
    );
  });

  it('quien solo ve un local no ve ni escribe a los inquilinos de otro', async () => {
    const owner = await registerVerifiedUser(app, 'crvc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const a = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const b = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const inA = await createCustomer(app, owner.accessToken);
    const inB = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: inA }, a.facilityId);
    await signedContractFor(app, owner.accessToken, { id: inB }, b.facilityId);
    const staff = await scopedUser(app, owner, { role: 'staff', facilityIds: [a.facilityId] });
    const manager = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [a.facilityId],
      tag: 'mgr',
    });

    // Comunicaciones: solo las de sus inquilinos.
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const ofB = await db.communication.findMany({
      where: { tenantId: tenant.id, customerId: inB },
    });
    expect(ofB.length).toBeGreaterThan(0);
    const page = await http().get(`/communications/page?customerId=${inB}`).set(staff).expect(200);
    expect(page.body.items).toHaveLength(0);
    const all = await http().get('/communications/page').set(staff).expect(200);
    expect(
      (all.body.items as { customerId: string | null }[]).every((c) => c.customerId !== inB),
    ).toBe(true);
    await http().get(`/communications/${ofB[0]!.id}`).set(staff).expect(404);
    await http().post(`/communications/${ofB[0]!.id}/retry`).set(staff).expect(404);

    // Campañas: a los suyos y solo los suyos.
    const ownerPreview = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', contractStatus: 'any' } })
      .expect(200);
    expect(ownerPreview.body.audienceCount).toBe(2);
    const staffPreview = await http()
      .post('/campaigns/preview')
      .set(staff)
      .send({ segment: { audience: 'customers', contractStatus: 'any' } })
      .expect(200);
    expect(staffPreview.body.audienceCount).toBe(1);
    await http()
      .post('/campaigns/preview')
      .set(staff)
      .send({ segment: { audience: 'customers', facilityId: b.facilityId } })
      .expect(403);
    const mine = await http()
      .post('/campaigns')
      .set(staff)
      .send({
        name: 'Local A',
        subject: 'Hola',
        bodyText: 'Texto',
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    expect(mine.body.audienceCount).toBe(1);
    const ownerCampaign = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Todos',
        subject: 'Hola',
        bodyText: 'Texto',
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    const staffList = await http().get('/campaigns').set(staff).expect(200);
    expect((staffList.body as { id: string }[]).map((c) => c.id)).toEqual([mine.body.id]);
    await http().get(`/campaigns/${ownerCampaign.body.id}`).set(staff).expect(404);
    // El propietario ve las dos.
    expect((await http().get('/campaigns').set(auth)).body).toHaveLength(2);
    // La de su local solo escribe a su inquilino.
    await http().post(`/campaigns/${mine.body.id}/send`).set(staff).expect(200);
    expect((await waitCampaign(staff, mine.body.id)).sentCount).toBe(1);

    // Win-back: de toda la empresa.
    await http()
      .patch('/campaigns/winback-settings')
      .set(staff)
      .send({ enabled: true })
      .expect(403);
    const scoped = await http()
      .patch('/campaigns/winback-settings')
      .set(manager)
      .send({ enabled: true })
      .expect(403);
    expect(scoped.body.code).toBe('facility_not_in_scope');
    await http().post('/campaigns/winback/run').set(manager).expect(403);
    await http().patch('/campaigns/winback-settings').set(auth).send({ enabled: true }).expect(200);

    // Filtros mal puestos: 400 y no un error interno.
    for (const q of ['status=foo', 'channel=foo']) {
      await http().get(`/communications/page?${q}`).set(auth).expect(400);
      await http().get(`/communications?${q}`).set(auth).expect(400);
    }
    await http().get('/communications?customerId=nope').set(auth).expect(400);
    await http().get('/communications/page?limit=abc').set(auth).expect(200);
  });

  it('el historial tapa los enlaces con código y el correo los lleva completos', async () => {
    const owner = await registerVerifiedUser(app, 'crvd');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const email = `firma-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const draft = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: fac.unitIds[0], startDate: '2026-12-01', priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${draft.body.id}/request-signature`).set(auth).send({});
    const mail = await waitForEmail(email);
    const token = /\/sign\/([A-Za-z0-9._-]{20,})/.exec(mail.Text)?.[1];
    expect(token).toBeDefined();
    const history = await http().get(`/communications?customerId=${customerId}`).set(auth);
    const signing = (history.body as { bodyText: string }[]).find((c) =>
      c.bodyText.includes('/sign/'),
    );
    expect(signing?.bodyText).toContain('/sign/••••');
    expect(signing?.bodyText).not.toContain(token);
  });

  it('el correo muestra el enlace escrito; la baja va por email y se atribuye a la última campaña', async () => {
    const owner = await registerVerifiedUser(app, 'crve');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const shared = `doble-${Date.now()}@e2e.local`;
    const twinA = await createCustomer(app, owner.accessToken, { email: shared, firstName: 'Ana' });
    const twinB = await createCustomer(app, owner.accessToken, {
      email: shared.toUpperCase(),
      firstName: 'Ana B',
    });
    const otherEmail = `otro-${Date.now()}@e2e.local`;
    const other = await createCustomer(app, owner.accessToken, { email: otherEmail });

    const preview = await http()
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', contractStatus: 'any' } })
      .expect(200);
    expect(preview.body.audienceCount).toBe(2); // el email repetido cuenta una vez

    const link = 'https://ejemplo.com/oferta?x=1&y=2';
    const first = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Primera',
        subject: 'Hola {{customer.firstName}}',
        bodyText: `Reserva aquí: ${link}.`,
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    await http().post(`/campaigns/${first.body.id}/send`).set(auth).expect(200);
    expect((await waitCampaign(auth, first.body.id)).sentCount).toBe(2);
    const comm = await db.communication.findFirstOrThrow({
      where: { tenantId: tenant.id, source: `campaign:${first.body.id}`, customerId: other },
    });
    expect(comm.bodyText).toContain(link);
    expect(comm.bodyHtml).toContain('/v1/public/campaign-click/');
    expect(comm.bodyHtml).toContain('>https://ejemplo.com/oferta?x=1&amp;y=2</a>');
    const mail = await waitForEmail(otherEmail, { subjectIncludes: 'Hola' });
    expect(mail.Text).toContain(link);
    expect(mail.HTML).toContain('/v1/public/campaign-click/');

    const second = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Segunda',
        subject: 'Otra oferta',
        bodyText: 'Texto',
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    await http().post(`/campaigns/${second.body.id}/send`).set(auth).expect(200);
    await waitCampaign(auth, second.body.id);

    // Se da de baja desde el enlace del correo de una de sus fichas.
    const key = unsubscribeKey(process.env.MASTER_ENCRYPTION_KEY!);
    await http()
      .post(`/public/unsubscribe/${buildUnsubscribeToken(key, 'c', twinA)}`)
      .expect(200);
    const twins = await db.customer.findMany({ where: { id: { in: [twinA, twinB] } } });
    expect(twins.every((t) => !!t.marketingOptOutAt)).toBe(true);
    const r1 = await http().get(`/campaigns/${first.body.id}/results`).set(auth).expect(200);
    const r2 = await http().get(`/campaigns/${second.body.id}/results`).set(auth).expect(200);
    expect(r1.body.unsubscribed).toBe(0);
    expect(r2.body.unsubscribed).toBe(1);

    // Los resultados siguen cuando la limpieza borra los envíos.
    await db.campaign.update({
      where: { id: first.body.id },
      data: { sentAt: new Date(Date.now() - 400 * 86_400_000) },
    });
    await app.get(CampaignInsightsService).snapshotOld();
    await db.communication.deleteMany({ where: { source: `campaign:${first.body.id}` } });
    const kept = await http().get(`/campaigns/${first.body.id}/results`).set(auth).expect(200);
    expect(kept.body.recipients).toBe(2);

    // Al fusionar, quien queda conserva la baja del otro.
    await db.customer.update({ where: { id: twinB }, data: { marketingOptOutAt: null } });
    await http().post(`/customers/${twinB}/merge`).set(auth).send({ sourceId: twinA }).expect(204);
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: twinB } })).marketingOptOutAt,
    ).not.toBeNull();
  });

  it('los rebotes de una campaña dan un solo aviso', async () => {
    const owner = await registerVerifiedUser(app, 'crvf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    await createCustomer(app, owner.accessToken);
    await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Rebotes',
        subject: 'Hola',
        bodyText: 'Texto',
        segment: { audience: 'customers', contractStatus: 'any' },
      })
      .expect(201);
    await http().post(`/campaigns/${c.body.id}/send`).set(auth).expect(200);
    const sent = await waitSent(tenant.id, `campaign:${c.body.id}`, 2);
    for (const comm of sent) {
      await http()
        .post(`/webhooks/email-events/brevo?token=${BREVO_TOKEN}`)
        .send({
          event: 'hard_bounce',
          'message-id': comm.providerMessageId,
          email: comm.recipient,
          reason: 'mailbox does not exist',
        })
        .expect(200);
    }
    const notes = await db.notification.findMany({
      where: {
        tenantId: tenant.id,
        type: { in: ['campaign.undelivered', 'communication.undelivered'] },
      },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: 'campaign.undelivered',
      link: `/campaigns?campaign=${c.body.id}`,
    });
  });

  it('win-back: sin deudores ni reservas sin pagar, con vista previa y sin perder a nadie', async () => {
    const owner = await registerVerifiedUser(app, 'crvg');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const ended = async (email: string) => {
      const id = await createCustomer(app, owner.accessToken, { email });
      const k = await signedContractFor(app, owner.accessToken, { id }, fac.facilityId);
      await db.contract.update({
        where: { id: k.contractId },
        data: { status: 'ended', endDate: new Date(Date.now() - 100 * 86_400_000) },
      });
      return { id, ...k };
    };
    const stamp = Date.now();
    const good = await ended(`bueno-${stamp}@e2e.local`);
    const debtor = await ended(`moroso-${stamp}@e2e.local`);
    await db.delinquencyCase.create({
      data: {
        tenantId: tenant.id,
        customerId: debtor.id,
        contractId: debtor.contractId,
        unitId: debtor.unitId,
        facilityId: debtor.facilityId,
        status: 'closed_disposed',
        debtSnapshot: 30000,
      },
    });
    const unpaid = await ended(`sinpagar-${stamp}@e2e.local`);
    await db.contract.update({
      where: { id: unpaid.contractId },
      data: { status: 'cancelled', firstPaymentDeadline: new Date(Date.now() - 99 * 86_400_000) },
    });
    // El mismo email que el bueno en otra ficha: una sola oferta.
    await ended(`BUENO-${stamp}@e2e.local`);

    await http()
      .patch('/campaigns/winback-settings')
      .set(auth)
      .send({ enabled: true, delayDays: 30 })
      .expect(200);
    const preview = await http().get('/campaigns/winback/preview').set(auth).expect(200);
    expect(preview.body).toEqual({ firstStep: 1, secondStep: 0 });

    // Un fallo al encolar no deja al ex-cliente marcado como avisado.
    const comms = app.get(CommunicationsService);
    // Solo el del win-back: el correo del PIN del último contrato firmado puede
    // seguir encolándose en segundo plano.
    const enqueue = comms.enqueue.bind(comms);
    let failed = false;
    const spy = jest.spyOn(comms, 'enqueue').mockImplementation((args) => {
      if (!failed && args.source?.startsWith('winback')) {
        failed = true;
        return Promise.reject(new Error('cola caída'));
      }
      return enqueue(args);
    });
    expect((await app.get(WinbackService).runForTenant(tenant.id, true)).sent).toBe(0);
    expect(await db.winbackSend.count({ where: { tenantId: tenant.id } })).toBe(0);
    spy.mockRestore();

    const run = await http().post('/campaigns/winback/run').set(auth).expect(200);
    expect(run.body).toEqual({ sent: 1, secondSent: 0 });
    const sentTo = await db.communication.findMany({
      where: { tenantId: tenant.id, source: 'winback.auto' },
      select: { customerId: true },
    });
    expect(sentTo.map((s) => s.customerId)).toEqual([good.id]);
    expect(
      await db.auditLog.count({ where: { tenantId: tenant.id, action: 'winback.sent_now' } }),
    ).toBe(1);
  });

  it('vuelve a encolar los envíos que se quedaron pendientes', async () => {
    const owner = await registerVerifiedUser(app, 'crvh');
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const stuck = await db.communication.create({
      data: {
        tenantId: tenant.id,
        channel: 'email',
        status: 'pending',
        recipient: `atascado-${Date.now()}@e2e.local`,
        subject: 'Atascado',
        bodyText: 'Se quedó sin trabajo en la cola',
        source: 'manual',
        createdAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    expect(await app.get(CommunicationsService).requeueStuck()).toBeGreaterThanOrEqual(1);
    let status = 'pending';
    for (let i = 0; i < 50 && status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      status = (await db.communication.findUniqueOrThrow({ where: { id: stuck.id } })).status;
    }
    expect(['sent', 'processing']).toContain(status);
  });
});
