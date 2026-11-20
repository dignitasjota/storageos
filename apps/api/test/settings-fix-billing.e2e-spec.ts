import * as forge from 'node-forge';
import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { fakeHolded } from './helpers/fake-holded';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * PKCS#12 con la cadena de la emisora DELANTE del certificado del titular:
 * el que vale es el que casa con la clave privada, no el primero.
 */
function chainedPkcs12(password: string): Buffer {
  const issued = (cn: string, nif: string, signer: forge.pki.rsa.KeyPair, subject = signer) => {
    const cert = forge.pki.createCertificate();
    cert.publicKey = subject.publicKey;
    cert.serialNumber = String(Math.floor(Math.random() * 1e6));
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
    cert.setSubject([
      { name: 'commonName', value: cn },
      { name: 'serialNumber', value: `IDCES-${nif}` },
    ]);
    cert.setIssuer([{ name: 'commonName', value: 'Test CA' }]);
    cert.sign(signer.privateKey, forge.md.sha256.create());
    return cert;
  };
  const caKeys = forge.pki.rsa.generateKeyPair(1024);
  const leafKeys = forge.pki.rsa.generateKeyPair(1024);
  const ca = issued('TEST CA', '11111111H', caKeys);
  const leaf = issued('TITULAR', '12345678Z', caKeys, leafKeys);
  const asn1 = forge.pkcs12.toPkcs12Asn1(leafKeys.privateKey, [ca, leaf], password, {
    algorithm: '3des',
  });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/** Arreglos de Configuración → Facturación, Veri*Factu, Contabilidad (Holded). */
describe('Configuración de facturación: arreglos (e2e)', () => {
  // Muchas peticiones por prueba: con la máquina cargada pasan de los 30 s.
  jest.setTimeout(120_000);

  let app: INestApplication;
  let admin: PrismaAdminService;
  let holded: Awaited<ReturnType<typeof fakeHolded>>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    holded = await fakeHolded();
    process.env.HOLDED_API_BASE = holded.base;
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HOLDED_API_BASE;
    holded.server.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('series: prefijo único y válido, una sola por defecto y número repetido → 409', async () => {
    const owner = await registerVerifiedUser(app, 'sfbseries');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const mainId = await ensureDefaultSeries(app, owner.accessToken);
    const main = (await http().get('/invoice-series').set(auth).expect(200)).body.find(
      (s: { id: string }) => s.id === mainId,
    );

    // Mismo prefijo que otra serie (sin distinguir mayúsculas) → 409.
    const taken = await http()
      .post('/invoice-series')
      .set(auth)
      .send({ code: 'B', name: 'Otra', prefix: main.prefix.toLowerCase(), yearScope: true })
      .expect(409);
    expect(taken.body.code).toBe('invoice_series_prefix_taken');

    // Caracteres que no van en un número de factura → 400.
    await http()
      .post('/invoice-series')
      .set(auth)
      .send({ code: 'B', name: 'Otra', prefix: 'F A', yearScope: true })
      .expect(400);

    const b = await http()
      .post('/invoice-series')
      .set(auth)
      .send({ code: 'B', name: 'Otra', prefix: 'fb-2', yearScope: true })
      .expect(201);
    expect(b.body.prefix).toBe('FB-2');
    const renamed = await http()
      .patch(`/invoice-series/${b.body.id}`)
      .set(auth)
      .send({ prefix: main.prefix })
      .expect(409);
    expect(renamed.body.code).toBe('invoice_series_prefix_taken');
    const c = await http()
      .post('/invoice-series')
      .set(auth)
      .send({ code: 'C', name: 'Tercera', prefix: 'FC', yearScope: true })
      .expect(201);

    // Dos «usar por defecto» a la vez: queda una sola por defecto.
    await Promise.all([
      http().patch(`/invoice-series/${b.body.id}`).set(auth).send({ isDefault: true }),
      http().patch(`/invoice-series/${c.body.id}`).set(auth).send({ isDefault: true }),
    ]);
    const defaults = await admin.invoiceSeries.count({
      where: { tenantId: owner.tenantId, ownerId: null, isDefault: true },
    });
    expect(defaults).toBe(1);
    // Y la base de datos tampoco admite una segunda.
    await expect(
      admin.invoiceSeries.update({ where: { id: mainId }, data: { isDefault: true } }),
    ).rejects.toThrow();

    // Una serie antigua con el mismo prefijo: emitir da un 409 claro, no un 500.
    await admin.invoiceSeries.update({ where: { id: c.body.id }, data: { isDefault: false } });
    await admin.invoiceSeries.update({ where: { id: b.body.id }, data: { isDefault: false } });
    await admin.invoiceSeries.update({ where: { id: mainId }, data: { isDefault: true } });
    const customerId = await createCustomer(app, owner.accessToken);
    const first = await createDraftInvoice(app, owner.accessToken, customerId);
    const issued = await http().post(`/invoices/${first}/issue`).set(auth);
    expect(issued.body).toMatchObject({ status: 'issued' });
    await admin.invoiceSeries.update({
      where: { id: c.body.id },
      data: { prefix: main.prefix, isActive: true },
    });
    const second = await createDraftInvoice(app, owner.accessToken, customerId);
    await admin.invoice.update({ where: { id: second }, data: { seriesId: c.body.id } });
    const clash = await http().post(`/invoices/${second}/issue`).set(auth).expect(409);
    expect(clash.body.code).toBe('invoice_number_taken');
  });

  it('certificado: sin él no es un error, el entorno es el de la plataforma y vale el del titular', async () => {
    const owner = await registerVerifiedUser(app, 'sfbcert');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const none = await http().get('/billing/aeat-credentials/current').set(auth).expect(200);
    expect(none.body).toEqual({ credential: null });

    const password = 'clave123';
    const up = await http()
      .post('/billing/aeat-credentials')
      .set(auth)
      .field('password', password)
      .field('environment', 'production')
      .attach('file', chainedPkcs12(password), {
        filename: 'cert.p12',
        contentType: 'application/x-pkcs12',
      })
      .expect(201);
    // El titular (no la emisora, que va primero) y el entorno de la plataforma (stub).
    expect(up.body).toMatchObject({ certNif: '12345678Z', certCommonName: 'TITULAR' });
    expect(up.body.environment).toBe('sandbox');

    const current = await http().get('/billing/aeat-credentials/current').set(auth).expect(200);
    expect(current.body.credential).toMatchObject({ certNif: '12345678Z' });

    const bad = await http()
      .post('/billing/aeat-credentials')
      .set(auth)
      .field('password', 'otra')
      .attach('file', chainedPkcs12(password), { filename: 'cert.p12' })
      .expect(400);
    expect(bad.body.message).toContain('Contraseña incorrecta');
  });

  it('recargo por mora en porcentaje: como mucho el 100 %', async () => {
    const owner = await registerVerifiedUser(app, 'sfbfee');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ lateFeeType: 'percentage', lateFeeValue: 150 })
      .expect(400);
    await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ lateFeeType: 'fixed', lateFeeValue: 150 })
      .expect(200);
    // Cambiar solo el tipo con 150 € guardados dejaría un 150 %.
    const onlyType = await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ lateFeeType: 'percentage' })
      .expect(400);
    expect(onlyType.body.code).toBe('late_fee_percentage_too_high');
  });

  it('Holded: auditoría, series de emisión obligatorias, pendientes y cambio programado', async () => {
    const owner = await registerVerifiedUser(app, 'sfbholded');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await http()
      .put('/settings/holded')
      .set(auth)
      .send({ apiKey: 'pat_issue_123456', enabled: false })
      .expect(200);
    const cfg = await http()
      .put('/settings/holded')
      .set(auth)
      .send({
        enabled: false,
        issuingInvoiceSeriesId: 'ser-vf',
        issuingCreditNoteSeriesId: 'ser-rvf',
      })
      .expect(200);
    expect(cfg.body).toMatchObject({ issuingReady: true, ready: false, pendingCount: 0 });

    // Queda en el registro de actividad, sin la clave.
    const audits = await admin.auditLog.findMany({
      where: { tenantId: owner.tenantId, action: 'holded.settings_changed' },
    });
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits.map((a) => a.changes))).not.toContain('pat_issue');

    // Emitiendo en Holded no se pueden quitar las series de emisión.
    await http().put('/settings/invoicing-mode').set(auth).send({ mode: 'holded' }).expect(200);
    const cleared = await http()
      .put('/settings/holded')
      .set(auth)
      .send({ enabled: false, issuingInvoiceSeriesId: null })
      .expect(400);
    expect(cleared.body.code).toBe('holded_issuing_series_required');

    // «Enviar pendientes» funciona también sin la copia contable.
    const backfill = await http().post('/settings/holded/backfill').set(auth).expect(201);
    expect(backfill.body).toEqual({ synced: 0, remaining: 0 });

    // Un id que no es de Holded no se enlaza.
    const customerId = await createCustomer(app, owner.accessToken);
    const draft = await createDraftInvoice(app, owner.accessToken, customerId);
    await admin.invoice.update({
      where: { id: draft },
      data: { holdedSyncState: 'creating', holdedSyncStartedAt: new Date(0) },
    });
    const badId = await http()
      .post(`/settings/holded/review/invoices/${draft}`)
      .set(auth)
      .send({ action: 'already_in_holded', holdedDocumentId: 'no es un id' })
      .expect(400);
    expect(badId.body.code).toBe('holded_document_id_invalid');
    await http()
      .post(`/settings/holded/review/invoices/${draft}`)
      .set(auth)
      .send({ action: 'already_in_holded', holdedDocumentId: 'inv-777' })
      .expect(200);
    expect(
      await admin.auditLog.count({
        where: { tenantId: owner.tenantId, action: 'holded.review_resolved' },
      }),
    ).toBe(1);

    // Cambio programado a Holded con Holded ya sin series: no se aplica y avisa.
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: {
        invoicingMode: 'app',
        invoicingModePending: 'holded',
        invoicingModePendingFrom: new Date(Date.UTC(2020, 0, 1)),
      },
    });
    await admin.holdedSettings.update({
      where: { tenantId: owner.tenantId },
      data: { issuingInvoiceSeriesId: null },
    });
    const mode = await http().get('/settings/invoicing-mode').set(auth).expect(200);
    expect(mode.body).toMatchObject({ mode: 'app', pendingMode: null });
    const notice = await admin.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'invoicing_mode.holded_not_ready' },
    });
    expect(notice).not.toBeNull();
  });
});
