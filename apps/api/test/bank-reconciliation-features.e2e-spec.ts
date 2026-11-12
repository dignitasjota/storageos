import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { futureCollectionDate } from './helpers/platform-sepa';
import { reachCollectionDate } from './helpers/sepa';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type {
  BankMatchRuleDto,
  BankStatementDetailDto,
  BankTransactionDto,
  ImportN43ResultDto,
} from '@storageos/shared';

const CREDITOR_IBAN = 'ES9121000418450200051332';
const DEBTOR_IBAN = 'ES7921000813610123456789';
const DAY = 86_400_000;

/** `dd/mm/aaaa` de hoy menos `n` días (hora de España). */
function esDay(n = 0): string {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() - n * DAY),
  );
  return iso.split('-').reverse().join('/');
}

/** Un CSV como el de la banca online: títulos, lo más reciente primero. */
function csv(rows: { day: string; concept: string; amount: string }[], tag: string): string {
  return [
    `Movimientos ${tag};;;`,
    'Fecha;Concepto;Importe;Saldo',
    ...rows.map((r) => `${r.day};${r.concept};${r.amount};`),
  ].join('\n');
}

/**
 * Mejoras de la conciliación bancaria: importar el CSV de la banca online,
 * sugerencias por el ordenante y por la suma de sus facturas, reglas
 * aprendidas, el abono de una remesa SEPA de una vez y los cargos como gastos.
 */
describe('Conciliación bancaria: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  async function issued(customerId: string, unitPrice: number): Promise<string> {
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  async function importCsv(content: string, filename = 'movimientos.csv') {
    const res = await http()
      .post('/bank-statements/import-csv')
      .set(auth())
      .send({ filename, content })
      .expect(201);
    const result = res.body as ImportN43ResultDto;
    const detail = (
      await http().get(`/bank-statements/${result.statements[0]!.id}`).set(auth()).expect(200)
    ).body as BankStatementDetailDto;
    return { result, detail };
  }

  const tx = (d: BankStatementDetailDto, concept: string): BankTransactionDto =>
    d.transactions.find((t) => t.description === concept)!;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    owner = await registerVerifiedUser(app, 'bankfeat');
    await setTenantPlan(owner.slug, 'pro');
    await ensureDefaultSeries(app, owner.accessToken);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('importa el CSV de la banca online: columnas reconocidas o elegidas a mano', async () => {
    const content = csv(
      [
        { day: esDay(1), concept: 'COMISION MANTENIMIENTO', amount: '-5,00' },
        { day: esDay(2), concept: 'INGRESO EN EFECTIVO', amount: '200,00' },
      ],
      'csv-auto',
    );
    const { result, detail } = await importCsv(content);
    expect(result.statements[0]).toEqual(
      // Sin saldos en el fichero: no se enseñan ni se toma por un fichero que no cuadra.
      expect.objectContaining({
        source: 'csv',
        transactionCount: 2,
        balancesKnown: false,
        warnings: [],
      }),
    );
    expect(detail.transactions.map((t) => t.amount)).toEqual([200, -5]);
    const again = await http()
      .post('/bank-statements/import-csv')
      .set(auth())
      .send({ filename: 'movimientos.csv', content });
    expect(again.status).toBe(409);

    const odd = 'Dia;Texto;Euros\n05/11/2026;PAGO RARO;10,00\n';
    const unknown = await http()
      .post('/bank-statements/import-csv')
      .set(auth())
      .send({ filename: 'raro.csv', content: odd });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('csv_columns_unknown');
    expect(unknown.body.details.headers).toEqual(['Dia', 'Texto', 'Euros']);
    await http()
      .post('/bank-statements/import-csv')
      .set(auth())
      .send({ filename: 'raro.csv', content: odd, mapping: { date: 0, description: 1, amount: 2 } })
      .expect(201);
  });

  it('sugiere por el ordenante y por la suma de sus facturas, y recuerda la regla', async () => {
    const jose = await createCustomer(app, owner.accessToken, {
      firstName: 'José',
      lastName: 'García López',
    });
    const ana = await createCustomer(app, owner.accessToken, {
      firstName: 'Ana',
      lastName: 'Pérez',
    });
    const j121 = await issued(jose, 100);
    const j60 = await issued(jose, 50);
    const a121 = await issued(ana, 100);

    const { detail } = await importCsv(
      csv(
        [
          { day: esDay(3), concept: 'TRANSFERENCIA DE GARCIA LOPEZ JOSE', amount: '121,00' },
          {
            day: esDay(3),
            concept: 'TRANSFERENCIA DE GARCIA LOPEZ JOSE PENDIENTE',
            amount: '181,50',
          },
        ],
        'payer',
      ),
    );
    const single = tx(detail, 'TRANSFERENCIA DE GARCIA LOPEZ JOSE');
    expect(single.suggestions[0]).toEqual(
      expect.objectContaining({ invoiceId: j121, reason: 'payer' }),
    );
    expect(single.suggestions.find((s) => s.invoiceId === a121)?.reason).toBe('amount');
    expect(single.payerPattern).toBe('GARCIA LOPEZ JOSE');
    const sum = tx(detail, 'TRANSFERENCIA DE GARCIA LOPEZ JOSE PENDIENTE');
    const pair = sum.suggestions.find((s) => s.reason === 'sum')!;
    expect(pair.invoiceIds).toEqual([j121, j60]);

    await http()
      .post(`/bank-statements/transactions/${sum.id}/match`)
      .set(auth())
      .send({ invoiceIds: pair.invoiceIds, rememberPattern: 'García López José' })
      .expect(200);
    for (const id of [j121, j60]) {
      expect((await http().get(`/invoices/${id}`).set(auth())).body.status).toBe('paid');
    }
    const rules = (await http().get('/bank-statements/rules').set(auth()).expect(200))
      .body as BankMatchRuleDto[];
    expect(rules).toEqual([
      expect.objectContaining({
        pattern: 'GARCIA LOPEZ JOSE',
        kind: 'customer',
        customerId: jose,
        customerName: 'José García López',
        hits: 1,
      }),
    ]);

    // La regla manda sobre el importe: otra factura igual de otro inquilino.
    const j36 = await issued(jose, 30);
    await issued(ana, 30);
    const next = await importCsv(
      csv([{ day: esDay(1), concept: 'TRF INMEDIATA GARCIA LOPEZ JOSE', amount: '36,30' }], 'rule'),
    );
    expect(tx(next.detail, 'TRF INMEDIATA GARCIA LOPEZ JOSE').suggestions[0]).toEqual(
      expect.objectContaining({ invoiceId: j36, reason: 'rule' }),
    );
    await http().delete(`/bank-statements/rules/${rules[0]!.id}`).set(auth()).expect(204);
    expect((await http().get('/bank-statements/rules').set(auth())).body).toEqual([]);

    // Anonimizar a un inquilino borra sus reglas (llevan su nombre).
    await http()
      .post('/bank-statements/rules')
      .set(auth())
      .send({ pattern: 'Pérez Ana', kind: 'customer', customerId: ana })
      .expect(201);
    await http()
      .post('/bank-statements/rules')
      .set(auth())
      .send({ pattern: 'Endesa Energía', kind: 'expense', expenseCategory: 'utilities' })
      .expect(201);
    await http().post(`/rgpd/customers/${ana}/anonymize`).set(auth()).expect(204);
    const left = (await http().get('/bank-statements/rules').set(auth()).expect(200))
      .body as BankMatchRuleDto[];
    expect(left.map((r) => r.pattern)).toEqual(['ENDESA ENERGIA']);
    await http().delete(`/bank-statements/rules/${left[0]!.id}`).set(auth()).expect(204);
  });

  it('concilia el abono de una remesa SEPA de una vez', async () => {
    await http()
      .put('/sepa/settings')
      .set(auth())
      .send({
        creditorName: 'Trasteros SL',
        creditorId: 'ES97ZZZB12345678',
        creditorIban: CREDITOR_IBAN,
        creditorAddress: 'Calle Mayor 1',
        creditorPostalCode: '28001',
        creditorCity: 'Madrid',
        enabled: true,
      })
      .expect(200);
    const invoices: string[] = [];
    for (const price of [100, 50]) {
      const customerId = await createCustomer(app, owner.accessToken);
      await http()
        .post('/sepa/mandates')
        .set(auth())
        .send({ customerId, iban: DEBTOR_IBAN, signedOutside: true, signedAt: '2026-01-15' })
        .expect(201);
      invoices.push(await issued(customerId, price));
    }
    const remittance = await http()
      .post('/sepa/remittances')
      .set(auth())
      .send({
        name: 'Remesa bloque',
        collectionDate: futureCollectionDate(20),
        invoiceIds: invoices,
      })
      .expect(201);
    const remittanceId = remittance.body.id as string;
    await reachCollectionDate(app, remittanceId);

    const { detail } = await importCsv(
      csv(
        [
          { day: esDay(1), concept: 'ABONO REMESA ADEUDOS SEPA', amount: '181,50' },
          { day: esDay(1), concept: 'OTRO INGRESO', amount: '10,00' },
          { day: esDay(1), concept: 'INGRESO DEL MISMO IMPORTE', amount: '181,50' },
        ],
        'remesa',
      ),
    );
    const credit = tx(detail, 'ABONO REMESA ADEUDOS SEPA');
    expect(credit.remittanceSuggestions).toEqual([
      expect.objectContaining({ remittanceId, amount: 181.5, status: 'generated' }),
    ]);
    const mismatch = await http()
      .post(`/bank-statements/transactions/${tx(detail, 'OTRO INGRESO').id}/match-remittance`)
      .set(auth())
      .send({ remittanceId });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('remittance_amount_mismatch');

    const matched = (
      await http()
        .post(`/bank-statements/transactions/${credit.id}/match-remittance`)
        .set(auth())
        .send({ remittanceId })
        .expect(200)
    ).body as BankStatementDetailDto;
    expect(tx(matched, 'ABONO REMESA ADEUDOS SEPA')).toEqual(
      expect.objectContaining({
        status: 'matched',
        matchedRemittance: { id: remittanceId, name: 'Remesa bloque' },
        canUndo: true,
      }),
    );
    const r = await http().get(`/sepa/remittances/${remittanceId}`).set(auth()).expect(200);
    expect(r.body).toEqual(expect.objectContaining({ status: 'confirmed', collectedCount: 2 }));
    for (const id of invoices) {
      expect((await http().get(`/invoices/${id}`).set(auth())).body.status).toBe('paid');
    }
    // El abono de una remesa solo se concilia una vez.
    const twice = await http()
      .post(
        `/bank-statements/transactions/${tx(detail, 'INGRESO DEL MISMO IMPORTE').id}/match-remittance`,
      )
      .set(auth())
      .send({ remittanceId });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('remittance_already_matched');
    expect(tx(matched, 'INGRESO DEL MISMO IMPORTE').remittanceSuggestions).toEqual([]);
    // Deshacer solo quita el enlace: la remesa sigue registrada.
    await http().post(`/bank-statements/transactions/${credit.id}/undo`).set(auth()).expect(200);
    expect((await http().get(`/sepa/remittances/${remittanceId}`).set(auth())).body.status).toBe(
      'confirmed',
    );
  });

  it('un cargo es un gasto, y la regla lo propone la próxima vez', async () => {
    const { detail } = await importCsv(
      csv(
        [
          { day: esDay(4), concept: 'RECIBO IBERDROLA CLIENTES SAU', amount: '-50,00' },
          { day: esDay(4), concept: 'INGRESO VARIOS', amount: '15,00' },
        ],
        'gasto',
      ),
    );
    const notDebit = await http()
      .post(`/bank-statements/transactions/${tx(detail, 'INGRESO VARIOS').id}/expense`)
      .set(auth())
      .send({ category: 'utilities' });
    expect(notDebit.status).toBe(400);
    expect(notDebit.body.code).toBe('not_a_debit');

    const debit = tx(detail, 'RECIBO IBERDROLA CLIENTES SAU');
    expect(debit.payerPattern).toBe('IBERDROLA CLIENTES SAU');
    // Un texto que no sirve como regla no deja el gasto a medias.
    const shortRule = await http()
      .post(`/bank-statements/transactions/${debit.id}/expense`)
      .set(auth())
      .send({ category: 'utilities', rememberPattern: '--x' });
    expect(shortRule.status).toBe(400);
    expect(shortRule.body.code).toBe('rule_pattern_too_short');
    expect(await admin.expense.count({ where: { tenantId: owner.tenantId } })).toBe(0);
    const after = (
      await http()
        .post(`/bank-statements/transactions/${debit.id}/expense`)
        .set(auth())
        .send({ category: 'utilities', rememberPattern: 'Iberdrola' })
        .expect(200)
    ).body as BankStatementDetailDto;
    const done = tx(after, 'RECIBO IBERDROLA CLIENTES SAU');
    expect(done.status).toBe('expense');
    expect(done.expense?.category).toBe('utilities');
    const expense = await admin.expense.findUniqueOrThrow({ where: { id: done.expense!.id } });
    expect(Number(expense.amount)).toBe(50);
    expect(expense.description).toBe('RECIBO IBERDROLA CLIENTES SAU');

    const next = await importCsv(
      csv(
        [{ day: esDay(1), concept: 'RECIBO IBERDROLA CLIENTES SAU NOV', amount: '-48,00' }],
        'gasto2',
      ),
    );
    expect(tx(next.detail, 'RECIBO IBERDROLA CLIENTES SAU NOV').expenseSuggestion).toEqual({
      category: 'utilities',
      pattern: 'IBERDROLA',
    });

    // Deshacer borra el gasto creado.
    await http().post(`/bank-statements/transactions/${debit.id}/undo`).set(auth()).expect(200);
    expect(await admin.expense.findUnique({ where: { id: done.expense!.id } })).toBeNull();
  });
});
