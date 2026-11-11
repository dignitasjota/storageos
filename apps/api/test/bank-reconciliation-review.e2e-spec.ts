import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { buildN43File } from './helpers/n43';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

interface Tx {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  status: string;
  unappliedAmount: number;
  creditContractId: string | null;
  canUndo: boolean;
  matchedInvoices: { id: string }[];
  returnSuggestions: { invoiceId: string; paymentId?: string }[];
}

/**
 * Revisión de la conciliación bancaria: el extracto no se importa dos veces,
 * avisa si no cuadra, es de toda la empresa, fecha los cobros con el día del
 * apunte, pide qué hacer con lo que sobra, devuelve solo cobros por banco y
 * todo se puede deshacer.
 */
describe('Conciliación bancaria: revisión (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function issuedInvoice(
    accessToken: string,
    customerId: string,
    unitPrice = 100,
    contractId?: string,
  ): Promise<{ id: string; number: string }> {
    const auth = { Authorization: `Bearer ${accessToken}` };
    let id: string;
    if (contractId) {
      await ensureDefaultSeries(app, accessToken);
      const res = await http()
        .post('/invoices')
        .set(auth)
        .send({
          customerId,
          contractId,
          items: [{ description: 'Cuota', quantity: 1, unitPrice, taxRate: 21 }],
        })
        .expect(201);
      id = res.body.id as string;
    } else {
      id = await createDraftInvoice(app, accessToken, customerId, { unitPrice });
    }
    const issued = await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
    return { id, number: issued.body.invoiceNumber as string };
  }

  it('el extracto no se repite, avisa si no cuadra y es de toda la empresa', async () => {
    const owner = await registerVerifiedUser(app, 'bankrev1');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await http()
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local A', city: 'Madrid', postalCode: '28001' })
      .expect(201);

    // Un encargado de un solo local no ve la conciliación (mezcla todos los locales).
    const scoped = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [facility.body.id as string],
      tag: 'bankscope',
    });
    const denied = await http().get('/bank-statements').set(scoped).expect(403);
    expect(denied.body.code).toBe('company_wide_only');

    const fileA = buildN43File({
      movements: [
        { amountCents: 12100, date: '260615', reference2: 'AAA', documentNumber: 1 },
        { amountCents: -5000, date: '260616', documentNumber: 2 },
      ],
    });
    const first = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'junio.n43', content: fileA })
      .expect(201);
    expect(first.body.warnings).toEqual([]);
    expect(first.body.duplicatesSkipped).toBe(0);
    const statementA = first.body.statements[0].id as string;

    // El mismo fichero otra vez: 409.
    const again = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'junio (1).n43', content: fileA })
      .expect(409);
    expect(again.body.code).toBe('statement_already_imported');

    // Una descarga que se solapa: el movimiento repetido no se duplica.
    const overlap = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({
        filename: 'junio-julio.n43',
        content: buildN43File({
          start: '260610',
          end: '260720',
          movements: [
            { amountCents: 12100, date: '260615', reference2: 'AAA', documentNumber: 1 },
            { amountCents: 3000, date: '260620', reference2: 'BBB', documentNumber: 3 },
          ],
        }),
      })
      .expect(201);
    expect(overlap.body.duplicatesSkipped).toBe(1);
    expect(overlap.body.statements[0].transactionCount).toBe(1);

    // Un fichero cuyo saldo no cuadra se importa con el aviso.
    const broken = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({
        filename: 'roto.n43',
        content: buildN43File({
          movements: [{ amountCents: 700, date: '260701', documentNumber: 9 }],
          finalCents: 1,
        }),
      })
      .expect(201);
    expect(broken.body.warnings.join(' ')).toContain('El saldo no cuadra');
    const list = await http().get('/bank-statements').set(auth).expect(200);
    const brokenRow = list.body.find((s: { id: string }) => s.id === broken.body.statements[0].id);
    expect(brokenRow.warnings.join(' ')).toContain('El saldo no cuadra');
    expect(brokenRow.pendingCount).toBe(1);

    // Un extracto sin nada conciliado se puede borrar.
    await http().delete(`/bank-statements/${statementA}`).set(auth).expect(204);
    await http().get(`/bank-statements/${statementA}`).set(auth).expect(404);
  });

  it('concilia con la fecha del apunte, pide qué hacer con el sobrante y se deshace', async () => {
    const owner = await registerVerifiedUser(app, 'bankrev2');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const { contractId } = await signedContractFor(app, owner.accessToken, { id: customerId });
    const inv = await issuedInvoice(owner.accessToken, customerId, 100, contractId);

    const imported = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({
        filename: 'x.n43',
        content: buildN43File({
          movements: [
            { amountCents: 15000, date: '260615', reference2: inv.number, documentNumber: 1 },
            { amountCents: 12100, date: '260617', reference2: 'OTRA', documentNumber: 2 },
          ],
        }),
      })
      .expect(201);
    const statementId = imported.body.statements[0].id as string;
    const detail = await http().get(`/bank-statements/${statementId}`).set(auth).expect(200);
    const [big, small] = detail.body.transactions as Tx[];

    // 150 € para una factura de 121 €: hay que decir qué hacer con los 29 €.
    const surplus = await http()
      .post(`/bank-statements/transactions/${big!.id}/match`)
      .set(auth)
      .send({ invoiceId: inv.id })
      .expect(400);
    expect(surplus.body.code).toBe('transaction_surplus');
    expect(surplus.body.details.surplus).toBe(29);

    const matched = await http()
      .post(`/bank-statements/transactions/${big!.id}/match`)
      .set(auth)
      .send({ invoiceId: inv.id, surplus: 'credit' })
      .expect(200);
    const row = (matched.body.transactions as Tx[]).find((t) => t.id === big!.id)!;
    expect(row).toMatchObject({
      status: 'matched',
      unappliedAmount: 29,
      creditContractId: contractId,
      canUndo: true,
    });
    expect(row.matchedInvoices.map((i) => i.id)).toEqual([inv.id]);
    const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(Number(contract.creditBalance)).toBe(29);
    // El cobro lleva el día del apunte, no el de hoy.
    const payment = await admin.payment.findFirstOrThrow({
      where: { invoiceId: inv.id, status: 'succeeded' },
    });
    expect(payment.paidAt!.toISOString().slice(0, 10)).toBe('2026-06-15');

    // Otro ingreso para la misma factura, ya cobrada: nada que aplicar.
    const nothing = await http()
      .post(`/bank-statements/transactions/${small!.id}/match`)
      .set(auth)
      .send({ invoiceId: inv.id })
      .expect(400);
    expect(nothing.body.code).toBe('nothing_to_apply');

    // Deshacer: la factura vuelve a deber y el saldo a favor se retira.
    const undone = await http()
      .post(`/bank-statements/transactions/${big!.id}/undo`)
      .set(auth)
      .expect(200);
    expect((undone.body.transactions as Tx[]).find((t) => t.id === big!.id)!.status).toBe(
      'pending',
    );
    const after = await http().get(`/invoices/${inv.id}`).set(auth).expect(200);
    expect(after.body.amountPaid).toBe(0);
    expect(after.body.status).not.toBe('paid');
    const contractAfter = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(Number(contractAfter.creditBalance)).toBe(0);
    const notUndoable = await http()
      .post(`/bank-statements/transactions/${big!.id}/undo`)
      .set(auth)
      .expect(400);
    expect(notUndoable.body.code).toBe('not_undoable');

    // Ignorar y deshacer el «ignorado».
    await http().post(`/bank-statements/transactions/${small!.id}/ignore`).set(auth).expect(200);
    const unignored = await http()
      .post(`/bank-statements/transactions/${small!.id}/undo`)
      .set(auth)
      .expect(200);
    expect((unignored.body.transactions as Tx[]).find((t) => t.id === small!.id)!.status).toBe(
      'pending',
    );

    // Sin contrato, el sobrante se puede anotar para devolverlo.
    const loose = await issuedInvoice(owner.accessToken, customerId, 100);
    const refunded = await http()
      .post(`/bank-statements/transactions/${big!.id}/match`)
      .set(auth)
      .send({ invoiceId: loose.id, surplus: 'refund' })
      .expect(200);
    expect(
      (refunded.body.transactions as Tx[]).find((t) => t.id === big!.id)!.unappliedAmount,
    ).toBe(29);
    const noContract = await http()
      .post(`/bank-statements/transactions/${small!.id}/match`)
      .set(auth)
      .send({
        invoiceId: (await issuedInvoice(owner.accessToken, customerId, 50)).id,
        surplus: 'credit',
      })
      .expect(400);
    expect(noContract.body.code).toBe('surplus_needs_contract');
  });

  it('una devolución solo revierte cobros por banco, con su fecha, y se deshace', async () => {
    const owner = await registerVerifiedUser(app, 'bankrev3');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const cashInv = await issuedInvoice(owner.accessToken, customerId);
    const bankInv = await issuedInvoice(owner.accessToken, customerId);
    await http()
      .post(`/invoices/${cashInv.id}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await http()
      .post(`/invoices/${bankInv.id}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'bank_transfer' })
      .expect(200);

    const imported = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({
        filename: 'devolucion.n43',
        content: buildN43File({
          movements: [{ amountCents: -12100, date: '260620', documentNumber: 7 }],
        }),
      })
      .expect(201);
    const statementId = imported.body.statements[0].id as string;
    const detail = await http().get(`/bank-statements/${statementId}`).set(auth).expect(200);
    const debit = (detail.body.transactions as Tx[])[0]!;
    // El cobro en efectivo no es candidato: el banco no puede devolverlo.
    const suggested = debit.returnSuggestions.map((s) => s.invoiceId);
    expect(suggested).toContain(bankInv.id);
    expect(suggested).not.toContain(cashInv.id);
    const cashReturn = await http()
      .post(`/bank-statements/transactions/${debit.id}/mark-return`)
      .set(auth)
      .send({ invoiceId: cashInv.id })
      .expect(400);
    expect(cashReturn.body.code).toBe('nothing_to_revert');

    const suggestion = debit.returnSuggestions.find((s) => s.invoiceId === bankInv.id)!;
    await http()
      .post(`/bank-statements/transactions/${debit.id}/mark-return`)
      .set(auth)
      .send({ invoiceId: bankInv.id, paymentId: suggestion.paymentId })
      .expect(200);
    const returned = await admin.payment.findUniqueOrThrow({
      where: { id: suggestion.paymentId! },
    });
    expect(returned.status).toBe('failed');
    expect(returned.returnedAt!.toISOString().slice(0, 10)).toBe('2026-06-20');
    const owing = await http().get(`/invoices/${bankInv.id}`).set(auth).expect(200);
    expect(owing.body.status).not.toBe('paid');

    // Con algo devuelto, el extracto no se borra.
    const blocked = await http().delete(`/bank-statements/${statementId}`).set(auth).expect(409);
    expect(blocked.body.code).toBe('statement_has_matches');

    // Deshacer la devolución: el cobro vuelve a contar y la factura, pagada.
    await http().post(`/bank-statements/transactions/${debit.id}/undo`).set(auth).expect(200);
    const restored = await admin.payment.findUniqueOrThrow({
      where: { id: suggestion.paymentId! },
    });
    expect(restored.status).toBe('succeeded');
    expect(restored.returnedAt).toBeNull();
    const paid = await http().get(`/invoices/${bankInv.id}`).set(auth).expect(200);
    expect(paid.body.status).toBe('paid');
    await http().delete(`/bank-statements/${statementId}`).set(auth).expect(204);
  });
});
