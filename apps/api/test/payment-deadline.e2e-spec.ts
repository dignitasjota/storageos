import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Ampliar el plazo para firmar y pagar una reserva online: el trastero sigue
 * reservado, el inquilino recibe el aviso y la reserva no caduca.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;

function day(offset: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + offset * DAY),
  );
}

describe('Ampliar el plazo para firmar y pagar (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('amplía una reserva online, avisa al inquilino y no la deja caducar', async () => {
    const owner = await registerVerifiedUser(app, 'pdl');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const email = `res-${Date.now()}@e2e.local`;
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: fac.facilityId,
        unitTypeId: fac.unitTypeId,
        startDate: day(2),
        customer: {
          firstName: 'Rosa',
          lastName: 'Gil',
          email,
          phone: '600000000',
          documentNumber: '12345678Z',
        },
      })
      .expect(201);
    const contractId = booking.body.contractId as string;
    const before = await db.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(before.firstPaymentDeadline).not.toBeNull();

    const signing = await http().get(`/contracts/${contractId}/signing`).set(auth).expect(200);
    expect(signing.body.paymentDeadline).toBe(before.firstPaymentDeadline!.toISOString());
    expect(new Date(signing.body.paymentDeadlineMax).getTime()).toBe(
      before.createdAt.getTime() + 30 * DAY,
    );

    // Validación: o días o fecha; ni más de 30 días ni hacia atrás.
    await http()
      .post(`/contracts/${contractId}/payment-deadline`)
      .set(auth)
      .send({ days: 0 })
      .expect(400);
    await http()
      .post(`/contracts/${contractId}/payment-deadline`)
      .set(auth)
      .send({ days: 2, until: day(5) })
      .expect(400);
    const tooFar = await http()
      .post(`/contracts/${contractId}/payment-deadline`)
      .set(auth)
      .send({ until: day(40) })
      .expect(400);
    expect(tooFar.body.code).toBe('deadline_too_far');
    const earlier = await http()
      .post(`/contracts/${contractId}/payment-deadline`)
      .set(auth)
      .send({ until: day(1) })
      .expect(400);
    expect(earlier.body.code).toBe('deadline_not_later');

    // +3 días, con aviso por correo.
    const res = await http()
      .post(`/contracts/${contractId}/payment-deadline`)
      .set(auth)
      .send({ days: 3, reason: 'Paga el lunes', notifyCustomer: true })
      .expect(200);
    expect(new Date(res.body.paymentDeadline).getTime()).toBe(
      before.firstPaymentDeadline!.getTime() + 3 * DAY,
    );
    expect(res.body.notified).toBe(true);
    const mail = await db.communication.findFirstOrThrow({
      where: { contractId, source: 'booking.deadline_extended' },
    });
    expect(mail.subject).toContain('Te guardamos el trastero');
    expect(mail.bodyText).toContain('/sign/');
    const after = await db.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(after.bookingReminderSentAt).not.toBeNull();
    expect(after.signingTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      after.firstPaymentDeadline!.getTime(),
    );
    const event = await db.contractEvent.findFirstOrThrow({
      where: { contractId, eventType: 'note_added' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event.payload).toMatchObject({
      event: 'payment_deadline_extended',
      reason: 'Paga el lunes',
    });

    // Vencido pero aún sin cancelar: se puede ampliar desde ahora y ya no caduca.
    await db.contract.update({
      where: { id: contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - 60_000) },
    });
    const late = await http().get(`/contracts/${contractId}/signing`).set(auth).expect(200);
    expect(late.body.holdUntil).toBeNull();
    expect(late.body.paymentDeadline).not.toBeNull();
    await http()
      .post(`/contracts/${contractId}/payment-deadline`)
      .set(auth)
      .send({ days: 1, notifyCustomer: false })
      .expect(200);
    await app.get(SignaturesService).expireUnpaidBookings();
    expect((await db.contract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe(
      'draft',
    );
    expect((await db.unit.findUniqueOrThrow({ where: { id: fac.unitIds[0]! } })).status).toBe(
      'reserved',
    );
  });

  it('un contrato sin plazo (firmado en el local) no se puede ampliar', async () => {
    const owner = await registerVerifiedUser(app, 'pdm');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const draft = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: fac.unitIds[0],
        startDate: day(1),
        priceMonthly: 50,
      })
      .expect(201);
    const signing = await http().get(`/contracts/${draft.body.id}/signing`).set(auth).expect(200);
    expect(signing.body.paymentDeadline).toBeNull();
    expect(signing.body.paymentDeadlineMax).toBeNull();
    const res = await http()
      .post(`/contracts/${draft.body.id}/payment-deadline`)
      .set(auth)
      .send({ days: 3 })
      .expect(409);
    expect(res.body.code).toBe('no_payment_deadline');
  });
});
