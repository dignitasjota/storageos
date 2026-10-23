import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const CREDITOR_IBAN = 'ES9121000418450200051332';
const DEBTOR_IBAN = 'ES7921000813610123456789';

describe('Mandato SEPA firmado por el inquilino (e2e)', () => {
  let app: INestApplication;

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

  const http = () => request(app.getHttpServer());

  it('sin firma no entra en la remesa; el inquilino firma por el enlace con su constancia', async () => {
    const owner = await registerVerifiedUser(app, 'mandsign');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const settings = {
      creditorName: 'Trasteros SL',
      creditorId: 'ES97ZZZB12345678',
      creditorIban: CREDITOR_IBAN,
      enabled: true,
    };
    await http().put('/sepa/settings').set(auth).send(settings).expect(200);

    const email = `mandsign-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Sin domicilio del acreedor no se puede pedir la firma (sale en el mandato).
    const noAddress = await http()
      .post('/sepa/mandates')
      .set(auth)
      .send({ customerId, iban: DEBTOR_IBAN });
    expect(noAddress.status).toBe(400);
    expect(noAddress.body.code).toBe('sepa_creditor_address_required');

    await http()
      .put('/sepa/settings')
      .set(auth)
      .send({
        ...settings,
        creditorIban: undefined,
        creditorAddress: 'Calle Mayor 1',
        creditorPostalCode: '46001',
        creditorCity: 'Valencia',
      })
      .expect(200);

    const created = await http()
      .post('/sepa/mandates')
      .set(auth)
      .send({ customerId, iban: DEBTOR_IBAN })
      .expect(201);
    expect(created.body.signatureStatus).toBe('pending');
    const token = (created.body.signingUrl as string).split('/sepa-mandate/')[1]!;
    const mail = await waitForEmail(email, { subjectIncludes: 'Firma la domiciliación' });
    expect(mail.Text).toContain('/sepa-mandate/');

    // Una factura emitida: sin firma, queda fuera de la remesa.
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const before = await http().post('/sepa/remittances/preview').set(auth).expect(200);
    expect(before.body.eligible).toHaveLength(0);
    expect(before.body.withoutMandate[0]).toMatchObject({ invoiceId, pendingSignature: true });

    // El inquilino abre el enlace: ve el mandato con los campos del banco.
    const view = await http().get(`/public/sepa-mandates/${token}`).expect(200);
    expect(view.body.signed).toBe(false);
    expect(view.body.prenoticeDays).toBe(14);
    const labels = (view.body.document.fields as { label: string }[]).map((f) => f.label);
    for (const l of [
      'Referencia de la orden de domiciliación',
      'Identificador del acreedor',
      'Dirección del acreedor',
      'Dirección del deudor',
      'Número de cuenta (IBAN)',
      'Tipo de pago',
      'Lugar y fecha de la firma',
    ]) {
      expect(labels).toContain(l);
    }
    expect(view.body.ibanMasked).toMatch(/^ES79 \*{4} .* 6789$/);

    // Firma.
    const signBody = {
      signerName: 'Ana García',
      address: 'Calle Sol 5',
      postalCode: '46002',
      city: 'Valencia',
      country: 'ES',
      place: 'Valencia',
      method: 'typed',
      typedSignature: 'Ana García',
      accept: true,
    };
    await http()
      .post(`/public/sepa-mandates/${token}/sign`)
      .send({ ...signBody, accept: false })
      .expect(400);
    await http()
      .post(`/public/sepa-mandates/${token}/sign`)
      .set('User-Agent', 'e2e-browser')
      .send(signBody)
      .expect(200);
    // El enlace ya no vale: se gasta al firmar.
    await http().post(`/public/sepa-mandates/${token}/sign`).send(signBody).expect(401);

    const row = await app.get(PrismaAdminService).sepaMandate.findUniqueOrThrow({
      where: { id: created.body.id as string },
    });
    expect(row.signatureStatus).toBe('signed');
    expect(row.signerName).toBe('Ana García');
    expect(row.signedUserAgent).toBe('e2e-browser');
    expect(row.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.documentText).toContain('Calle Sol 5, 46002 Valencia (ES)');
    expect(row.documentText).not.toContain(DEBTOR_IBAN);
    // Queda el preaviso que aceptó y a quién se envió el enlace.
    expect(row.prenoticeDays).toBe(14);
    expect(row.signingLinkSentTo).toContain('@');

    const after = await http().post('/sepa/remittances/preview').set(auth).expect(200);
    expect(after.body.eligible.map((e: { invoiceId: string }) => e.invoiceId)).toContain(invoiceId);
  });
});
