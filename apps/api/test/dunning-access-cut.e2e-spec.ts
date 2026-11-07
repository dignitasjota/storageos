import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AccessCredentialsService } from '../src/modules/access/access-credentials.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import { JOB_DUNNING_EXECUTE_ACTION } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

/**
 * El corte de acceso por impago de verdad: por el servicio del escalado tal como
 * lo resuelve Nest, sin insertar acciones a mano ni sustituir nada.
 */
describe('Corte de acceso por impago', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await cleanupTestTenants();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Fixture {
    token: string;
    tenantId: string;
    customerId: string;
    contractId: string;
    credentialId: string;
    pin: string;
    device: { apiKey: string; hardwareId: string };
  }

  /** La credencial que se emite sola al firmar, con su PIN a la vista. */
  async function issuedPin(
    token: string,
    customerId: string,
  ): Promise<{ id: string; pin: string }> {
    let id: string | null = null;
    await waitFor(async () => {
      const row = await admin.accessCredential.findFirst({
        where: { customerId, status: 'active' },
        select: { id: true },
      });
      id = row?.id ?? null;
      return !!id;
    });
    const rotated = await http()
      .post(`/access/credentials/${id!}/rotate`)
      .set(auth(token))
      .send({})
      .expect(200);
    return { id: rotated.body.id, pin: rotated.body.revealedSecret };
  }

  async function fixture(suffix: string): Promise<Fixture> {
    const owner = await registerVerifiedUser(app, suffix);
    const token = owner.accessToken;
    await setTenantPlan(owner.slug, 'pro');
    await ensureDefaultSeries(app, token);
    const me = await http().get('/auth/me').set(auth(token)).expect(200);
    const tenantId = me.body.tenant.id as string;
    const customerId = await createCustomer(app, token, {
      email: `cut-${Math.random().toString(36).slice(2, 10)}@e2e.local`,
    });
    const contract = await signedContractFor(app, token, { id: customerId });
    const credential = await issuedPin(token, customerId);
    const device = await http()
      .post('/access/devices')
      .set(auth(token))
      .send({
        facilityId: contract.facilityId,
        type: 'door',
        name: 'Puerta',
        hardwareId: `hw-${Math.random().toString(36).slice(2, 10)}`,
        provider: 'stub',
      })
      .expect(201);
    return {
      token,
      tenantId,
      customerId,
      contractId: contract.contractId,
      credentialId: credential.id,
      pin: credential.pin,
      device: { apiKey: device.body.revealedApiKey, hardwareId: device.body.hardwareId },
    };
  }

  async function overdueInvoice(
    f: Pick<Fixture, 'token' | 'customerId' | 'contractId'>,
    price = 100,
  ): Promise<string> {
    const draft = await http()
      .post('/invoices')
      .set(auth(f.token))
      .send({
        customerId: f.customerId,
        contractId: f.contractId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: price, taxRate: 21 }],
      })
      .expect(201);
    const id = draft.body.id as string;
    await http().post(`/invoices/${id}/issue`).set(auth(f.token)).send({}).expect(200);
    await admin.invoice.update({
      where: { id },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 20 * 86_400_000) },
    });
    return id;
  }

  async function action(
    f: Fixture,
    invoiceId: string,
    type: 'access_block' | 'legal_notice' = 'access_block',
  ): Promise<string> {
    const row = await admin.dunningAction.create({
      data: {
        tenantId: f.tenantId,
        invoiceId,
        actionType: type,
        status: 'scheduled',
        scheduledFor: new Date(Date.now() - 60_000),
      },
    });
    return row.id;
  }

  const execute = (f: Fixture, actionId: string) =>
    app
      .get(DunningService)
      .handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId: f.tenantId, actionId });

  const door = async (f: Fixture): Promise<string> => {
    const res = await http()
      .post('/access/verify')
      .set('X-Device-Key', f.device.apiKey)
      .send({ deviceId: f.device.hardwareId, method: 'pin', credential: f.pin });
    return res.body.result as string;
  };

  const credentialStatus = async (f: Fixture) =>
    (await admin.accessCredential.findUniqueOrThrow({ where: { id: f.credentialId } })).status;

  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 40; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no ha pasado a tiempo');
  }

  it('el escalado corta de verdad y pagar devuelve el acceso', async () => {
    const f = await fixture('cutpay');
    expect(await door(f)).toBe('allowed');
    const invoice = await overdueInvoice(f);
    await execute(f, await action(f, invoice));

    expect(await credentialStatus(f)).toBe('suspended');
    expect(await door(f)).not.toBe('allowed');

    const arrears = await http().get('/arrears').set(auth(f.token)).expect(200);
    expect(arrears.body.rows[0].accessBlocked).toBe(true);
    const summary = await http()
      .get(`/access/customers/${f.customerId}`)
      .set(auth(f.token))
      .expect(200);
    expect(summary.body.cutForDebt).toBe(true);

    await http()
      .post(`/invoices/${invoice}/mark-paid`)
      .set(auth(f.token))
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await waitFor(async () => (await credentialStatus(f)) === 'active');
    expect(await door(f)).toBe('allowed');
  });

  it('con la política de no cortar ni corta ni lo dice', async () => {
    const f = await fixture('cutnone');
    await admin.tenant.update({ where: { id: f.tenantId }, data: { accessCutMode: 'none' } });
    const invoice = await overdueInvoice(f);
    const id = await action(f, invoice);
    await execute(f, id);

    expect(await credentialStatus(f)).toBe('active');
    const row = await admin.dunningAction.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('executed');
    expect(row.result).toMatchObject({ accessBlocked: false, accessCutSkipped: 'mode_none' });
    const arrears = await http().get('/arrears').set(auth(f.token)).expect(200);
    expect(arrears.body.rows[0].accessBlocked).toBe(false);
  });

  it('anular la factura devuelve el acceso', async () => {
    const f = await fixture('cutvoid');
    const invoice = await overdueInvoice(f);
    await execute(f, await action(f, invoice));
    expect(await credentialStatus(f)).toBe('suspended');

    await http()
      .post(`/invoices/${invoice}/cancel`)
      .set(auth(f.token))
      .send({ reason: 'Error' })
      .expect(200);
    await waitFor(async () => (await credentialStatus(f)) === 'active');
  });

  it('con otra factura cortada, anular una no devuelve el acceso', async () => {
    const f = await fixture('cuttwo');
    const first = await overdueInvoice(f);
    const second = await overdueInvoice(f, 50);
    await execute(f, await action(f, first));
    await execute(f, await action(f, second));

    await http()
      .post(`/invoices/${first}/cancel`)
      .set(auth(f.token))
      .send({ reason: 'Error' })
      .expect(200);
    await new Promise((r) => setTimeout(r, 400));
    expect(await credentialStatus(f)).toBe('suspended');
  });

  it('reactivar a mano deja de contar como cortado', async () => {
    const f = await fixture('cutmanual');
    const invoice = await overdueInvoice(f);
    await execute(f, await action(f, invoice));

    await http().post(`/access/customers/${f.customerId}/resume`).set(auth(f.token)).expect(200);
    expect(await credentialStatus(f)).toBe('active');
    expect(await app.get(AccessCredentialsService).isCutForDebt(f.tenantId, f.customerId)).toBe(
      false,
    );
    const arrears = await http().get('/arrears').set(auth(f.token)).expect(200);
    expect(arrears.body.rows[0].accessBlocked).toBe(false);
  });

  it('lista a los que no se llegó a cortar y deja decidir', async () => {
    const f = await fixture('cutold');
    const invoice = await overdueInvoice(f);
    const second = await fixtureCustomer(f);
    const invoice2 = await overdueInvoice({ token: f.token, ...second });
    // Como quedaron las acciones antes del arreglo: ejecutadas, sin cortar nada.
    const phantom = async (invoiceId: string) =>
      admin.dunningAction.create({
        data: {
          tenantId: f.tenantId,
          invoiceId,
          actionType: 'access_block',
          status: 'executed',
          scheduledFor: new Date(Date.now() - 86_400_000),
          executedAt: new Date(Date.now() - 86_400_000),
          result: { action: 'access_block' },
        },
      });
    await phantom(invoice);
    await phantom(invoice2);

    // No se le da por cortado: sigue entrando.
    expect(await door(f)).toBe('allowed');
    const arrears = await http().get('/arrears').set(auth(f.token)).expect(200);
    expect(arrears.body.rows.every((r: { accessBlocked: boolean }) => !r.accessBlocked)).toBe(true);

    const list = await http().get('/access/debt-cuts').set(auth(f.token)).expect(200);
    expect(list.body.rows.map((r: { customerId: string }) => r.customerId).sort()).toEqual(
      [f.customerId, second.customerId].sort(),
    );

    const cut = await http()
      .post(`/access/debt-cuts/${f.customerId}/cut`)
      .set(auth(f.token))
      .expect(200);
    expect(cut.body.suspended).toBe(1);
    expect(await credentialStatus(f)).toBe('suspended');
    expect(await door(f)).not.toBe('allowed');

    await http().post(`/access/debt-cuts/${second.customerId}/skip`).set(auth(f.token)).expect(204);
    const after = await http().get('/access/debt-cuts').set(auth(f.token)).expect(200);
    expect(after.body.rows).toEqual([]);
    const secondCredential = await admin.accessCredential.findFirst({
      where: { customerId: second.customerId, status: 'active' },
    });
    expect(secondCredential).not.toBeNull();

    // Pagar devuelve el acceso del que sí se cortó.
    await http()
      .post(`/invoices/${invoice}/mark-paid`)
      .set(auth(f.token))
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await waitFor(async () => (await credentialStatus(f)) === 'active');
  });

  async function fixtureCustomer(f: Fixture): Promise<{ customerId: string; contractId: string }> {
    const customerId = await createCustomer(app, f.token, {
      email: `cut-${Math.random().toString(36).slice(2, 10)}@e2e.local`,
    });
    const contract = await signedContractFor(app, f.token, { id: customerId });
    await waitFor(async () => {
      const count = await admin.accessCredential.count({ where: { customerId, status: 'active' } });
      return count > 0;
    });
    return { customerId, contractId: contract.contractId };
  }

  it('abre el expediente del aviso legal solo si el negocio los usa', async () => {
    const f = await fixture('cutlegal');
    const invoice = await overdueInvoice(f);
    const off = await action(f, invoice, 'legal_notice');
    await execute(f, off);
    expect(
      (await admin.dunningAction.findUniqueOrThrow({ where: { id: off } })).result,
    ).toMatchObject({ collectionsCaseOpened: false });

    const other = await overdueInvoice(f, 50);
    await admin.tenant.update({
      where: { id: f.tenantId },
      data: { collectionsEnabled: true },
    });
    const on = await action(f, other, 'legal_notice');
    await execute(f, on);
    expect(
      (await admin.dunningAction.findUniqueOrThrow({ where: { id: on } })).result,
    ).toMatchObject({ collectionsCaseOpened: true });
    expect(await admin.delinquencyCase.count({ where: { tenantId: f.tenantId } })).toBe(1);
  });
});
