import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de «Hoy»: contratos que se renuevan solos, firmas de contratos
 * cancelados, facturas vencidas aún sin marcar, mensajes leídos por usuario y
 * la fecha de cada entrada.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
// Día de calendario en Madrid (la zona del tenant de prueba).
const isoDay = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + offset * DAY),
  );

describe('Revisión de «Hoy» (e2e)', () => {
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

  it('contratos, firmas y entradas de hoy', async () => {
    const owner = await registerVerifiedUser(app, 'todayrev');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 4 });
    const customerId = await createCustomer(app, owner.accessToken);
    const make = async (unitId: string, body: Record<string, unknown>) => {
      const c = await http()
        .post('/contracts')
        .set(auth)
        .send({ customerId, unitId, priceMonthly: 40, ...body })
        .expect(201);
      return c.body.id as string;
    };

    // Vence en 20 días: con renovación automática no sale; sin ella, sí.
    const renews = await make(unitIds[0]!, { startDate: isoDay(-100), endDate: isoDay(20) });
    await http().post(`/contracts/${renews}/sign`).set(auth).send({}).expect(200);
    const leaves = await make(unitIds[1]!, {
      startDate: isoDay(-100),
      endDate: isoDay(20),
      autoRenew: false,
    });
    await http().post(`/contracts/${leaves}/sign`).set(auth).send({}).expect(200);

    // Entra hoy y tiene fecha de fin: la fecha que se enseña es la de entrada.
    const today = await make(unitIds[2]!, { startDate: isoDay(0), endDate: isoDay(60) });
    await http().post(`/contracts/${today}/sign`).set(auth).send({}).expect(200);

    // Firma pedida y contrato cancelado: ya no está pendiente de firma.
    const cancelled = await make(unitIds[3]!, { startDate: isoDay(1) });
    await http().post(`/contracts/${cancelled}/request-signature`).set(auth).send({});
    await db.contract.update({
      where: { id: cancelled },
      data: {
        signingTokenHash: 'x',
        signingTokenExpiresAt: new Date(Date.now() + 5 * DAY),
        status: 'cancelled',
      },
    });

    const res = await http().get('/dashboard/today').set(auth).expect(200);
    const ending = res.body.contractsEndingSoon.items.map((i: { id: string }) => i.id);
    expect(ending).toContain(leaves);
    expect(ending).not.toContain(renews);
    expect(res.body.signaturesPending.items.map((i: { id: string }) => i.id)).not.toContain(
      cancelled,
    );
    const moveIn = res.body.moveInsToday.items.find((i: { id: string }) => i.id === today);
    expect(moveIn?.date?.slice(0, 10)).toBe(isoDay(0));
  });

  it('facturas vencidas sin marcar y mensajes leídos por usuario', async () => {
    const owner = await registerVerifiedUser(app, 'todayrev2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).send({}).expect(200);
    await db.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(`${isoDay(-3)}T00:00:00Z`), status: 'issued' },
    });

    await db.customerMessage.create({
      data: { tenantId: owner.tenantId, customerId, senderType: 'customer', body: 'Hola' },
    });

    let res = await http().get('/dashboard/today').set(auth).expect(200);
    expect(res.body.invoicesOverdue.count).toBe(1);
    expect(res.body.invoicesOverdue.totalPending).toBeCloseTo(121, 2);
    expect(res.body.unreadMessages).toBe(1);

    // Al abrir la conversación queda leída para este usuario.
    await http().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    res = await http().get('/dashboard/today').set(auth).expect(200);
    expect(res.body.unreadMessages).toBe(0);
  });
});
