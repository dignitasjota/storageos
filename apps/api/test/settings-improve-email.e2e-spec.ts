import { CUSTOMER_EMAIL_KINDS } from '@storageos/shared';
import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Hoy (y otros días) en la zona del negocio, `AAAA-MM-DD`. */
function madridDay(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

const ALL_DAY = { open: '00:00', close: '00:00' };
const EVERY_DAY = {
  mon: ALL_DAY,
  tue: ALL_DAY,
  wed: ALL_DAY,
  thu: ALL_DAY,
  fri: ALL_DAY,
  sat: ALL_DAY,
  sun: ALL_DAY,
};

describe('Configuración → Correo y horarios de atención: mejoras (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prisma = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const api = () => request(app.getHttpServer());

  it('vista previa de cada correo al inquilino, en español y en inglés, con la cuota del negocio', async () => {
    const owner = await registerVerifiedUser(app, 'cepreview', { tenantName: 'Trasteros Prueba' });
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1, pricePerUnit: 50 });

    const es = await api()
      .get('/settings/tenant/customer-emails/invoice_issued/preview?locale=es')
      .set(auth)
      .expect(200);
    expect(es.body.subject).toMatch(/^Nueva factura /);
    expect(es.body.html).toContain('Trasteros Prueba');
    expect(es.body.html).toContain('Lucía');
    // 50 € + 21 % de IVA.
    expect(es.body.html).toContain('60,50');

    const en = await api()
      .get('/settings/tenant/customer-emails/invoice_issued/preview?locale=en')
      .set(auth)
      .expect(200);
    expect(en.body.subject).toMatch(/^New invoice /);
    expect(en.body.html).toContain('Alex');

    for (const kind of CUSTOMER_EMAIL_KINDS) {
      const res = await api()
        .get(`/settings/tenant/customer-emails/${kind}/preview`)
        .set(auth)
        .expect(200);
      expect(res.body.kind).toBe(kind);
      expect(res.body.html).not.toMatch(/undefined|NaN|Invalid Date/);
    }

    const unknown = await api()
      .get('/settings/tenant/customer-emails/no_existe/preview')
      .set(auth)
      .expect(400);
    expect(unknown.body.code).toBe('unknown_email_kind');
    await api()
      .get('/settings/tenant/customer-emails/invoice_issued/preview?locale=fr')
      .set(auth)
      .expect(400);
    await api().get('/settings/tenant/customer-emails/invoice_issued/preview').expect(401);
  });

  it('correo de prueba: llega a quien lo pide, no queda en Comunicaciones y tiene tope por hora', async () => {
    const owner = await registerVerifiedUser(app, 'cetest');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });

    const sent = await api()
      .post('/settings/tenant/customer-emails/payment_received/test')
      .set(auth)
      .send({ locale: 'es' })
      .expect(200);
    expect(sent.body.sentTo).toBe(owner.email);
    expect(sent.body.subject).toMatch(/^\[Prueba\] Pago recibido/);
    const mail = await waitForEmail(owner.email, { subjectIncludes: '[Prueba] Pago recibido' });
    expect(mail.HTML).toContain('Lucía');

    expect(
      await prisma.communication.count({
        where: { tenantId: owner.tenantId, subject: { contains: 'Prueba' } },
      }),
    ).toBe(0);

    // Quien solo puede ver la configuración ve la vista previa pero no envía.
    const readonly = await scopedUser(app, owner, {
      role: 'readonly',
      facilityIds: [facilityId],
      tag: 'cetest-ro',
    });
    await api()
      .get('/settings/tenant/customer-emails/payment_received/preview')
      .set(readonly)
      .expect(200);
    await api()
      .post('/settings/tenant/customer-emails/payment_received/test')
      .set(readonly)
      .send({})
      .expect(403);

    for (let i = 0; i < 4; i += 1) {
      await api()
        .post('/settings/tenant/customer-emails/staff_message/test')
        .set(auth)
        .send({ locale: 'en' })
        .expect(200);
    }
    const tooMany = await api()
      .post('/settings/tenant/customer-emails/staff_message/test')
      .set(auth)
      .send({})
      .expect(429);
    expect(tooMany.body.code).toBe('too_many_test_emails');
  });

  it('dirección de respuesta sin dominio propio: se guarda, se audita y la usan los correos', async () => {
    const owner = await registerVerifiedUser(app, 'cereply');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const initial = await api().get('/settings/tenant/email-reply-to').set(auth).expect(200);
    expect(initial.body).toMatchObject({
      emailReplyTo: null,
      fallback: owner.email,
      customDomainReplyTo: null,
      effective: owner.email,
    });

    const bad = await api()
      .put('/settings/tenant/email-reply-to')
      .set(auth)
      .send({ emailReplyTo: 'no-es-un-email' })
      .expect(400);
    expect(bad.body.message).toBeTruthy();

    const saved = await api()
      .put('/settings/tenant/email-reply-to')
      .set(auth)
      .send({ emailReplyTo: 'Atencion@Negocio-Prueba.test' })
      .expect(200);
    expect(saved.body).toMatchObject({
      emailReplyTo: 'atencion@negocio-prueba.test',
      effective: 'atencion@negocio-prueba.test',
    });
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'tenant.email_reply_to_changed' },
    });
    expect(audit).not.toBeNull();

    // Un correo del negocio a un inquilino responde a esa dirección.
    const customerEmail = `cereply-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email: customerEmail });
    await api()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: 'Hola, te escribimos desde el negocio' })
      .expect(201);
    const toCustomer = await waitForEmail(customerEmail);
    expect(toCustomer.ReplyTo?.map((r) => r.Address)).toContain('atencion@negocio-prueba.test');

    const cleared = await api()
      .put('/settings/tenant/email-reply-to')
      .set(auth)
      .send({ emailReplyTo: '' })
      .expect(200);
    expect(cleared.body).toMatchObject({ emailReplyTo: null, effective: owner.email });

    await api()
      .put('/settings/tenant/email-reply-to')
      .send({ emailReplyTo: 'x@y.test' })
      .expect(401);
  });

  it('horario de atención de Mensajes: turno partido, días cerrados limpios y festivo = fuera de horario', async () => {
    const owner = await registerVerifiedUser(app, 'cehours');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const today = madridDay();
    const future = madridDay(40);

    const saved = await api()
      .put('/customer-messages/settings')
      .set(auth)
      .send({
        autoReplyEnabled: true,
        autoReply: 'Hoy cerramos por festivo',
        hours: {
          ...EVERY_DAY,
          mon: { open: '09:00', close: '14:00', open2: '16:00', close2: '20:00' },
          closedDates: [future, '2020-01-01', today, future],
        },
      })
      .expect(200);
    expect(saved.body.hours.closedDates).toEqual([today, future]);
    expect(saved.body.hours.mon).toEqual({
      open: '09:00',
      close: '14:00',
      open2: '16:00',
      close2: '20:00',
    });

    await api()
      .put('/customer-messages/settings')
      .set(auth)
      .send({ autoReplyEnabled: false, hours: { closedDates: ['2026-02-30'] } })
      .expect(400);
    const tooMany = Array.from({ length: 61 }, (_, i) => madridDay(i + 1));
    await api()
      .put('/customer-messages/settings')
      .set(auth)
      .send({ autoReplyEnabled: false, hours: { ...EVERY_DAY, closedDates: tooMany } })
      .expect(400);

    // Abierto todos los días a todas horas, pero hoy es festivo: sale la respuesta automática.
    const customerEmail = `cehours-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email: customerEmail });
    await api()
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email: customerEmail })
      .expect(204);
    const link = await waitForEmail(customerEmail, { subjectIncludes: 'Accede' });
    const token = link.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await api().post('/portal/login/consume').send({ token });
    const pAuth = { Authorization: `Bearer ${consume.body.accessToken as string}` };
    await api().post('/portal/me/messages').set(pAuth).send({ body: 'Hola' }).expect(201);
    const thread = await api().get('/portal/me/messages').set(pAuth).expect(200);
    const autos = (thread.body as { isAuto: boolean; body: string }[]).filter((m) => m.isAuto);
    expect(autos).toHaveLength(1);
    expect(autos[0]?.body).toBe('Hoy cerramos por festivo');
  });

  it('horario del chat de la web: los días cerrados pasados no se guardan', async () => {
    const owner = await registerVerifiedUser(app, 'cewebhours');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const future = madridDay(10);
    const res = await api()
      .patch('/web-chat/settings')
      .set(auth)
      .send({
        teamHours: { mon: { open: '09:00', close: '18:00' }, closedDates: ['2021-05-01', future] },
      })
      .expect(200);
    expect(res.body.teamHours.closedDates).toEqual([future]);

    // Solo días pasados: el campo desaparece.
    const pruned = await api()
      .patch('/web-chat/settings')
      .set(auth)
      .send({ teamHours: { mon: { open: '09:00', close: '18:00' }, closedDates: ['2021-05-01'] } })
      .expect(200);
    expect(pruned.body.teamHours).toEqual({ mon: { open: '09:00', close: '18:00' } });
  });
});
