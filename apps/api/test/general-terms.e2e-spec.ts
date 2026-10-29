import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Condiciones generales: casilla obligatoria antes de pagar y versión aceptada. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Condiciones generales de contratación (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());
  const tokenFromUrl = (url: string) => decodeURIComponent(url.split('/sign/')[1]!.split('?')[0]!);

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

  async function draftWithLink(token: string, unitId: string, email: string) {
    const auth = { Authorization: `Bearer ${token}` };
    const customerId = await createCustomer(app, token, { email });
    const created = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: '2026-04-01', priceMonthly: 60 })
      .expect(201);
    const reqSig = await http()
      .post(`/contracts/${created.body.id}/request-signature`)
      .set(auth)
      .expect(201);
    return { contractId: created.body.id as string, link: tokenFromUrl(reqSig.body.signingUrl) };
  }

  const signBody = {
    signerName: 'Ana Ruiz',
    method: 'typed',
    typedSignature: 'Ana Ruiz',
    accept: true,
  };

  it('hay que aceptarlas para firmar, se guarda la versión y una nueva si cambian', async () => {
    const owner = await registerVerifiedUser(app, 'gterms');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });

    const first = await draftWithLink(owner.accessToken, unitIds[0]!, 'gt1@e2e.local');
    const view = await http().get(`/public/move-in/sign/${first.link}`).expect(200);
    expect(view.body.generalTerms).toMatchObject({
      title: 'Condiciones Generales de Contratación',
      accepted: false,
    });
    expect(view.body.generalTerms.url).toContain('/condiciones-contratacion');

    // Sin la casilla no se firma.
    const missing = await http().post(`/public/move-in/sign/${first.link}`).send(signBody);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('general_terms_required');

    // El negocio cambia sus condiciones mientras el inquilino las tiene abiertas.
    await http()
      .patch('/settings/tenant/web-legal')
      .set(auth)
      .send({ terms: '## Condiciones v1\n\nTexto primero.' })
      .expect(200);
    const stale = await http()
      .post(`/public/move-in/sign/${first.link}`)
      .send({ ...signBody, generalTermsHash: view.body.generalTerms.hash });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('general_terms_changed');

    const fresh = await http().get(`/public/move-in/sign/${first.link}`).expect(200);
    await http()
      .post(`/public/move-in/sign/${first.link}`)
      .set('User-Agent', 'e2e-navegador')
      .send({ ...signBody, generalTermsHash: fresh.body.generalTerms.hash })
      .expect((r) => {
        if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
      });

    const record = await http().get(`/contracts/${first.contractId}/signing`).set(auth).expect(200);
    expect(record.body.generalTerms).toHaveLength(1);
    expect(record.body.generalTerms[0]).toMatchObject({ version: 1, channel: 'remote' });
    const v1 = await http()
      .get(`/settings/tenant/web-legal/versions/${record.body.generalTerms[0].versionId}`)
      .set(auth)
      .expect(200);
    expect(v1.body.content).toContain('Texto primero.');

    // Cambian otra vez: el siguiente inquilino acepta la versión 2 y la 1 se conserva.
    await http()
      .patch('/settings/tenant/web-legal')
      .set(auth)
      .send({ terms: '## Condiciones v2\n\nTexto segundo.' })
      .expect(200);
    const second = await draftWithLink(owner.accessToken, unitIds[1]!, 'gt2@e2e.local');
    const view2 = await http().get(`/public/move-in/sign/${second.link}`).expect(200);
    await http()
      .post(`/public/move-in/sign/${second.link}`)
      .send({ ...signBody, generalTermsHash: view2.body.generalTerms.hash })
      .expect(201);

    const versions = await http().get('/settings/tenant/web-legal/versions').set(auth).expect(200);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions.body[0]).toMatchObject({ current: true, acceptances: 1 });
    expect(versions.body[1]).toMatchObject({ current: false, acceptances: 1 });
    const again = await http().get(`/contracts/${first.contractId}/signing`).set(auth).expect(200);
    expect(again.body.generalTerms[0].version).toBe(1);
  });

  it('antes de pagar un contrato ya firmado sin aceptarlas, hay que aceptarlas', async () => {
    const owner = await registerVerifiedUser(app, 'gtermspay');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await db.unitType.updateMany({
      where: { tenantId: owner.tenantId },
      data: { defaultDepositAmount: 50 },
    });
    const facility = await db.facility.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    const unitType = await db.unitType.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: unitType.id,
        startDate: '2026-04-01',
        customer: {
          firstName: 'Pau',
          lastName: 'Gil',
          email: `pau-${Date.now()}@e2e.local`,
          phone: '600111222',
          documentNumber: '12345678Z',
        },
      })
      .expect(201);
    const link = booking.body.signingToken as string;
    const view = await http().get(`/public/move-in/sign/${link}`).expect(200);
    await http()
      .post(`/public/move-in/sign/${link}`)
      .send({ ...signBody, generalTermsHash: view.body.generalTerms.hash })
      .expect(201);
    expect(unitIds).toHaveLength(1);

    // Contrato firmado antes de que existiera la casilla: se borra la aceptación.
    await db.legalDocAcceptance.deleteMany({ where: { contractId: booking.body.contractId } });
    const signed = await http().get(`/public/move-in/sign/${link}`).expect(200);
    expect(signed.body.paymentPending).toBe(true);
    expect(signed.body.generalTerms.accepted).toBe(false);

    const blocked = await http().post(`/public/move-in/sign/${link}/payment`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('general_terms_required');

    const accepted = await http()
      .post(`/public/move-in/sign/${link}/general-terms`)
      .send({ generalTermsHash: signed.body.generalTerms.hash })
      .expect(200);
    expect(accepted.body.accepted).toBe(true);
    const session = await http().post(`/public/move-in/sign/${link}/payment`).expect(200);
    expect(session.body.portalToken).toEqual(expect.any(String));
  });

  it('en el local: la firma del inquilino exige aceptarlas', async () => {
    const owner = await registerVerifiedUser(app, 'gtermslocal');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const { contractId } = await draftWithLink(owner.accessToken, unitIds[0]!, 'gt3@e2e.local');
    const drawn = {
      method: 'drawn',
      signerName: 'Luis',
      signatureImage: 'data:image/png;base64,iVBORw0KGgo=',
    };
    const missing = await http().post(`/contracts/${contractId}/sign`).set(auth).send(drawn);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('general_terms_required');

    const terms = await http().get(`/contracts/${contractId}/general-terms`).set(auth).expect(200);
    await http()
      .post(`/contracts/${contractId}/sign`)
      .set(auth)
      .send({ ...drawn, generalTermsHash: terms.body.hash })
      .expect(200);
    const record = await http().get(`/contracts/${contractId}/signing`).set(auth).expect(200);
    expect(record.body.generalTerms[0]).toMatchObject({ channel: 'in_person', version: 1 });
  });

  it('la aceptación se guarda antes de firmar: si la firma falla, no se pierde ni se repite', async () => {
    const owner = await registerVerifiedUser(app, 'gtermsorder');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const { contractId, link } = await draftWithLink(
      owner.accessToken,
      unitIds[0]!,
      'gt4@e2e.local',
    );
    const view = await http().get(`/public/move-in/sign/${link}`).expect(200);

    // El equipo cambia el contrato mientras el inquilino lo lee: la firma falla
    // (409 terms_changed), pero las condiciones ya quedaron aceptadas.
    await http().patch(`/contracts/${contractId}`).set(auth).send({ priceMonthly: 70 }).expect(200);
    const stale = await http()
      .post(`/public/move-in/sign/${link}`)
      .send({
        ...signBody,
        termsHash: view.body.termsHash,
        generalTermsHash: view.body.generalTerms.hash,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('terms_changed');
    const draft = await db.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(draft.status).toBe('draft');
    expect(await db.legalDocAcceptance.count({ where: { contractId } })).toBe(1);

    // Al reintentar firma y no duplica la aceptación.
    const fresh = await http().get(`/public/move-in/sign/${link}`).expect(200);
    expect(fresh.body.generalTerms.accepted).toBe(true);
    await http()
      .post(`/public/move-in/sign/${link}`)
      .send({
        ...signBody,
        termsHash: fresh.body.termsHash,
        generalTermsHash: fresh.body.generalTerms.hash,
      })
      .expect(201);
    expect(await db.legalDocAcceptance.count({ where: { contractId } })).toBe(1);
  });

  it('área de clientes: el primer pago de un contrato sin aceptarlas pide la casilla', async () => {
    const owner = await registerVerifiedUser(app, 'gtermsportal');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { email: 'gt5@e2e.local' });
    const created = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-04-01', priceMonthly: 60 })
      .expect(201);
    const contractId = created.body.id as string;
    // Firmado en el panel sin firma del inquilino (en papel): sin aceptación.
    await http().post(`/contracts/${contractId}/sign`).set(auth).send({}).expect(200);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await db.invoice.update({ where: { id: invoiceId }, data: { contractId } });
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);

    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201);
    const token = (link.body.url as string).match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)![1];
    const session = await http().post('/portal/login/consume').send({ token }).expect(200);
    const portal = { Authorization: `Bearer ${session.body.accessToken}` };

    const list = await http().get('/portal/me/invoices').set(portal).expect(200);
    const inv = list.body.find((i: { id: string }) => i.id === invoiceId);
    expect(inv.generalTerms).toMatchObject({ contractId, accepted: false });

    const blocked = await http().post(`/portal/me/invoices/${invoiceId}/charge`).set(portal);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('general_terms_required');
    const redsys = await http()
      .post(`/portal/me/invoices/${invoiceId}/redsys-redirect`)
      .set(portal)
      .send({});
    expect(redsys.status).toBe(409);

    await http()
      .post(`/portal/me/contracts/00000000-0000-0000-0000-000000000000/general-terms`)
      .set(portal)
      .send({ generalTermsHash: inv.generalTerms.hash })
      .expect(404);
    const accepted = await http()
      .post(`/portal/me/contracts/${contractId}/general-terms`)
      .set(portal)
      .send({ generalTermsHash: inv.generalTerms.hash })
      .expect(200);
    expect(accepted.body.accepted).toBe(true);
    const after = await http().get('/portal/me/invoices').set(portal).expect(200);
    expect(after.body.find((i: { id: string }) => i.id === invoiceId).generalTerms).toBeNull();
    const record = await http().get(`/contracts/${contractId}/signing`).set(auth).expect(200);
    expect(record.body.generalTerms[0].channel).toBe('remote');
  });

  it('RGPD: la exportación las incluye y al anonimizar se quitan IP y navegador', async () => {
    const owner = await registerVerifiedUser(app, 'gtermsrgpd');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const { contractId, link } = await draftWithLink(
      owner.accessToken,
      unitIds[0]!,
      'gt6@e2e.local',
    );
    const view = await http().get(`/public/move-in/sign/${link}`).expect(200);
    await http()
      .post(`/public/move-in/sign/${link}`)
      .set('User-Agent', 'navegador-de-prueba')
      .send({ ...signBody, generalTermsHash: view.body.generalTerms.hash })
      .expect(201);
    const contract = await db.contract.findUniqueOrThrow({ where: { id: contractId } });

    const exp = await http()
      .get(`/rgpd/customers/${contract.customerId}/export`)
      .set(auth)
      .expect(200);
    const c = exp.body.customer.contracts.find((x: { id: string }) => x.id === contractId);
    expect(c.signatures).toHaveLength(1);
    expect(c.legalDocAcceptances[0]).toMatchObject({
      channel: 'remote',
      userAgent: 'navegador-de-prueba',
    });
    expect(c.legalDocAcceptances[0].version.version).toBeGreaterThan(0);

    // Se da de baja el contrato para poder anonimizar.
    await db.contract.update({ where: { id: contractId }, data: { status: 'ended' } });
    await http().post(`/rgpd/customers/${contract.customerId}/anonymize`).set(auth).expect(204);
    const acc = await db.legalDocAcceptance.findFirstOrThrow({ where: { contractId } });
    expect(acc).toMatchObject({ ipAddress: null, userAgent: null });
    const sig = await db.contractSignature.findFirstOrThrow({ where: { contractId } });
    expect(sig).toMatchObject({ ipAddress: null, userAgent: null, signerEmail: null });
    // Se conserva la versión aceptada (prueba del contrato).
    expect(acc.versionId).toBeTruthy();
  });
});
