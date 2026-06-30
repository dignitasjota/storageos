import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Ticket de soporte → interacción en el histórico del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('al abrir un ticket, lo registra como interacción con enlace al ticket', async () => {
    const owner = await registerVerifiedUser(app, 'tktinteract');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const created = await request(app.getHttpServer())
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'No puedo emitir facturas', priority: 'high', body: 'Me da error 500.' });
    expect(created.status).toBe(201);
    const ticketId = created.body.id as string;

    // Debe existir una interacción tipo 'support' con enlace al ticket.
    const prismaAdmin = app.get(PrismaAdminService);
    const interaction = await prismaAdmin.tenantInteraction.findFirst({
      where: { tenantId: owner.tenantId, type: 'support' },
    });
    expect(interaction).toBeTruthy();
    expect(interaction?.link).toBe(`/admin/support/${ticketId}`);
    expect(interaction?.superAdminId).toBeNull();
    expect(interaction?.content).toContain('No puedo emitir facturas');
    expect(interaction?.content).toContain('Me da error 500.');
  });
});
