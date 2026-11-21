import { hash as argonHash } from '@node-rs/argon2';
import { DEFAULT_SUPPORT_RESPONSE_HOURS, SUPPORT_TICKET_REOPEN_DAYS } from '@storageos/shared';
import request from 'supertest';

import { SupportTicketsService } from '../src/modules/admin/support-tickets.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Mejoras del soporte del panel del tenant. */
describe('Soporte del tenant: mejoras (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaAdminService;

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    prisma = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    // El estado del servicio es global: se deja como estaba.
    await prisma.platformServiceIncident.deleteMany({
      where: { createdByName: { startsWith: 'Test ' } },
    });
    await prisma.platformServiceStatus.updateMany({
      data: { status: 'ok', message: null, updatedByName: null },
    });
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  /** Un compañero activo del mismo negocio, creado directamente. */
  async function teammate(tenantId: string, tag: string) {
    return prisma.user.create({
      data: {
        tenantId,
        email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`,
        fullName: `Compañero ${tag}`,
        role: 'staff',
        passwordHash: await argonHash('Passw0rd!'),
        emailVerifiedAt: new Date(),
      },
    });
  }

  it('guarda categoría, pantalla y navegador; correo de confirmación y copia a un compañero', async () => {
    const owner = await registerVerifiedUser(app, 'supimpa');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const mate = await teammate(owner.tenantId, 'supimpamate');

    // Una categoría fuera de la lista no vale.
    await api()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'Mala categoría', body: 'Hola', category: 'cosas' })
      .expect(400);

    const team = await api().get('/support/teammates').set(auth).expect(200);
    expect((team.body as { id: string }[]).map((u) => u.id)).toContain(mate.id);
    expect((team.body as { id: string }[]).map((u) => u.id)).not.toContain(owner.userId);

    const created = await api()
      .post('/support/tickets')
      .set(auth)
      .set('User-Agent', 'NavegadorDePrueba/1.0')
      .send({
        subject: 'No cuadra la remesa',
        body: 'La remesa de este mes sale con un importe raro.',
        priority: 'normal',
        category: 'billing',
        pageUrl: '/sepa-remittances?id=1',
        screenSize: '1280x720',
        aiAnswer: 'Revisa las facturas incluidas en la remesa.',
        watcherUserIds: [mate.id],
      })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.category).toBe('billing');
    expect(created.body.pageUrl).toBe('/sepa-remittances?id=1');
    expect(created.body.screenSize).toBe('1280x720');
    expect(created.body.userAgent).toBe('NavegadorDePrueba/1.0');
    expect(created.body.aiAnswer).toBe('Revisa las facturas incluidas en la remesa.');

    const detail = await api().get(`/support/tickets/${id}`).set(auth).expect(200);
    expect(detail.body.watchers).toEqual([
      expect.objectContaining({ userId: mate.id, fullName: 'Compañero supimpamate' }),
    ]);

    // Correo de «lo hemos recibido» a quien lo abre y aviso a quien está en copia.
    const confirm = await waitForEmail(owner.email, {
      subjectIncludes: 'Hemos recibido tu ticket',
    });
    expect(confirm.Text).toContain('Solemos responder');
    expect(confirm.Text).toContain(`/support/${id}`);
    await waitForEmail(mate.email, { subjectIncludes: 'Te han puesto en copia' });

    // La respuesta del soporte llega también al compañero en copia.
    const sa = await seedSuperAdmin('supimpa');
    await app.get(SupportTicketsService).addMessageAsAdmin({
      superAdminId: sa.id,
      ticketId: id,
      input: { body: 'Ya lo hemos corregido.', isInternal: false },
    });
    const reply = await waitForEmail(mate.email, { subjectIncludes: 'te ha respondido' });
    expect(reply.Text).toContain('Ya lo hemos corregido.');

    // Quitarlo de la copia; uno de otro negocio no vale.
    await api().put(`/support/tickets/${id}/watchers`).set(auth).send({ userIds: [] }).expect(200);
    const other = await registerVerifiedUser(app, 'supimpaother');
    await api()
      .put(`/support/tickets/${id}/watchers`)
      .set(auth)
      .send({ userIds: [other.userId] })
      .expect(400);
  });

  it('filtra por estado, «solo los míos» y texto', async () => {
    const owner = await registerVerifiedUser(app, 'supimpb');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const mate = await teammate(owner.tenantId, 'supimpbmate');
    const tickets = app.get(SupportTicketsService);

    const mine = await api()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'Puerta del local', body: 'La cerradura no abre con el PIN.' })
      .expect(201);
    const theirs = await tickets.createForTenant({
      tenantId: owner.tenantId,
      userId: mate.id,
      input: {
        subject: 'Factura duplicada',
        body: 'Sale dos veces la factura de marzo.',
        priority: 'normal',
      },
    });
    await prisma.supportTicket.update({
      where: { id: theirs.id },
      data: { status: 'waiting_user' },
    });

    const ids = (body: { items: { id: string }[] }) => body.items.map((t) => t.id);

    const all = await api().get('/support/tickets/page').set(auth).expect(200);
    expect(ids(all.body)).toEqual(expect.arrayContaining([mine.body.id, theirs.id]));

    const onlyMine = await api().get('/support/tickets/page?mine=1').set(auth).expect(200);
    expect(ids(onlyMine.body)).toEqual([mine.body.id]);

    const waiting = await api().get('/support/tickets/page?status=waiting').set(auth).expect(200);
    expect(ids(waiting.body)).toEqual([theirs.id]);

    const open = await api().get('/support/tickets/page?status=open').set(auth).expect(200);
    expect(ids(open.body)).toEqual([mine.body.id]);

    // Busca en el asunto y en los mensajes.
    const bySubject = await api()
      .get('/support/tickets/page?search=duplicada')
      .set(auth)
      .expect(200);
    expect(ids(bySubject.body)).toEqual([theirs.id]);
    const byBody = await api().get('/support/tickets/page?search=cerradura').set(auth).expect(200);
    expect(ids(byBody.body)).toEqual([mine.body.id]);

    await api().get('/support/tickets/page?status=raro').set(auth).expect(400);
  });

  it('reabre dentro del plazo, no después, y cambia la prioridad', async () => {
    const owner = await registerVerifiedUser(app, 'supimpc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const t = await api()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'No sale el informe', body: 'El informe mensual no se genera.' })
      .expect(201);
    const id = t.body.id as string;

    // Prioridad: subirla avisa al soporte y queda en el registro.
    const since = new Date();
    const up = await api().patch(`/support/tickets/${id}`).set(auth).send({ priority: 'urgent' });
    expect(up.status).toBe(200);
    expect(up.body.priority).toBe('urgent');
    const notice = await prisma.superAdminNotification.findFirst({
      where: { link: `/admin/support/${id}`, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
    expect(notice?.title).toContain('urgente');
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: id, action: 'support_ticket.priority_changed' },
    });
    expect(audit).toBeTruthy();

    // No se reabre uno que no está cerrado.
    await api().post(`/support/tickets/${id}/reopen`).set(auth).expect(400);

    await api().post(`/support/tickets/${id}/close`).set(auth).expect(200);
    const closed = await api().get(`/support/tickets/${id}`).set(auth).expect(200);
    expect(closed.body.reopenableUntil).toBeTruthy();
    // Cerrado no se cambia la prioridad.
    await api().patch(`/support/tickets/${id}`).set(auth).send({ priority: 'low' }).expect(400);

    const reopened = await api().post(`/support/tickets/${id}/reopen`).set(auth).expect(200);
    expect(reopened.body.status).toBe('open');
    expect(reopened.body.closedReason).toBeNull();

    // Pasados los días de plazo, ya no.
    await api().post(`/support/tickets/${id}/close`).set(auth).expect(200);
    await prisma.supportTicket.update({
      where: { id },
      data: { closedAt: new Date(Date.now() - (SUPPORT_TICKET_REOPEN_DAYS + 1) * 86_400_000) },
    });
    const late = await api().post(`/support/tickets/${id}/reopen`).set(auth);
    expect(late.status).toBe(400);
    expect(late.body.code).toBe('ticket_reopen_expired');
  });

  it('estado del servicio: lo publica el super admin, el soporte no, y lo ve el negocio', async () => {
    const owner = await registerVerifiedUser(app, 'supimpd');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const admin = await seedSuperAdmin('supimpd');
    const login = await api()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    const adminAuth = { Authorization: `Bearer ${login.body.accessToken as string}` };

    const support = await seedSuperAdmin('supimpdsupport');
    await prisma.superAdmin.update({ where: { id: support.id }, data: { role: 'support' } });
    const supportLogin = await api()
      .post('/admin/auth/login')
      .send({ email: support.email, password: support.password })
      .expect(200);
    const supportAuth = { Authorization: `Bearer ${supportLogin.body.accessToken as string}` };

    // Sin mensaje no se publica una incidencia.
    await api()
      .put('/admin/service-status')
      .set(adminAuth)
      .send({ status: 'incident', message: '' })
      .expect(400);
    const put = await api()
      .put('/admin/service-status')
      .set(adminAuth)
      .send({ status: 'incident', message: 'Los cobros con tarjeta fallan.' })
      .expect(200);
    expect(put.body.status).toBe('incident');
    expect(put.body.incidents[0]).toMatchObject({ status: 'incident', resolvedAt: null });

    // El rol soporte lo consulta pero no lo cambia.
    await api().get('/admin/service-status').set(supportAuth).expect(200);
    await api().put('/admin/service-status').set(supportAuth).send({ status: 'ok' }).expect(403);

    const seen = await api().get('/support/service-status').set(auth).expect(200);
    expect(seen.body).toMatchObject({
      status: 'incident',
      message: 'Los cobros con tarjeta fallan.',
    });

    // Volver a la normalidad cierra la incidencia.
    const ok = await api()
      .put('/admin/service-status')
      .set(adminAuth)
      .send({ status: 'ok' })
      .expect(200);
    expect(ok.body.status).toBe('ok');
    expect(ok.body.message).toBeNull();
    expect(ok.body.incidents[0].resolvedAt).toBeTruthy();
    const after = await api().get('/support/service-status').set(auth).expect(200);
    expect(after.body.status).toBe('ok');
  });

  it('da el plazo de respuesta orientativo por prioridad', async () => {
    const owner = await registerVerifiedUser(app, 'supimpe');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const res = await api().get('/support/response-times').set(auth).expect(200);
    expect(res.body.days).toBe(90);
    for (const p of ['urgent', 'high', 'normal', 'low'] as const) {
      const entry = res.body.byPriority[p] as { hours: number; sample: number; fromData: boolean };
      expect(entry.hours).toBeGreaterThanOrEqual(0);
      if (!entry.fromData) expect(entry.hours).toBe(DEFAULT_SUPPORT_RESPONSE_HOURS[p]);
    }
    await request(app.getHttpServer()).get('/support/response-times').expect(401);
  });
});
