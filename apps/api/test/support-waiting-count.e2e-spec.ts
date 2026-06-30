import request from 'supertest';

import { SupportTicketsService } from '../src/modules/admin/support-tickets.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Soporte: badge de tickets esperando respuesta del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('cuenta los tickets en waiting_user (el admin ya respondió)', async () => {
    const owner = await registerVerifiedUser(app, 'supportwc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin tickets → 0.
    const empty = await request(app.getHttpServer())
      .get('/support/tickets/waiting-count')
      .set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.count).toBe(0);

    // El tenant abre un ticket (queda 'open', no cuenta aún).
    const created = await request(app.getHttpServer()).post('/support/tickets').set(auth).send({
      subject: 'No me carga la facturación',
      priority: 'normal',
      body: 'Ayuda, por favor.',
    });
    expect(created.status).toBe(201);
    const ticketId = created.body.id as string;

    const afterCreate = await request(app.getHttpServer())
      .get('/support/tickets/waiting-count')
      .set(auth);
    expect(afterCreate.body.count).toBe(0);

    // El badge del admin: el ticket recién creado (open) cuenta como pendiente.
    const ticketsService = app.get(SupportTicketsService);
    expect(await ticketsService.countOpenForAdmin()).toBeGreaterThanOrEqual(1);

    // Simulamos que el admin respondió → ticket a 'waiting_user'.
    const prismaAdmin = app.get(PrismaAdminService);
    await prismaAdmin.supportTicket.update({
      where: { id: ticketId },
      data: { status: 'waiting_user' },
    });

    const waiting = await request(app.getHttpServer())
      .get('/support/tickets/waiting-count')
      .set(auth);
    expect(waiting.body.count).toBe(1);

    // El tenant responde → el ticket vuelve a 'open' y el badge baja.
    await request(app.getHttpServer())
      .post(`/support/tickets/${ticketId}/messages`)
      .set(auth)
      .send({ body: 'Sigue fallando, gracias.' })
      .expect(201);

    const resolved = await request(app.getHttpServer())
      .get('/support/tickets/waiting-count')
      .set(auth);
    expect(resolved.body.count).toBe(0);

    // Sin sesión → 401.
    await request(app.getHttpServer()).get('/support/tickets/waiting-count').expect(401);
  });
});
