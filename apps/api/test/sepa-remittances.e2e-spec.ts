import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const CREDITOR_IBAN = 'ES9121000418450200051332';
const DEBTOR_IBAN = 'ES7921000813610123456789';

describe('Remesas SEPA (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('config acreedor + mandato → remesa → XML pain.008 → confirmar (factura pagada, mandato RCUR)', async () => {
    const owner = await registerVerifiedUser(app, 'sepa');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    // Config del acreedor (rechaza IBAN inválido).
    const bad = await request(app.getHttpServer()).put('/sepa/settings').set(auth).send({
      creditorName: 'Trasteros SL',
      creditorId: 'ES12ZZZB12345678',
      creditorIban: 'ES0021000418450200051332',
      enabled: true,
    });
    expect(bad.status).toBe(400);

    const settings = await request(app.getHttpServer()).put('/sepa/settings').set(auth).send({
      creditorName: 'Trasteros SL',
      creditorId: 'ES12ZZZB12345678',
      creditorIban: CREDITOR_IBAN,
      enabled: true,
    });
    expect(settings.status).toBe(200);
    expect(settings.body.configured).toBe(true);
    expect(settings.body.creditorIbanLast4).toBe('1332');
    expect(settings.body.prenoticeDays).toBe(14); // por defecto, el del reglamento SEPA

    // Cliente + mandato.
    const debtorEmail = `sepa-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email: debtorEmail });
    const mandate = await request(app.getHttpServer())
      .post('/sepa/mandates')
      .set(auth)
      .send({ customerId, iban: DEBTOR_IBAN, signedAt: '2026-01-15' });
    expect(mandate.status).toBe(201);
    expect(mandate.body.sequenceType).toBe('FRST');
    expect(mandate.body.ibanLast4).toBe('6789');
    const mandateRef = mandate.body.reference as string;

    // Factura emitida de 121 €.
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);

    // Preview: 1 factura elegible.
    const preview = await request(app.getHttpServer()).post('/sepa/remittances/preview').set(auth);
    expect(preview.status).toBe(200);
    expect(preview.body.eligible).toHaveLength(1);
    expect(preview.body.eligible[0].invoiceId).toBe(invoiceId);
    expect(preview.body.eligible[0].amount).toBe(121);
    expect(preview.body.eligible[0].sequenceType).toBe('FRST');
    expect(preview.body.total).toBe(121);
    expect(preview.body.prenoticeDays).toBe(14);

    // Plazo pactado en los contratos más corto → la previsualización lo refleja.
    const shorter = await request(app.getHttpServer()).put('/sepa/settings').set(auth).send({
      creditorName: 'Trasteros SL',
      creditorId: 'ES12ZZZB12345678',
      prenoticeDays: 5,
      enabled: true,
    });
    expect(shorter.body.prenoticeDays).toBe(5);
    const preview2 = await request(app.getHttpServer()).post('/sepa/remittances/preview').set(auth);
    expect(preview2.body.prenoticeDays).toBe(5);
    await request(app.getHttpServer())
      .put('/sepa/settings')
      .set(auth)
      .send({ creditorName: 'Trasteros SL', creditorId: 'ES12ZZZB12345678', prenoticeDays: 0 })
      .expect(400);

    // Crear remesa.
    const remittance = await request(app.getHttpServer())
      .post('/sepa/remittances')
      .set(auth)
      .send({ name: 'Remesa junio', collectionDate: '2026-06-30', invoiceIds: [invoiceId] });
    expect(remittance.status).toBe(201);
    expect(remittance.body.status).toBe('generated');
    expect(remittance.body.itemCount).toBe(1);
    expect(remittance.body.total).toBe(121);
    const remittanceId = remittance.body.id as string;

    // Preaviso de cargo al deudor (normativa SEPA): importe, fecha y mandato.
    const notice = await waitForEmail(debtorEmail, { subjectIncludes: 'Aviso de cargo' });
    expect(notice.Subject).toMatch(/121,00\s€ el 30\/06\/2026/);
    expect(notice.Text).toContain('Referencia del mandato: MND-');

    // Constancia del preaviso en la propia remesa (prueba ante una devolución).
    let prenotices: { status: string | null; recipient: string; text: string; subject: string }[] =
      [];
    for (let i = 0; i < 40; i++) {
      prenotices = (
        await request(app.getHttpServer())
          .get(`/sepa/remittances/${remittanceId}/prenotices`)
          .set(auth)
          .expect(200)
      ).body;
      if (prenotices[0]?.status) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(prenotices).toHaveLength(1);
    expect(prenotices[0]).toMatchObject({ status: 'sent', recipient: debtorEmail });
    expect(prenotices[0]!.subject).toContain('Aviso de cargo');
    expect(prenotices[0]!.text).toContain('Referencia del mandato: MND-');
    const listed = await request(app.getHttpServer()).get('/sepa/remittances').set(auth);
    expect(listed.body.find((r: { id: string }) => r.id === remittanceId)).toMatchObject({
      prenoticesSent: 1,
      prenoticesMissing: 0,
    });

    // Descargar XML pain.008 y validar lo esencial.
    const xmlRes = await request(app.getHttpServer())
      .get(`/sepa/remittances/${remittanceId}/xml`)
      .set(auth);
    expect(xmlRes.status).toBe(200);
    const xml = xmlRes.body.xml as string;
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.008.001.02');
    expect(xml).toContain('<PmtMtd>DD</PmtMtd>');
    expect(xml).toContain('<SeqTp>FRST</SeqTp>');
    expect(xml).toContain('<Cd>CORE</Cd>');
    expect(xml).toContain(`<Id>ES12ZZZB12345678</Id>`); // creditor id
    expect(xml).toContain(`<IBAN>${CREDITOR_IBAN}</IBAN>`);
    expect(xml).toContain(`<IBAN>${DEBTOR_IBAN}</IBAN>`);
    expect(xml).toContain(`<MndtId>${mandateRef}</MndtId>`);
    expect(xml).toContain('<InstdAmt Ccy="EUR">121.00</InstdAmt>');
    expect(xml).toContain('<CtrlSum>121.00</CtrlSum>');
    expect(xml).toContain('<NbOfTxs>1</NbOfTxs>');

    // Confirmar cobro → factura pagada + mandato RCUR.
    const confirm = await request(app.getHttpServer())
      .post(`/sepa/remittances/${remittanceId}/confirm`)
      .set(auth);
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('confirmed');

    const invoice = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(invoice.body.status).toBe('paid');

    const mandatesAfter = await request(app.getHttpServer())
      .get(`/sepa/mandates?customerId=${customerId}`)
      .set(auth);
    expect(mandatesAfter.body[0].sequenceType).toBe('RCUR');

    // Reconfirmar → 400.
    const reconfirm = await request(app.getHttpServer())
      .post(`/sepa/remittances/${remittanceId}/confirm`)
      .set(auth);
    expect(reconfirm.status).toBe(400);
  });

  it('factura de cliente sin mandato aparece en withoutMandate', async () => {
    const owner = await registerVerifiedUser(app, 'sepa2');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);

    const preview = await request(app.getHttpServer()).post('/sepa/remittances/preview').set(auth);
    expect(preview.body.eligible).toHaveLength(0);
    expect(preview.body.withoutMandate.map((w: { invoiceId: string }) => w.invoiceId)).toContain(
      invoiceId,
    );
  });

  it('si el preaviso está apagado, la remesa lo deja constado como no enviado', async () => {
    const owner = await registerVerifiedUser(app, 'sepaoff');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    await request(app.getHttpServer())
      .put('/sepa/settings')
      .set(auth)
      .send({
        creditorName: 'Trasteros SL',
        creditorId: 'ES12ZZZB12345678',
        creditorIban: CREDITOR_IBAN,
        enabled: true,
      })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/settings/tenant/customer-emails')
      .set(auth)
      .send({ sepa_prenotification: false })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `sepaoff-${Date.now()}@e2e.local`,
    });
    await request(app.getHttpServer())
      .post('/sepa/mandates')
      .set(auth)
      .send({ customerId, iban: DEBTOR_IBAN, signedAt: '2026-01-15' })
      .expect(201);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const rem = await request(app.getHttpServer())
      .post('/sepa/remittances')
      .set(auth)
      .send({ name: 'Sin preaviso', collectionDate: '2026-06-30', invoiceIds: [invoiceId] })
      .expect(201);

    let status: string | null = null;
    for (let i = 0; i < 40 && !status; i++) {
      const res = await request(app.getHttpServer())
        .get(`/sepa/remittances/${rem.body.id}/prenotices`)
        .set(auth)
        .expect(200);
      status = res.body[0]?.status ?? null;
      if (!status) await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe('disabled');
    const listed = await request(app.getHttpServer()).get('/sepa/remittances').set(auth);
    expect(listed.body[0]).toMatchObject({ prenoticesSent: 0, prenoticesMissing: 1 });
  });
});
