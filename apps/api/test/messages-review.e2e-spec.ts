import { hash } from '@node-rs/argon2';
import request from 'supertest';

import { CustomerMessagesService } from '../src/modules/customer-messages/customer-messages.service';
import { DataRetentionService } from '../src/modules/data-retention/data-retention.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const ADMIN_EMAIL = 'messages-review-admin@e2e.local';
const ADMIN_PASSWORD = 'Secret-Admin-1';
const INBOUND_SECRET = 'email-inbound-secret-e2e';

describe('Revisión de la mensajería (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaAdminService;
  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prisma = app.get(PrismaAdminService);
    await prisma.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await prisma.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await hash(ADMIN_PASSWORD),
        fullName: 'Admin revisión',
        role: 'superadmin',
        isActive: true,
      },
    });
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await prisma.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  async function portalLogin(slug: string, email: string) {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await http().post('/portal/login/consume').send({ token });
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  async function teamMember(
    auth: Record<string, string>,
    slug: string,
    role: 'staff' | 'manager' | 'readonly',
    facilityIds?: string[],
  ) {
    const email = `msg-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
    const password = 'Passw0rd!';
    await http().post('/invitations').set(auth).send({ email, role }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: `Equipo ${role}`, password })
      .expect(200);
    const users = await http().get('/users').set(auth);
    const user = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    if (facilityIds) {
      await http()
        .patch(`/settings/users/${user.id}/facilities`)
        .set(auth)
        .send({ facilityIds })
        .expect(204);
    }
    const login = await http().post('/auth/login').send({ tenantSlug: slug, email, password });
    return { id: user.id, auth: { Authorization: `Bearer ${login.body.accessToken as string}` } };
  }

  it('cada persona solo ve y solo recibe avisos de los inquilinos que puede abrir', async () => {
    const owner = await registerVerifiedUser(app, 'msgscope');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facA = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const facB = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const stamp = Date.now();
    const emailA = `msg-a-${stamp}@e2e.local`;
    const emailB = `msg-b-${stamp}@e2e.local`;
    const emailN = `msg-n-${stamp}@e2e.local`;
    const inA = await createCustomer(app, owner.accessToken, { email: emailA });
    const inB = await createCustomer(app, owner.accessToken, { email: emailB });
    const noContract = await createCustomer(app, owner.accessToken, { email: emailN });
    await signedContractFor(app, owner.accessToken, { id: inA }, facA.facilityId);
    await signedContractFor(app, owner.accessToken, { id: inB }, facB.facilityId);
    const staffA = await teamMember(auth, owner.slug, 'staff', [facA.facilityId]);

    const pAuthA = await portalLogin(owner.slug, emailA);
    for (const [email, pAuth] of [
      [emailA, pAuthA],
      [emailB, await portalLogin(owner.slug, emailB)],
      [emailN, await portalLogin(owner.slug, emailN)],
    ] as const) {
      await http()
        .post('/portal/me/messages')
        .set(pAuth)
        .send({ body: `Hola desde ${email}` });
    }

    // La campana no enseña el mensaje de un inquilino de otro local.
    const bell = await http().get('/notifications').set(staffA.auth).expect(200);
    const bodies = (bell.body.items as { body: string | null }[]).map((n) => n.body ?? '');
    expect(bodies.some((b) => b.includes(emailA))).toBe(true);
    expect(bodies.some((b) => b.includes(emailN))).toBe(true);
    expect(bodies.some((b) => b.includes(emailB))).toBe(false);

    // Contador y bandeja dicen lo mismo, y salen también los que no tienen contrato.
    const summary = await http()
      .get('/customer-messages/unread-summary')
      .set(staffA.auth)
      .expect(200);
    expect(Object.keys(summary.body.byCustomer).sort()).toEqual([inA, noContract].sort());
    const inbox = await http().get('/customer-messages/conversations').set(staffA.auth).expect(200);
    expect((inbox.body as { customerId: string }[]).map((c) => c.customerId).sort()).toEqual(
      [inA, noContract].sort(),
    );

    // El propietario lo ve todo.
    const all = await http().get('/customer-messages/conversations').set(auth).expect(200);
    expect(all.body).toHaveLength(3);

    // Un inquilino con trasteros en dos locales avisa a quien tenga cualquiera de ellos.
    await signedContractFor(app, owner.accessToken, { id: inA }, facB.facilityId);
    const staffB = await teamMember(auth, owner.slug, 'staff', [facB.facilityId]);
    await prisma.$executeRaw`DELETE FROM security_alert_states WHERE identifier = ${inA}`;
    await http().post('/portal/me/messages').set(pAuthA).send({ body: 'Segundo trastero' });
    for (const who of [staffA, staffB]) {
      const list = await http().get('/notifications').set(who.auth).expect(200);
      expect(
        (list.body.items as { body: string | null }[]).some((n) => n.body === 'Segundo trastero'),
      ).toBe(true);
    }
  });

  it('avisa una vez cada 15 minutos por conversación y recuerda lo que sigue sin responder', async () => {
    const owner = await registerVerifiedUser(app, 'msgnotice');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `msg-notice-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const pAuth = await portalLogin(owner.slug, email);
    const count = (type: string) =>
      prisma.notification.count({ where: { tenantId: owner.tenantId, type } });

    await http().post('/portal/me/messages').set(pAuth).send({ body: 'Uno' });
    // Con la conversación abierta tampoco se repite el aviso por cada frase.
    await http().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    await http().post('/portal/me/messages').set(pAuth).send({ body: 'Dos' });
    expect(await count('customer.message')).toBe(1);

    // Pasado el plazo vuelve a avisar, aunque nadie la haya abierto.
    await prisma.$executeRaw`
      UPDATE security_alert_states SET last_sent_at = now() - interval '16 minutes'
      WHERE kind = 'customer_message' AND identifier = ${customerId}`;
    await http().post('/portal/me/messages').set(pAuth).send({ body: 'Tres' });
    expect(await count('customer.message')).toBe(2);

    // Un día sin respuesta: se recuerda una sola vez.
    await prisma.customerMessage.updateMany({
      where: { customerId },
      data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    const messages = app.get(CustomerMessagesService);
    expect(await messages.remindUnanswered()).toBeGreaterThanOrEqual(1);
    expect(await count('customer.message_unanswered')).toBe(1);
    await messages.remindUnanswered();
    expect(await count('customer.message_unanswered')).toBe(1);

    // Si el equipo ya contestó, no hay nada que recordar.
    await http().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Respondido' });
    await prisma.$executeRaw`DELETE FROM security_alert_states WHERE kind = 'customer_message_reminder'`;
    await prisma.customerMessage.updateMany({
      where: { customerId, senderType: 'staff' },
      data: { createdAt: new Date(Date.now() - 24.5 * 3_600_000) },
    });
    await messages.remindUnanswered();
    expect(await count('customer.message_unanswered')).toBe(1);
  });

  it('el correo al inquilino cuenta el plazo desde el último correo', async () => {
    const owner = await registerVerifiedUser(app, 'msgemail');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `msg-email-${Date.now()}@e2e.local`,
    });
    const copies = () =>
      prisma.communication.count({
        where: { customerId, source: 'customer_email.staff_message' },
      });
    const write = async (body: string) => {
      await http().post(`/customers/${customerId}/messages`).set(auth).send({ body }).expect(201);
      await new Promise((r) => setTimeout(r, 300));
    };

    await write('Uno');
    // El primer mensaje lleva 16 minutos, pero el correo se mandó hace 5.
    await prisma.customerMessage.updateMany({
      where: { customerId },
      data: { createdAt: new Date(Date.now() - 16 * 60_000) },
    });
    await write('Dos');
    expect(await copies()).toBe(1);

    await prisma.$executeRaw`
      UPDATE security_alert_states SET last_sent_at = now() - interval '16 minutes'
      WHERE kind = 'customer_message_email' AND identifier = ${customerId}`;
    await write('Tres');
    expect(await copies()).toBe(2);
  });

  it('el hilo llega por páginas y la URL de un adjunto no cambia al refrescar', async () => {
    const owner = await registerVerifiedUser(app, 'msgpage');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `msg-page-${Date.now()}@e2e.local`,
    });
    const now = Date.now();
    await prisma.customerMessage.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        tenantId: owner.tenantId,
        customerId,
        senderType: 'customer',
        body: `Mensaje ${i}`,
        createdAt: new Date(now - (60 - i) * 1000),
      })),
    });
    const last = await http().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    expect(last.body).toHaveLength(50);
    expect(last.body[0].body).toBe('Mensaje 10');
    expect(last.body[49].body).toBe('Mensaje 59');
    const older = await http()
      .get(`/customers/${customerId}/messages?before=${last.body[0].id as string}`)
      .set(auth)
      .expect(200);
    expect(older.body).toHaveLength(10);
    expect(older.body[0].body).toBe('Mensaje 0');

    const presign = await http()
      .post(`/customers/${customerId}/messages/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/png' })
      .expect(200);
    await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body: PNG,
    });
    await http()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({
        body: 'Foto',
        attachment: { key: presign.body.key, mimeType: 'image/png', filename: 'a.png' },
      })
      .expect(201);
    const urlOf = async () => {
      const res = await http().get(`/customers/${customerId}/messages`).set(auth);
      return res.body[res.body.length - 1].attachment.url as string;
    };
    // Dos lecturas seguidas: la misma URL (salvo que justo cambie el tramo de 5 min).
    const first = await urlOf();
    const second = await urlOf();
    if (Math.floor(Date.now() / 300_000) === Math.floor((Date.now() - 2000) / 300_000)) {
      expect(second).toBe(first);
    }

    // Lo subido y nunca enviado se borra; lo enviado se queda.
    const orphan = await http()
      .post(`/customers/${customerId}/messages/upload-url`)
      .set(auth)
      .send({ mimeType: 'image/png' })
      .expect(200);
    await fetch(orphan.body.uploadUrl as string, {
      method: 'PUT',
      headers: orphan.body.requiredHeaders as Record<string, string>,
      body: PNG,
    });
    const removed = await app
      .get(DataRetentionService)
      .cleanupOrphanAttachments(new Date(Date.now() + 25 * 3_600_000));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await fetch(await urlOf())).status).toBe(200);
  });

  it('tickets: leído por persona, respuesta en curso y sin escribir en uno cerrado', async () => {
    const owner = await registerVerifiedUser(app, 'msgticket');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const readonly = await teamMember(auth, owner.slug, 'readonly');

    // Todo el equipo puede abrir tickets.
    const created = await http()
      .post('/support/tickets')
      .set(readonly.auth)
      .send({ subject: 'Duda del equipo', body: 'No encuentro la factura', priority: 'normal' })
      .expect(201);
    const id = created.body.id as string;

    await http()
      .post(`/admin/support/tickets/${id}/transition`)
      .set(adminAuth)
      .send({ status: 'in_progress' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    await http()
      .post(`/admin/support/tickets/${id}/messages`)
      .set(adminAuth)
      .send({ body: 'Mira en Facturas', isInternal: false })
      .expect(201);
    const after = await http().get(`/admin/support/tickets/${id}`).set(adminAuth).expect(200);
    expect(after.body.status).toBe('waiting_user');

    // Leer el ticket baja el contador de quien lo lee, no el del resto.
    const waiting = (a: Record<string, string>) =>
      http().get('/support/tickets/waiting-count').set(a).expect(200);
    expect((await waiting(auth)).body.count).toBe(1);
    expect((await waiting(readonly.auth)).body.count).toBe(1);
    await http().get(`/support/tickets/${id}`).set(auth).expect(200);
    expect((await waiting(auth)).body.count).toBe(0);
    expect((await waiting(readonly.auth)).body.count).toBe(1);
    const list = await http().get('/support/tickets').set(readonly.auth).expect(200);
    expect(list.body[0].unreadCount).toBe(1);

    // En uno cerrado el admin solo deja notas: el cliente no podría contestar.
    await http()
      .post(`/admin/support/tickets/${id}/transition`)
      .set(adminAuth)
      .send({ status: 'closed' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    const closed = await http()
      .post(`/admin/support/tickets/${id}/messages`)
      .set(adminAuth)
      .send({ body: 'Una cosa más', isInternal: false });
    expect(closed.status).toBe(400);
    expect(closed.body.code).toBe('ticket_closed');
    await http()
      .post(`/admin/support/tickets/${id}/messages`)
      .set(adminAuth)
      .send({ body: 'Nota', isInternal: true })
      .expect(201);
  });

  it('los mensajes de TrasterOS son del propietario y el gestor, con leído por persona', async () => {
    const owner = await registerVerifiedUser(app, 'msgplatform');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const manager = await teamMember(auth, owner.slug, 'manager');
    const staff = await teamMember(auth, owner.slug, 'staff');
    const readonly = await teamMember(auth, owner.slug, 'readonly');

    await http()
      .post(`/admin/tenants/${owner.tenantId}/email`)
      .set(adminAuth)
      .send({
        subject: 'Revisión de tu cuenta',
        body: 'Te escribimos sobre tu cuenta',
        replyExpected: false,
      })
      .expect((res) => expect([200, 201]).toContain(res.status));

    for (const who of [staff.auth, readonly.auth]) {
      await http().get('/support/platform-messages').set(who).expect(403);
      const bell = await http().get('/notifications').set(who).expect(200);
      expect(
        (bell.body.items as { type: string }[]).some((n) => n.type === 'platform.message'),
      ).toBe(false);
    }

    const unread = async (a: Record<string, string>) =>
      (await http().get('/support/platform-messages').set(a).expect(200)).body.unread as number;
    expect(await unread(auth)).toBe(1);
    expect(await unread(manager.auth)).toBe(1);
    await http().post('/support/platform-messages/read').set(auth).expect(204);
    expect(await unread(auth)).toBe(0);
    expect(await unread(manager.auth)).toBe(1);
  });

  it('un correo entrante llega sin lo citado y uno sin destinatario no se pierde', async () => {
    const owner = await registerVerifiedUser(app, 'msginbound');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `msg-in-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    await http()
      .post('/webhooks/email-inbound')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({
        from: email,
        text: 'Me viene bien el martes\n\nEl lun, 3 nov 2026 a las 10:12, Trasteros escribió:\n> ¿Cuándo vienes?',
        dmarc: 'pass',
      })
      .expect(200);
    const thread = await http().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    expect(thread.body[0].body).toBe('Me viene bien el martes');

    const stranger = `desconocido-${Date.now()}@e2e.local`;
    const res = await http()
      .post('/webhooks/email-inbound')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({ from: stranger, text: 'Quiero un trastero', dmarc: 'pass' })
      .expect(200);
    expect(res.body.received).toBe(false);
    const notice = await prisma.superAdminNotification.findFirst({
      where: { type: 'inbound.unmatched', body: { contains: stranger } },
    });
    expect(notice?.body).toContain('Quiero un trastero');
    await prisma.superAdminNotification.deleteMany({ where: { id: notice!.id } });
  });
});
