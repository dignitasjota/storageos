import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Facturas del panel del tenant: los arreglos, por el API real. */
describe('Revisión de facturas (e2e)', () => {
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
  const authOf = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function tenant(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    await ensureDefaultSeries(app, owner.accessToken);
    const me = await http().get('/auth/me').set(authOf(owner.accessToken)).expect(200);
    return { ...owner, tenantId: me.body.tenant.id as string, auth: authOf(owner.accessToken) };
  }

  async function issued(token: string, customerId: string, price = 100): Promise<string> {
    const id = await createDraftInvoice(app, token, customerId, { unitPrice: price });
    await http().post(`/invoices/${id}/issue`).set(authOf(token)).send({}).expect(200);
    return id;
  }

  async function contractFor(
    owner: { accessToken: string; auth: Record<string, string> },
    customerId: string,
    unitId: string,
  ): Promise<string> {
    const contract = await http().post('/contracts').set(owner.auth).send({
      customerId,
      unitId,
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    await http().post(`/contracts/${contract.body.id}/sign`).set(owner.auth).send({}).expect(200);
    return contract.body.id as string;
  }

  it('el mismo cobro o la misma devolución dos veces seguidas cuentan una vez', async () => {
    const owner = await tenant('invrevdup');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await issued(owner.accessToken, customerId);

    const pay = (body: Record<string, unknown>) =>
      http().post(`/invoices/${id}/mark-paid`).set(owner.auth).send(body);
    await pay({ amount: 50, methodType: 'cash' }).expect(200);
    const twin = await pay({ amount: 50, methodType: 'cash' });
    expect(twin.status).toBe(409);
    expect(twin.body.code).toBe('duplicate_payment');
    // Un cobro no se registra en el futuro.
    const future = await pay({
      amount: 5,
      methodType: 'cash',
      paidAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    expect(future.body.code).toBe('paid_at_in_future');
    // Las marcas internas no se pueden mandar desde fuera: se ignoran.
    const partial = await pay({
      amount: 10,
      methodType: 'bank_transfer',
      allowPartialNonCash: true,
    });
    expect(partial.body.code).toBe('partial_only_cash');

    const paid = await pay({ amount: 71, methodType: 'cash' }).expect(200);
    expect(paid.body.status).toBe('paid');
    const refund = () =>
      http().post(`/invoices/${id}/refund`).set(owner.auth).send({ amount: 30, reason: 'Ajuste' });
    await refund().expect(200);
    const twinRefund = await refund();
    expect(twinRefund.status).toBe(409);
    expect(twinRefund.body.code).toBe('duplicate_refund');
    const detail = await http().get(`/invoices/${id}`).set(owner.auth).expect(200);
    expect(detail.body.amountRefunded).toBe(30);
    const refunds = await admin.invoiceRefund.findMany({ where: { invoiceId: id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ via: 'manual', reason: 'Ajuste' });
  });

  it('emitir una rectificativa mientras se emite otra factura no se bloquea', async () => {
    const owner = await tenant('invrevlock');
    const customerId = await createCustomer(app, owner.accessToken);
    for (let round = 0; round < 6; round++) {
      const original = await issued(owner.accessToken, customerId);
      const rect = await http()
        .post(`/invoices/${original}/rectify`)
        .set(owner.auth)
        .send({
          rectificationType: 'R4',
          reason: 'Descuento',
          items: [{ description: 'Descuento', quantity: 1, unitPrice: -10, taxRate: 21 }],
        })
        .expect(201);
      const other = await createDraftInvoice(app, owner.accessToken, customerId);
      const results = await Promise.all([
        http().post(`/invoices/${rect.body.id}/issue`).set(owner.auth).send({}),
        http().post(`/invoices/${other}/issue`).set(owner.auth).send({}),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    }
  });

  it('recargo por mora: solo vencidas, con el recargo activado y nunca sobre otro', async () => {
    const owner = await tenant('invrevfee');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await contractFor(owner, customerId, unitIds[0]!);
    const draft = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    const id = draft.body.id as string;
    await http().post(`/invoices/${id}/issue`).set(owner.auth).send({}).expect(200);

    const notDue = await http().post(`/invoices/${id}/late-fee`).set(owner.auth);
    expect(notDue.body.code).toBe('invoice_not_overdue');
    await admin.invoice.update({
      where: { id },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 10 * 86_400_000) },
    });
    const disabled = await http().post(`/invoices/${id}/late-fee`).set(owner.auth);
    expect(disabled.body.code).toBe('late_fee_disabled');

    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: { lateFeeEnabled: true, lateFeeType: 'percentage', lateFeeValue: 5 },
    });
    const preview = await http()
      .get(`/invoices/${id}/late-fee-preview`)
      .set(owner.auth)
      .expect(200);
    expect(preview.body).toMatchObject({ amount: 6.05, type: 'percentage', value: 5 });
    const fee = await http().post(`/invoices/${id}/late-fee`).set(owner.auth).expect(200);
    expect(fee.body.contractId).toBe(contractId);
    expect(fee.body.total).toBe(6.05);

    await admin.invoice.update({
      where: { id: fee.body.id },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 10 * 86_400_000) },
    });
    const onFee = await http().post(`/invoices/${fee.body.id}/late-fee`).set(owner.auth);
    expect(onFee.body.code).toBe('late_fee_on_late_fee');

    // Anular la factura anula también su recargo sin cobrar.
    await http()
      .post(`/invoices/${id}/cancel`)
      .set(owner.auth)
      .send({ reason: 'Error' })
      .expect(200);
    const feeAfter = await admin.invoice.findUniqueOrThrow({ where: { id: fee.body.id } });
    expect(feeAfter.status).toBe('rectified');
  });

  it('una factura a 0 € queda saldada al emitirla y no se avisa como nueva', async () => {
    const owner = await tenant('invrevzero');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    // Como la del mes gratis de una promoción: alquiler a 0 €.
    await admin.invoiceItem.updateMany({
      where: { invoiceId: id },
      data: { unitPrice: 0, taxAmount: 0, total: 0 },
    });
    await admin.invoice.update({
      where: { id },
      data: { subtotal: 0, taxAmount: 0, total: 0 },
    });
    const res = await http().post(`/invoices/${id}/issue`).set(owner.auth).send({}).expect(200);
    expect(res.body).toMatchObject({ status: 'paid', dueDate: null, amountPending: 0 });
    await new Promise((r) => setTimeout(r, 300));
    const mails = await admin.communication.count({
      where: { invoiceId: id, source: { contains: 'invoice_issued' } },
    });
    expect(mails).toBe(0);
  });

  it('cancelar el borrador devuelve el mes gratis y la señal, y no se vuelve a generar', async () => {
    const owner = await tenant('invrevfree');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const free = await contractFor(
      owner,
      await createCustomer(app, owner.accessToken),
      unitIds[0]!,
    );
    const credit = await contractFor(
      owner,
      await createCustomer(app, owner.accessToken),
      unitIds[1]!,
    );
    await admin.contract.update({ where: { id: free }, data: { freeMonthsRemaining: 1 } });
    await admin.contract.update({
      where: { id: credit },
      data: { pendingCreditAmount: 5, pendingCreditReason: 'Señal de la reserva' },
    });
    const jobs = app.get(BillingJobsService);
    const now = new Date();
    const period = {
      tenantId: owner.tenantId,
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .slice(0, 10),
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
        .toISOString()
        .slice(0, 10),
    };
    await jobs.processGenerateRecurring(period);
    const drafts = await admin.invoice.findMany({
      where: { tenantId: owner.tenantId, contractId: { in: [free, credit] }, status: 'draft' },
    });
    expect(drafts).toHaveLength(2);
    expect(
      (await admin.contract.findUniqueOrThrow({ where: { id: free } })).freeMonthsRemaining,
    ).toBe(0);
    expect(
      Number(
        (await admin.contract.findUniqueOrThrow({ where: { id: credit } })).pendingCreditAmount,
      ),
    ).toBe(0);

    for (const d of drafts) {
      await http().post(`/invoices/${d.id}/cancel`).set(owner.auth).send({}).expect(200);
    }
    expect(
      (await admin.contract.findUniqueOrThrow({ where: { id: free } })).freeMonthsRemaining,
    ).toBe(1);
    expect(
      Number(
        (await admin.contract.findUniqueOrThrow({ where: { id: credit } })).pendingCreditAmount,
      ),
    ).toBe(5);

    // La noche siguiente no aparece otra vez.
    await jobs.processGenerateRecurring(period);
    const again = await admin.invoice.count({
      where: { tenantId: owner.tenantId, contractId: { in: [free, credit] } },
    });
    expect(again).toBe(2);
  });

  it('el vencimiento son los días de plazo del negocio desde la emisión', async () => {
    const owner = await tenant('invrevdue');
    await http()
      .patch('/settings/tenant/billing')
      .set(owner.auth)
      .send({ invoiceDueDays: 10 })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await issued(owner.accessToken, customerId);
    const inv = await http().get(`/invoices/${id}`).set(owner.auth).expect(200);
    const issue = new Date(`${inv.body.issueDate as string}T00:00:00Z`);
    issue.setUTCDate(issue.getUTCDate() + 10);
    expect(inv.body.dueDate).toBe(issue.toISOString().slice(0, 10));
  });

  it('cambiar el vencimiento de una emitida pide motivo y la saca de vencidas', async () => {
    const owner = await tenant('invrevpatch');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await issued(owner.accessToken, customerId);
    await admin.invoice.update({
      where: { id },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 5 * 86_400_000) },
    });
    await admin.dunningAction.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: id,
        actionType: 'email_reminder_final',
        status: 'scheduled',
        scheduledFor: new Date(),
      },
    });
    const later = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const noReason = await http().patch(`/invoices/${id}`).set(owner.auth).send({ dueDate: later });
    expect(noReason.body.code).toBe('due_date_reason_required');
    const ok = await http()
      .patch(`/invoices/${id}`)
      .set(owner.auth)
      .send({ dueDate: later, dueDateReason: 'Acordado con el inquilino' })
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'issued', dueDate: later });
    const action = await admin.dunningAction.findFirstOrThrow({ where: { invoiceId: id } });
    expect(action.status).toBe('cancelled');
    const log = await admin.auditLog.findFirst({
      where: { entityId: id, action: 'invoice.due_date_changed' },
    });
    expect(log?.changes).toMatchObject({ to: later, reason: 'Acordado con el inquilino' });
  });

  it('quien solo ve un local no emite, crea ni reenvía facturas de otro', async () => {
    const owner = await tenant('invrevscope');
    const facA = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const facB = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerB = await createCustomer(app, owner.accessToken);
    const contractB = await contractFor(owner, customerB, facB.unitIds[0]!);
    const draftB = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({
        customerId: customerB,
        contractId: contractB,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 50, taxRate: 21 }],
      })
      .expect(201);
    const issuedB = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({
        customerId: customerB,
        contractId: contractB,
        items: [{ description: 'Otra', quantity: 1, unitPrice: 20, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${issuedB.body.id}/issue`).set(owner.auth).send({}).expect(200);

    const email = `inv-scope-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(owner.auth).send({ email, role: 'manager' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Gestor A', password: 'Passw0rd!' })
      .expect(200);
    const users = await http().get('/users').set(owner.auth);
    const manager = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    await http()
      .patch(`/settings/users/${manager.id}/facilities`)
      .set(owner.auth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Passw0rd!' })
      .expect(200);
    const scoped = authOf(login.body.accessToken as string);

    const bulk = await http()
      .post('/invoices/bulk/issue')
      .set(scoped)
      .send({ ids: [draftB.body.id] })
      .expect(200);
    expect(bulk.body.succeeded).toEqual([]);
    expect(bulk.body.failed[0]).toMatchObject({ error: 'facility_not_in_scope' });
    const create = await http()
      .post('/invoices')
      .set(scoped)
      .send({
        customerId: customerB,
        contractId: contractB,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 50, taxRate: 21 }],
      });
    expect([403, 404]).toContain(create.status);
    const resend = await http()
      .post(`/billing/invoices/${issuedB.body.id}/resend-aeat`)
      .set(scoped);
    expect(resend.status).toBe(403);
  });

  it('los datos mal escritos dan un error legible, no un 500', async () => {
    const owner = await tenant('invrevval');
    const customerId = await createCustomer(app, owner.accessToken);
    expect((await http().get('/invoices/page?customerId=abc').set(owner.auth)).body.code).toBe(
      'invalid_id',
    );
    expect((await http().get('/invoices/page?status=foo').set(owner.auth)).body.code).toBe(
      'invalid_status',
    );
    const line = { description: 'Cuota', quantity: 1, unitPrice: 10, taxRate: 21 };
    const badDate = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({ customerId, dueDate: '2026-13-45', items: [line] });
    expect(badDate.status).toBe(400);
    const huge = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({ customerId, items: [{ ...line, unitPrice: 1e13 }] });
    expect(huge.status).toBe(400);
    const noContract = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({ customerId, contractId: '0190e4a0-0000-7000-8000-000000000000', items: [line] });
    expect(noContract.status).toBe(404);
    expect(noContract.body.code).toBe('contract_not_found');

    const draft = await createDraftInvoice(app, owner.accessToken, customerId);
    const pdf = await http().post(`/invoices/${draft}/generate-pdf`).set(owner.auth);
    expect(pdf.body.code).toBe('invoice_is_draft');
    // Un borrador no tiene nada pendiente.
    expect((await http().get(`/invoices/${draft}`).set(owner.auth)).body.amountPending).toBe(0);
  });

  it('lista: «solo vencidas» respeta el estado y la búsqueda va por palabras', async () => {
    const owner = await tenant('invrevlist');
    const res = await http()
      .post('/customers')
      .set(owner.auth)
      .send({
        customerType: 'individual',
        firstName: 'Ana',
        lastName: 'García López',
        email: `ana-${Date.now()}@e2e.local`,
      })
      .expect(201);
    const customerId = res.body.id as string;
    const overdue = await issued(owner.accessToken, customerId);
    await admin.invoice.update({
      where: { id: overdue },
      data: { status: 'overdue', dueDate: new Date(Date.now() - 3 * 86_400_000) },
    });
    const paid = await issued(owner.accessToken, customerId, 10);
    await http()
      .post(`/invoices/${paid}/mark-paid`)
      .set(owner.auth)
      .send({ amount: 12.1, methodType: 'cash' })
      .expect(200);

    const ids = async (q: string) =>
      (
        (await http().get(`/invoices/page?${q}`).set(owner.auth)).body.items as { id: string }[]
      ).map((i) => i.id);
    expect(await ids('overdue=true')).toEqual([overdue]);
    expect(await ids('overdue=true&status=paid')).toEqual([]);
    expect(await ids(`search=${encodeURIComponent('Ana López')}`)).toHaveLength(2);
    expect(await ids(`search=${encodeURIComponent('Ana Pérez')}`)).toHaveLength(0);
  });

  it('el recordatorio de una factura sin vencer dice que vence y no se repite en un día', async () => {
    const owner = await tenant('invrevrem');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await issued(owner.accessToken, customerId);
    const first = await http()
      .post('/invoices/bulk/remind')
      .set(owner.auth)
      .send({ ids: [id] })
      .expect(200);
    expect(first.body.succeeded).toEqual([id]);
    const comm = await admin.communication.findFirstOrThrow({
      where: { invoiceId: id, source: 'bulk.manual_reminder' },
    });
    expect(comm.bodyText).toContain('vence el');
    expect(comm.bodyText).not.toContain('venció');
    const second = await http()
      .post('/invoices/bulk/remind')
      .set(owner.auth)
      .send({ ids: [id] })
      .expect(200);
    expect(second.body.failed[0]).toMatchObject({
      error: 'reminder_recently_sent',
      message: 'Ya se le recordó esta factura en las últimas 24 horas',
    });
  });

  it('sin datos fiscales del negocio no se emite', async () => {
    const owner = await tenant('invrevfiscal');
    const customerId = await createCustomer(app, owner.accessToken);
    const draft = await createDraftInvoice(app, owner.accessToken, customerId);
    const previous = process.env.E2E_SKIP_READINESS;
    process.env.E2E_SKIP_READINESS = 'false';
    try {
      const res = await http().post(`/invoices/${draft}/issue`).set(owner.auth).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('issuer_fiscal_data_required');
      expect(res.body.details.missing).toEqual(
        expect.arrayContaining(['NIF', 'razón social', 'domicilio fiscal']),
      );
    } finally {
      process.env.E2E_SKIP_READINESS = previous;
    }
  });

  it('una factura con retención de IRPF se puede sustituir', async () => {
    const owner = await tenant('invrevirpf');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await contractFor(owner, customerId, unitIds[0]!);
    await http()
      .put(`/contracts/${contractId}/irpf-retention`)
      .set(owner.auth)
      .send({ pct: 19 })
      .expect(200);
    const draft = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    const original = await http()
      .post(`/invoices/${draft.body.id}/issue`)
      .set(owner.auth)
      .send({})
      .expect(200);
    expect(original.body.withholdingAmount).toBe(19);
    const rect = await http()
      .post(`/invoices/${draft.body.id}/rectify`)
      .set(owner.auth)
      .send({
        rectificationType: 'R1',
        reason: 'NIF equivocado',
        correctionMethod: 'by_substitution',
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    const sub = await http()
      .post(`/invoices/${rect.body.id}/issue`)
      .set(owner.auth)
      .send({})
      .expect(200);
    expect(sub.body.withholdingAmount).toBe(19);
    expect(sub.body.amountPending).toBe(102);
  });
});
