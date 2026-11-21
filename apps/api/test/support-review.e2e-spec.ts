import request from 'supertest';

import {
  SUPPORT_TICKETS_PER_HOUR,
  SupportTicketsService,
} from '../src/modules/admin/support-tickets.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión del soporte del panel del tenant (tickets y «Mensajes de TrasterOS»). */
describe('Soporte del tenant: revisión (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaAdminService;
  let adminAuth: { Authorization: string };
  let adminId: string;

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    prisma = app.get(PrismaAdminService);
    const admin = await seedSuperAdmin('supreview');
    adminId = admin.id;
    const login = await api()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    adminAuth = { Authorization: `Bearer ${login.body.accessToken as string}` };
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('valida en español y limita los tickets por hora', async () => {
    const owner = await registerVerifiedUser(app, 'supreviewa');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const empty = await api().post('/support/tickets').set(auth).send({ subject: '', body: '' });
    expect(empty.status).toBe(400);
    expect(JSON.stringify(empty.body)).toContain('Escribe un asunto de al menos 3 caracteres');
    expect(JSON.stringify(empty.body)).not.toContain('String must contain');

    for (let i = 0; i < SUPPORT_TICKETS_PER_HOUR; i += 1) {
      await api()
        .post('/support/tickets')
        .set(auth)
        .send({ subject: `Consulta ${i + 1}`, body: 'Hola', priority: 'normal' })
        .expect(201);
    }
    const tooMany = await api()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'Una más', body: 'Hola', priority: 'normal' });
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.code).toBe('too_many_tickets');
    expect(tooMany.body.message).toContain('última hora');

    // Por páginas: 2 + 2 + 1, sin repetir.
    const first = await api().get('/support/tickets/page?limit=2').set(auth).expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await api()
      .get(`/support/tickets/page?limit=2&cursor=${first.body.nextCursor as string}`)
      .set(auth)
      .expect(200);
    const third = await api()
      .get(`/support/tickets/page?limit=2&cursor=${second.body.nextCursor as string}`)
      .set(auth)
      .expect(200);
    expect(third.body.items).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items, ...third.body.items].map(
      (t: { id: string }) => t.id,
    );
    expect(new Set(ids).size).toBe(SUPPORT_TICKETS_PER_HOUR);
    expect(first.body.items[0].createdByName).toBeTruthy();
    await api().get('/support/tickets/page?cursor=nope').set(auth).expect(400);
    // La lista de siempre sigue respondiendo con un array.
    const all = await api().get('/support/tickets').set(auth).expect(200);
    expect(Array.isArray(all.body)).toBe(true);
  });

  it('guarda por qué se cierra, firma como soporte y no se valora sin respuesta', async () => {
    const owner = await registerVerifiedUser(app, 'supreviewb');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const newTicket = async (subject: string) => {
      const t = await api()
        .post('/support/tickets')
        .set(auth)
        .send({ subject, body: 'Hola', priority: 'normal' })
        .expect(201);
      return t.body.id as string;
    };

    // Cerrado por el propio tenant sin que nadie respondiera: no se valora.
    const mine = await newTicket('Ya lo he resuelto');
    const closed = await api().post(`/support/tickets/${mine}/close`).set(auth).expect(200);
    expect(closed.body.closedReason).toBe('tenant');
    const rate = await api().post(`/support/tickets/${mine}/rating`).set(auth).send({ score: 4 });
    expect(rate.status).toBe(400);
    expect(rate.body.code).toBe('ticket_not_answered');

    // Cerrado por falta de respuesta.
    const waiting = await newTicket('Falla la factura');
    await prisma.superAdmin.update({ where: { id: adminId }, data: { fullName: 'Ana Comercial' } });
    await api()
      .post(`/admin/support/tickets/${waiting}/messages`)
      .set(adminAuth)
      .send({ body: '¿Nos mandas una captura?', isInternal: false })
      .expect(201);
    const detail = await api().get(`/support/tickets/${waiting}`).set(auth).expect(200);
    const reply = (
      detail.body.messages as { authorAdminId: string | null; authorAdminName: string }[]
    ).find((m) => m.authorAdminId);
    expect(reply?.authorAdminName).toBe('Ana · Soporte de TrasterOS');

    const tickets = app.get(SupportTicketsService);
    const old = (days: number) => new Date(Date.now() - days * 86_400_000);
    await prisma.$executeRaw`UPDATE support_tickets SET updated_at = ${old(6)} WHERE id = ${waiting}::uuid`;
    await tickets.remindWaiting();
    await prisma.$executeRaw`UPDATE support_tickets SET updated_at = ${old(11)} WHERE id = ${waiting}::uuid`;
    await tickets.remindWaiting();
    const after = await api().get(`/support/tickets/${waiting}`).set(auth).expect(200);
    expect(after.body.status).toBe('closed');
    expect(after.body.closedReason).toBe('inactivity');
    // Con respuesta del soporte sí se valora.
    await api().post(`/support/tickets/${waiting}/rating`).set(auth).send({ score: 5 }).expect(200);

    // Cerrado por el soporte y reabierto: el motivo se va.
    const byAdmin = await newTicket('Duda de precios');
    const t1 = await api()
      .post(`/admin/support/tickets/${byAdmin}/transition`)
      .set(adminAuth)
      .send({ status: 'closed' });
    expect(t1.body.closedReason).toBe('admin');
    const t2 = await api()
      .post(`/admin/support/tickets/${byAdmin}/transition`)
      .set(adminAuth)
      .send({ status: 'open' });
    expect(t2.body.closedReason).toBeNull();

    // Un ticket que no existe.
    await api().get('/support/tickets/00000000-0000-0000-0000-000000000000').set(auth).expect(404);
    await api().get('/support/tickets/nope').set(auth).expect(400);
  });

  it('el soporte entrando en nombre del tenant no deja nada leído', async () => {
    const owner = await registerVerifiedUser(app, 'supreviewc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Un ticket con respuesta sin leer y un mensaje de TrasterOS sin leer.
    const created = await api()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'No me carga', body: 'Hola', priority: 'normal' })
      .expect(201);
    const ticketId = created.body.id as string;
    await api()
      .post(`/admin/support/tickets/${ticketId}/messages`)
      .set(adminAuth)
      .send({ body: 'Ya lo miramos', isInternal: false })
      .expect(201);
    await prisma.tenantPlatformMessage.create({
      data: { tenantId: owner.tenantId, kind: 'announcement', subject: 'Novedad', body: 'Hola' },
    });

    const waitingBefore = await api().get('/support/tickets/waiting-count').set(auth).expect(200);
    expect(waitingBefore.body.count).toBe(1);
    const unreadBefore = await api()
      .get('/support/platform-messages/unread-count')
      .set(auth)
      .expect(200);
    expect(unreadBefore.body.count).toBe(1);

    const imp = await api()
      .post(`/admin/tenants/${owner.tenantId}/impersonate`)
      .set(adminAuth)
      .send({ reason: 'revisar el soporte', readOnly: false })
      .expect(200);
    const impAuth = { Authorization: `Bearer ${imp.body.accessToken as string}` };
    await api().get(`/support/tickets/${ticketId}`).set(impAuth).expect(200);
    await api().get('/support/platform-messages').set(impAuth).expect(200);
    await api().post('/support/platform-messages/read').set(impAuth).send({}).expect(204);

    expect(await prisma.supportTicketRead.count({ where: { ticketId } })).toBe(0);
    expect(await prisma.tenantPlatformMessageRead.count({ where: { userId: owner.userId } })).toBe(
      0,
    );
    const waitingAfter = await api().get('/support/tickets/waiting-count').set(auth).expect(200);
    expect(waitingAfter.body.count).toBe(1);
    const unreadAfter = await api()
      .get('/support/platform-messages/unread-count')
      .set(auth)
      .expect(200);
    expect(unreadAfter.body.count).toBe(1);

    // La propia persona sí los deja leídos.
    await api().get(`/support/tickets/${ticketId}`).set(auth).expect(200);
    await api().post('/support/platform-messages/read').set(auth).send({}).expect(204);
    expect((await api().get('/support/tickets/waiting-count').set(auth)).body.count).toBe(0);
    expect((await api().get('/support/platform-messages/unread-count').set(auth)).body.count).toBe(
      0,
    );
  });
});
