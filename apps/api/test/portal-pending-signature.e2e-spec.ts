import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * El inquilino ve en su área de clientes los contratos que esperan su firma y
 * firma desde ahí con un enlace nuevo, aunque el del correo ya no valga.
 */
describe('Área de clientes: contratos pendientes de firmar (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function portalSession(auth: Record<string, string>, customerId: string) {
    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  it('enseña el pendiente, da un enlace nuevo que firma y el viejo deja de valer', async () => {
    const owner = await registerVerifiedUser(app, 'pendsign');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `pendsign-${Date.now()}@e2e.local`,
    });
    const otherId = await createCustomer(app, owner.accessToken);

    const draft = async (unitId: string, forCustomer = customerId) =>
      (
        await http()
          .post('/contracts')
          .set(auth)
          .send({
            customerId: forCustomer,
            unitId,
            startDate: '2026-01-01',
            priceMonthly: 50,
            billingCycle: 'monthly',
          })
          .expect(201)
      ).body.id as string;

    // Uno enviado a firmar y otro que el equipo aún prepara.
    const sent = await draft(unitIds[0]!);
    const preparing = await draft(unitIds[1]!);
    const reqSig = await http().post(`/contracts/${sent}/request-signature`).set(auth).expect(201);
    const oldToken = new URL(reqSig.body.signingUrl as string).pathname.split('/').pop()!;

    const portal = await portalSession(auth, customerId);
    const pending = await http()
      .get('/portal/me/contracts/pending-signature')
      .set(portal)
      .expect(200);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ id: sent, priceMonthlyWithVat: 60.5, holdUntil: null });

    // El que se prepara y los de otro inquilino no se pueden pedir.
    await http().post(`/portal/me/contracts/${preparing}/sign-link`).set(portal).expect(404);
    const foreign = await draft(unitIds[1]!, otherId);
    await http().post(`/portal/me/contracts/${foreign}/sign-link`).set(portal).expect(404);

    // Enlace nuevo desde el área de clientes: el del correo deja de valer.
    const link = await http()
      .post(`/portal/me/contracts/${sent}/sign-link`)
      .set(portal)
      .expect(200);
    const token = link.body.token as string;
    expect(token.startsWith(`${sent}.`)).toBe(true);
    await http().get(`/public/move-in/sign/${oldToken}`).expect(401);

    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      })
      .expect(201);

    // Ya firmado: sale de pendientes, está en sus contratos y no se pide otro enlace.
    const after = await http()
      .get('/portal/me/contracts/pending-signature')
      .set(portal)
      .expect(200);
    expect(after.body).toEqual([]);
    const contracts = await http().get('/portal/me/contracts').set(portal).expect(200);
    expect((contracts.body as { id: string }[]).map((c) => c.id)).toContain(sent);
    await http().post(`/portal/me/contracts/${sent}/sign-link`).set(portal).expect(409);

    // Sin sesión del área de clientes, nada.
    await http().get('/portal/me/contracts/pending-signature').expect(401);
  }, 60_000);

  it('una reserva online sin firmar sale con el plazo hasta el que se guarda el trastero', async () => {
    const owner = await registerVerifiedUser(app, 'pendbook');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const email = `pendbook-${Date.now()}@e2e.local`;
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: fac.facilityId,
        unitTypeId: fac.unitTypeId,
        startDate: new Date().toISOString().slice(0, 10),
        customer: {
          firstName: 'Bea',
          lastName: 'López',
          email,
          phone: '600000000',
          documentNumber: '12345678Z',
        },
      })
      .expect(201);
    const contract = await http()
      .get(`/contracts/${booking.body.contractId}`)
      .set(auth)
      .expect(200);
    const portal = await portalSession(auth, contract.body.customerId as string);
    const pending = await http()
      .get('/portal/me/contracts/pending-signature')
      .set(portal)
      .expect(200);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0].id).toBe(booking.body.contractId);
    expect(pending.body[0].holdUntil).toBeTruthy();
  }, 60_000);
});
