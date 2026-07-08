import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { CommunicationsService } from '../src/modules/communications/communications.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Communications + Templates + Automations + Leads + Widget (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('el registro siembra las plantillas transaccionales built-in', async () => {
    const owner = await registerVerifiedUser(app, 'comms-tpl');
    const res = await request(app.getHttpServer())
      .get('/message-templates')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const codes = (res.body as { code: string }[]).map((t) => t.code);
    // Las plantillas clave del ciclo de vida deben estar sembradas y editables.
    expect(codes).toContain('welcome_email');
    expect(codes).toContain('invoice_overdue_email');
    expect(codes).toContain('contract_signed_email');
  });

  it('crea plantilla custom, hace preview con variables, y envia comm manual', async () => {
    const owner = await registerVerifiedUser(app, 'comms-send');

    const tpl = await request(app.getHttpServer())
      .post('/message-templates')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        code: 'manual_greeting',
        kind: 'marketing',
        channel: 'email',
        name: 'Saludo manual',
        subject: 'Hola {{customer.firstName}}',
        bodyText: 'Hola {{customer.firstName}}, gracias por {{tenant.name}}.',
        bodyHtml: '<p>Hola {{customer.firstName}}</p>',
        variables: ['customer.firstName', 'tenant.name'],
      });
    expect(tpl.status).toBe(201);
    const templateId = tpl.body.id as string;

    const preview = await request(app.getHttpServer())
      .post('/message-templates/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        subject: 'Hola {{customer.firstName}}',
        bodyText: 'Hola {{customer.firstName}}',
        variables: { customer: { firstName: 'Ana' } },
      });
    expect(preview.status).toBe(200);
    expect(preview.body.subject).toBe('Hola Ana');
    expect(preview.body.bodyText).toBe('Hola Ana');

    const comm = await request(app.getHttpServer())
      .post('/communications')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        channel: 'email',
        templateId,
        recipient: 'tester@example.com',
        variables: { customer: { firstName: 'Ana' }, tenant: { name: 'Demo' } },
      });
    expect(comm.status).toBe(201);
    expect(comm.body.status).toBe('pending');
    expect(comm.body.subject).toBe('Hola Ana');

    // Espera a que el worker procese.
    await new Promise((r) => setTimeout(r, 2000));
    const detail = await request(app.getHttpServer())
      .get(`/communications/${comm.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.status).toBe(200);
    expect(['sent', 'processing', 'pending']).toContain(detail.body.status);
  });

  it('plantilla system no es editable (409)', async () => {
    const owner = await registerVerifiedUser(app, 'comms-sysro');
    const tpl = await request(app.getHttpServer())
      .post('/message-templates')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        code: 'system_locked',
        kind: 'system',
        channel: 'email',
        name: 'Bloqueada',
        subject: 'x',
        bodyText: 'x',
        variables: [],
      });
    expect(tpl.status).toBe(201);
    const res = await request(app.getHttpServer())
      .patch(`/message-templates/${tpl.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'cambiada' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('message_template_system_readonly');
  });

  it('CRUD automation rule + activacion/desactivacion', async () => {
    const owner = await registerVerifiedUser(app, 'auto-crud');
    const tpl = await request(app.getHttpServer())
      .post('/message-templates')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        code: 'auto_welcome',
        kind: 'transactional',
        channel: 'email',
        name: 'Bienvenida',
        subject: 'Bienvenido',
        bodyText: 'Hola {{customer.firstName}}',
        variables: ['customer.firstName'],
      });
    expect(tpl.status).toBe(201);
    const create = await request(app.getHttpServer())
      .post('/automations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Welcome email',
        trigger: 'customer_created',
        actionType: 'send_email',
        templateId: tpl.body.id,
      });
    expect(create.status).toBe(201);
    expect(create.body.isActive).toBe(true);
    const list = await request(app.getHttpServer())
      .get('/automations')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.body).toHaveLength(1);
    const upd = await request(app.getHttpServer())
      .patch(`/automations/${create.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ isActive: false });
    expect(upd.status).toBe(200);
    expect(upd.body.isActive).toBe(false);
  });

  it('automation customer_created dispara communication pending', async () => {
    const owner = await registerVerifiedUser(app, 'auto-fire');
    const tpl = await request(app.getHttpServer())
      .post('/message-templates')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        code: 'auto_fire_tpl',
        kind: 'transactional',
        channel: 'email',
        name: 'Auto fire',
        subject: 'Hola {{customer.firstName}}',
        bodyText: 'Hola {{customer.firstName}}',
        variables: ['customer.firstName'],
      });
    expect(tpl.status).toBe(201);
    await request(app.getHttpServer())
      .post('/automations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Welcome',
        trigger: 'customer_created',
        actionType: 'send_email',
        templateId: tpl.body.id,
      })
      .expect(201);
    // Crea customer; el evento debe disparar la regla.
    const cust = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerType: 'individual',
        firstName: 'Bea',
        lastName: 'Perez',
        email: 'bea@example.com',
        country: 'ES',
      });
    expect(cust.status).toBe(201);
    await new Promise((r) => setTimeout(r, 6000));
    const comms = await request(app.getHttpServer())
      .get('/communications')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(comms.status).toBe(200);
    const own = comms.body.filter((c: { customerId: string }) => c.customerId === cust.body.id);
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(own[0].recipient).toBe('bea@example.com');
  });

  it('CRUD lead + transition + convert a customer', async () => {
    const owner = await registerVerifiedUser(app, 'leads-crud');
    const lead = await request(app.getHttpServer())
      .post('/leads')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        source: 'manual',
        firstName: 'Carlos',
        lastName: 'Vega',
        email: 'carlos@example.com',
        phone: '+34 600 111 222',
      });
    expect(lead.status).toBe(201);
    expect(lead.body.status).toBe('new');

    const moved = await request(app.getHttpServer())
      .post(`/leads/${lead.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'qualified' });
    expect(moved.status).toBe(201);
    expect(moved.body.status).toBe('qualified');
    expect(moved.body.qualifiedAt).toBeTruthy();

    const bad = await request(app.getHttpServer())
      .post(`/leads/${lead.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'new' });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('invalid_lead_transition');

    const conv = await request(app.getHttpServer())
      .post(`/leads/${lead.body.id}/convert`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    expect(conv.status).toBe(201);
    expect(conv.body.status).toBe('won');
    expect(conv.body.convertedCustomerId).toBeTruthy();
  });

  it('widget publico: lista facilities + envia lead via honeypot OK', async () => {
    const owner = await registerVerifiedUser(app, 'wid');
    // Crear una facility para que la listada salga.
    await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local Centro', city: 'Madrid' })
      .expect(201);

    const list = await request(app.getHttpServer()).get(`/public/widget/${owner.slug}/facilities`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Local Centro');

    const lead = await request(app.getHttpServer())
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Lucia',
        email: 'lucia@example.com',
        phone: '+34 600 222 333',
        hp: '',
        acceptsTerms: true,
        acceptsMarketing: false,
      });
    expect(lead.status).toBe(201);
    expect(lead.body.source).toBe('widget');

    // Honeypot relleno => 409
    const bot = await request(app.getHttpServer()).post(`/public/widget/${owner.slug}/leads`).send({
      firstName: 'Bot',
      email: 'bot@example.com',
      phone: '+34 600 000 000',
      hp: 'spam',
      acceptsTerms: true,
    });
    expect(bot.status).toBe(409);
    expect(bot.body.code).toBe('invalid_payload');
  });

  it('widget con tenant inexistente -> 404', async () => {
    const res = await request(app.getHttpServer()).get('/public/widget/no-existe-xyz/facilities');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('tenant_not_found');
  });

  it('enqueue cae a la plantilla built-in si el tenant no la tiene en BD (no falla en silencio)', async () => {
    const owner = await registerVerifiedUser(app, 'comms-fallback');
    // Simulamos un tenant SIN plantillas sembradas (p. ej. dado de alta antes
    // del seed): borramos las suyas.
    await adminClient.messageTemplate.deleteMany({ where: { tenantId: owner.tenantId } });

    const comms = app.get(CommunicationsService);
    const result = await comms.enqueue({
      tenantId: owner.tenantId,
      channel: 'email',
      recipient: 'inquilino@e2e.local',
      templateCode: 'welcome_email',
      trigger: 'customer_created',
      variables: { customer: { firstName: 'Lola' }, tenant: { name: 'Trasteros Lola' } },
      source: 'test.fallback',
    });
    // Se resolvió con el cuerpo del built-in (antes lanzaba message_template_not_found).
    expect(result.status).not.toBe('failed');
    expect(result.bodyText).toBeTruthy();
    expect(result.bodyText.length).toBeGreaterThan(0);
  });
});
