import { earliestCollectionDate, nextSepaBusinessDay } from '@storageos/shared';
import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { SepaAutomationService } from '../src/modules/sepa/sepa-automation.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { futureCollectionDate } from './helpers/platform-sepa';
import { reachCollectionDate } from './helpers/sepa';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type {
  SepaBankResponseResultDto,
  SepaRemittanceDto,
  SepaRemittancePrenoticeDto,
  SepaSettingsDto,
} from '@storageos/shared';

const CREDITOR_IBAN = 'ES9121000418450200051332';
const DEBTOR_IBAN = 'ES7921000813610123456789';
const DAY = 86_400_000;

/** Respuesta del banco (pain.002) con el estado de cada adeudo. */
function pain002(messageId: string, txs: { e2e: string; status: string; code?: string }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03"><CstmrPmtStsRpt>
<GrpHdr><MsgId>STS-${Date.now()}</MsgId></GrpHdr>
<OrgnlGrpInfAndSts><OrgnlMsgId>${messageId}</OrgnlMsgId><GrpSts>PART</GrpSts></OrgnlGrpInfAndSts>
<OrgnlPmtInfAndSts><OrgnlPmtInfId>${messageId}-FRST</OrgnlPmtInfId>
${txs
  .map(
    (t) =>
      `<TxInfAndSts><OrgnlEndToEndId>${t.e2e}</OrgnlEndToEndId><TxSts>${t.status}</TxSts>${
        t.code ? `<StsRsnInf><Rsn><Cd>${t.code}</Cd></Rsn></StsRsnInf>` : ''
      }</TxInfAndSts>`,
  )
  .join('\n')}
</OrgnlPmtInfAndSts></CstmrPmtStsRpt></Document>`;
}

/**
 * Mejoras de las remesas SEPA: un preaviso por inquilino con varias facturas,
 * la respuesta del banco (rechazos y devoluciones con su código), la remesa
 * automática del mes, el aviso de las que siguen sin registrar y el de los
 * mandatos que caducan.
 */
describe('Remesas SEPA: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  async function issued(customerId: string, unitPrice = 100): Promise<string> {
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  async function customerWithMandate(tag: string) {
    const email = `sepa-feat-${tag}-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const m = await http()
      .post('/sepa/mandates')
      .set(auth())
      .send({ customerId, iban: DEBTOR_IBAN, signedOutside: true, signedAt: '2026-01-15' })
      .expect(201);
    return { customerId, mandateId: m.body.id as string, email };
  }

  async function prenotices(id: string, until: (rows: SepaRemittancePrenoticeDto[]) => boolean) {
    let rows: SepaRemittancePrenoticeDto[] = [];
    for (let i = 0; i < 60; i++) {
      rows = (await http().get(`/sepa/remittances/${id}/prenotices`).set(auth()).expect(200))
        .body as SepaRemittancePrenoticeDto[];
      if (until(rows)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return rows;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    owner = await registerVerifiedUser(app, 'sepafeat');
    await setTenantPlan(owner.slug, 'pro');
    await ensureDefaultSeries(app, owner.accessToken);
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
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un solo preaviso por inquilino con varias facturas en la remesa', async () => {
    const { customerId } = await customerWithMandate('two');
    const a = await issued(customerId, 100);
    const b = await issued(customerId, 50);
    const created = await http()
      .post('/sepa/remittances')
      .set(auth())
      .send({ name: 'Remesa doble', collectionDate: futureCollectionDate(20), invoiceIds: [a, b] })
      .expect(201);
    const rows = await prenotices(created.body.id as string, (r) => r.every((x) => !!x.status));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(rows[0]!.subject).toBe(rows[1]!.subject);
    expect(rows[0]!.text).toMatch(/en 2 cargos/);
    const sent = await admin.communication.count({
      where: { customerId, source: 'customer_email.sepa_prenotification' },
    });
    expect(sent).toBe(1);
    // La ficha de la remesa.
    const detail = (
      await http()
        .get(`/sepa/remittances/${created.body.id as string}`)
        .set(auth())
        .expect(200)
    ).body as SepaRemittanceDto;
    expect(detail).toEqual(
      expect.objectContaining({ itemCount: 2, autoPrepared: false, bankResponseAt: null }),
    );
    await http()
      .post(`/sepa/remittances/${created.body.id as string}/cancel`)
      .set(auth())
      .expect(200);
  });

  it('respuesta del banco: rechazo antes del cargo y devolución tras cobrarse', async () => {
    const one = await customerWithMandate('rej');
    const two = await customerWithMandate('ret');
    const ia = await issued(one.customerId);
    const ib = await issued(two.customerId);
    const created = await http()
      .post('/sepa/remittances')
      .set(auth())
      .send({
        name: 'Remesa respuesta',
        collectionDate: futureCollectionDate(20),
        invoiceIds: [ia, ib],
      })
      .expect(201);
    const id = created.body.id as string;
    const rows = await prenotices(id, (r) => r.length === 2);
    const e2e = (inv: string) => rows.find((r) => r.invoiceId === inv)!.endToEndId;

    const bad = await http()
      .post('/sepa/remittances/bank-response')
      .set(auth())
      .send({ content: '11NORMA43 no es un pain.002 del banco' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_pain002');

    const file = pain002(created.body.messageId as string, [
      { e2e: e2e(ia), status: 'RJCT', code: 'AM04' },
      { e2e: e2e(ib), status: 'ACSC' },
      { e2e: 'E2E-NO-EXISTE', status: 'RJCT', code: 'MD01' },
    ]);
    const first = (
      await http()
        .post('/sepa/remittances/bank-response')
        .set(auth())
        .send({ filename: 'respuesta.xml', content: file })
        .expect(200)
    ).body as SepaBankResponseResultDto;
    expect(first).toEqual(
      expect.objectContaining({
        remittanceId: id,
        rejected: 1,
        accepted: 1,
        returned: 0,
        unmatched: ['E2E-NO-EXISTE'],
      }),
    );
    let items = await prenotices(id, () => true);
    const rejected = items.find((r) => r.invoiceId === ia)!;
    expect(rejected.itemStatus).toBe('failed');
    expect(rejected.returnCode).toBe('AM04');
    expect(rejected.failureReason).toContain('AM04 · Saldo insuficiente');
    const again = (
      await http()
        .post('/sepa/remittances/bank-response')
        .set(auth())
        .send({ content: file })
        .expect(200)
    ).body as SepaBankResponseResultDto;
    expect(again.rejected).toBe(0);
    expect(again.alreadyProcessed).toBe(1);
    expect(
      (
        (await http().get(`/sepa/remittances/${id}`).set(auth()).expect(200))
          .body as SepaRemittanceDto
      ).bankResponseAt,
    ).toBeTruthy();

    // Se registra el cobro: el rechazado no se cobra.
    await reachCollectionDate(app, id);
    await http().post(`/sepa/remittances/${id}/confirm`).set(auth()).send({}).expect(200);
    items = await prenotices(id, () => true);
    expect(items.find((r) => r.invoiceId === ib)!.itemStatus).toBe('collected');
    expect(items.find((r) => r.invoiceId === ia)!.itemStatus).toBe('failed');

    // Días después, el banco devuelve el cobrado (lo pide el titular).
    const back = (
      await http()
        .post('/sepa/remittances/bank-response')
        .set(auth())
        .send({
          content: pain002(created.body.messageId as string, [
            { e2e: e2e(ib), status: 'RJCT', code: 'MD06' },
          ]),
        })
        .expect(200)
    ).body as SepaBankResponseResultDto;
    expect(back.returned).toBe(1);
    items = await prenotices(id, () => true);
    expect(items.find((r) => r.invoiceId === ib)).toEqual(
      expect.objectContaining({ itemStatus: 'returned', returnCode: 'MD06' }),
    );
    const invoice = await http().get(`/invoices/${ib}`).set(auth()).expect(200);
    expect(invoice.body.status).not.toBe('paid');
  });

  it('remesa automática del mes, una vez, y aviso de la que sigue sin registrar', async () => {
    const todayDay = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', day: '2-digit' }).format(
        new Date(),
      ),
    );
    const settings = (
      await http()
        .put('/sepa/settings')
        .set(auth())
        .send({
          creditorName: 'Trasteros SL',
          creditorId: 'ES97ZZZB12345678',
          enabled: true,
          autoPrepare: true,
          autoPrepareDay: Math.min(28, todayDay),
        })
        .expect(200)
    ).body as SepaSettingsDto;
    expect(settings.autoPrepare).toBe(true);
    // El día no pasa del 28.
    await http()
      .put('/sepa/settings')
      .set(auth())
      .send({ creditorName: 'Trasteros SL', creditorId: 'ES97ZZZB12345678', autoPrepareDay: 31 })
      .expect(400);

    const { customerId } = await customerWithMandate('auto');
    const invoiceId = await issued(customerId, 80);
    const automation = app.get(SepaAutomationService);
    await automation.autoPrepareAll();
    const auto = await admin.sepaRemittance.findFirst({
      where: { tenantId: owner.tenantId, autoPrepared: true },
      include: { items: true },
    });
    expect(auto).not.toBeNull();
    expect(auto!.items.map((i) => i.invoiceId)).toContain(invoiceId);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
      new Date(),
    );
    expect(auto!.collectionDate.toISOString().slice(0, 10)).toBe(
      nextSepaBusinessDay(earliestCollectionDate(14, new Date(`${today}T00:00:00Z`))),
    );
    const prepared = await admin.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'sepa.remittance_prepared' },
    });
    expect(prepared?.link).toBe(`/sepa-remittances/${auto!.id}`);

    // El mismo mes no se prepara otra.
    await issued(customerId, 30);
    await automation.autoPrepareAll();
    expect(
      await admin.sepaRemittance.count({ where: { tenantId: owner.tenantId, autoPrepared: true } }),
    ).toBe(1);

    // Pasada su fecha sin registrar: un aviso, una vez.
    await admin.sepaRemittance.update({
      where: { id: auto!.id },
      data: { collectionDate: new Date(Date.now() - 5 * DAY) },
    });
    await automation.notifyStale();
    await automation.notifyStale();
    expect(
      await admin.notification.count({
        where: { tenantId: owner.tenantId, type: 'sepa.remittance_unconfirmed' },
      }),
    ).toBe(1);
  });

  it('aviso de los mandatos que caducan en 60 días, una vez por fecha', async () => {
    const { customerId, mandateId } = await customerWithMandate('expiry');
    // Último adeudo hace 36 meses menos 30 días: caduca dentro de 30 días.
    const last = new Date();
    last.setUTCMonth(last.getUTCMonth() - 36);
    last.setUTCDate(last.getUTCDate() + 30);
    await admin.sepaMandate.update({
      where: { id: mandateId },
      data: { lastCollectedAt: new Date(`${last.toISOString().slice(0, 10)}T00:00:00Z`) },
    });
    const automation = app.get(SepaAutomationService);
    await automation.notifyExpiringMandates();
    const notice = await admin.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'sepa.mandates_expiring' },
    });
    expect(notice?.title).toBe('1 mandato SEPA caduca pronto');
    expect(notice?.link).toBe(`/customers/${customerId}?tab=payments`);
    const mandate = await admin.sepaMandate.findUniqueOrThrow({ where: { id: mandateId } });
    expect(mandate.expiryNotifiedFor).not.toBeNull();
    await automation.notifyExpiringMandates();
    expect(
      await admin.notification.count({
        where: { tenantId: owner.tenantId, type: 'sepa.mandates_expiring' },
      }),
    ).toBe(1);
  });
});
