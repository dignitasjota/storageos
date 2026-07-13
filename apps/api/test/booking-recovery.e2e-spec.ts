import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BookingRecoveryService } from '../src/modules/move-in/booking-recovery.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Recuperación de reservas abandonadas: un lead de booking `new` sin convertir
 * (1-72 h) recibe UN recordatorio de nurture; es idempotente.
 */
describe('Recuperación de reservas abandonadas (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('recuerda una vez al lead de booking abandonado; no duplica', async () => {
    const owner = await registerVerifiedUser(app, 'bookrecov');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `abandona-${Date.now()}@e2e.local`;

    // El visitante deja su email en el booking pero no completa la reserva.
    const cap = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}/lead`)
      .send({ email, firstName: 'Leo' });
    expect(cap.status).toBe(201);
    expect(cap.body.captured).toBe(true);

    const lead = await admin.lead.findFirst({ where: { email, tenantId: owner.tenantId } });
    expect(lead).toBeTruthy();

    // Backdatamos su createdAt 2 h atrás para que entre en la ventana [1h, 72h].
    await admin.lead.update({
      where: { id: lead!.id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const recovery = app.get(BookingRecoveryService);
    const first = await recovery.sendDueReminders();
    expect(first.reminded).toBeGreaterThanOrEqual(1);

    // El lead queda marcado + hay una comunicación de recuperación encolada.
    const after = await admin.lead.findUnique({ where: { id: lead!.id } });
    expect(after?.bookingReminderSentAt).not.toBeNull();
    const comm = await admin.communication.findFirst({
      where: { tenantId: owner.tenantId, leadId: lead!.id, source: 'booking_recovery' },
    });
    expect(comm).toBeTruthy();
    expect(comm?.recipient).toBe(email);

    // Segunda pasada: NO reenvía (idempotente por bookingReminderSentAt).
    const second = await recovery.sendDueReminders();
    const commsCount = await admin.communication.count({
      where: { tenantId: owner.tenantId, leadId: lead!.id, source: 'booking_recovery' },
    });
    expect(commsCount).toBe(1);
    expect(second.reminded).toBe(0);

    // Un lead ya contactado (convertido/qualified) no se recuerda.
    void auth;
  });
});
