import request from 'supertest';

import { SupportTicketsService } from '../src/modules/admin/support-tickets.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Soporte: avisos de los tickets en los dos sentidos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
  });

  it('avisa al tenant de la respuesta del admin y al admin de la del tenant; responder reabre un resuelto', async () => {
    const owner = await registerVerifiedUser(app, 'supnotice');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    const prisma = app.get(PrismaAdminService);
    const tickets = app.get(SupportTicketsService);
    const sa = await seedSuperAdmin('supnotice');

    const created = await http()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'No me cuadra la caja', priority: 'normal', body: 'Ayuda.' })
      .expect(201);
    const ticketId = created.body.id as string;

    // El admin responde → notificación del panel del tenant + correo a quien lo abrió.
    await tickets.addMessageAsAdmin({
      superAdminId: sa.id,
      ticketId,
      input: { body: 'Revisa el cierre de ayer.', isInternal: false },
    });
    const notifs = await http().get('/notifications').set(auth).expect(200);
    const list = (notifs.body.items ?? notifs.body) as { type: string; link: string }[];
    expect(list.some((n) => n.type === 'support.reply' && n.link === `/support/${ticketId}`)).toBe(
      true,
    );
    const mail = await waitForEmail(owner.email, { subjectIncludes: 'No me cuadra la caja' });
    expect(mail.Text).toContain('Revisa el cierre de ayer.');

    // Una nota interna no avisa.
    const before = list.length;
    await tickets.addMessageAsAdmin({
      superAdminId: sa.id,
      ticketId,
      input: { body: 'nota interna', isInternal: true },
    });
    const after = await http().get('/notifications').set(auth).expect(200);
    expect(((after.body.items ?? after.body) as unknown[]).length).toBe(before);

    // El admin lo resuelve; el tenant responde → se reabre y el admin recibe aviso.
    await tickets.transition({ superAdminId: sa.id, ticketId, input: { status: 'resolved' } });
    const since = new Date();
    await http()
      .post(`/support/tickets/${ticketId}/messages`)
      .set(auth)
      .send({ body: 'Sigue sin cuadrar.' })
      .expect(201);
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(row.status).toBe('open');
    const adminNotice = await prisma.superAdminNotification.findFirst({
      where: { link: `/admin/support/${ticketId}`, createdAt: { gte: since } },
    });
    expect(adminNotice?.title).toContain('reabre');
  });
});
