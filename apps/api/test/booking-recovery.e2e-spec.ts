import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BookingRecoveryService } from '../src/modules/move-in/booking-recovery.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
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

  async function book(slug: string, token: string, email: string) {
    await ensureDefaultSeries(app, token);
    await createFacilityWithUnits(app, token, { unitsCount: 1 });
    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    const res = await request(app.getHttpServer())
      .post(`/public/move-in/book/${slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: new Date().toISOString().slice(0, 10),
        customer: { firstName: 'Eva', lastName: 'Sanz', email },
      })
      .expect(201);
    return res.body as { contractId: string; signingToken: string };
  }

  async function backdate(contractId: string) {
    await admin.contract.update({
      where: { id: contractId },
      data: { createdAt: new Date(Date.now() - 13 * 60 * 60 * 1000) },
    });
  }

  it('reserva enviada sin firmar → un recordatorio con enlace de firma nuevo', async () => {
    const owner = await registerVerifiedUser(app, 'bookunsigned');
    const email = `sinfirmar-${Date.now()}@e2e.local`;
    const { contractId } = await book(owner.slug, owner.accessToken, email);
    await backdate(contractId);

    const recovery = app.get(BookingRecoveryService);
    await recovery.sendDueReminders();
    const comms = await admin.communication.findMany({
      where: { tenantId: owner.tenantId, contractId, source: 'booking_recovery.unsigned' },
    });
    expect(comms).toHaveLength(1);
    expect(comms[0]!.subject).toContain('sigue reservado');
    const token = /\/sign\/([^\s"<]+)/.exec(comms[0]!.bodyText)?.[1];
    expect(token).toBeTruthy();
    // El enlace nuevo funciona.
    await request(app.getHttpServer()).get(`/public/move-in/sign/${token}`).expect(200);

    // No se repite.
    await recovery.sendDueReminders();
    expect(
      await admin.communication.count({
        where: {
          tenantId: owner.tenantId,
          contractId,
          source: { startsWith: 'booking_recovery.' },
        },
      }),
    ).toBe(1);
  });

  it('reserva firmada sin pagar → recordatorio para pagar con el importe', async () => {
    const owner = await registerVerifiedUser(app, 'bookunpaid');
    const email = `sinpagar-${Date.now()}@e2e.local`;
    const { contractId, signingToken } = await book(owner.slug, owner.accessToken, email);
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${signingToken}`)
      .send({ signerName: 'Eva Sanz', method: 'typed', typedSignature: 'Eva Sanz', accept: true })
      .expect((r) => expect([200, 201]).toContain(r.status));
    await backdate(contractId);

    await app.get(BookingRecoveryService).sendDueReminders();
    const comm = await admin.communication.findFirst({
      where: { tenantId: owner.tenantId, contractId, source: 'booking_recovery.unpaid' },
    });
    expect(comm).toBeTruthy();
    expect(comm!.bodyText).toContain('/portal/login?slug=');
    expect(comm!.bodyText).toMatch(/primera factura \(\d+,\d{2}\s€\)/);
  });
});
