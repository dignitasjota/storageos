import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function tokenFromUrl(url: string): string {
  const marker = '/sign/';
  return url.slice(url.indexOf(marker) + marker.length);
}

describe('Move-in: firma electrónica + booking (e2e)', () => {
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

  it('staff solicita firma → cliente firma por enlace → contrato activo', async () => {
    const owner = await registerVerifiedUser(app, 'movein-sign');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: 'firmante@e2e.local',
    });

    const contractRes = await request(app.getHttpServer())
      .post('/contracts')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 50,
        billingCycle: 'monthly',
      });
    expect(contractRes.status).toBe(201);
    const contractId = contractRes.body.id as string;

    const reqSig = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/request-signature`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(reqSig.status).toBe(201);
    const token = tokenFromUrl(reqSig.body.signingUrl as string);
    expect(token).toContain('.');

    // Vista pública del contrato a firmar.
    const view = await request(app.getHttpServer()).get(`/public/move-in/sign/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.alreadySigned).toBe(false);
    expect(view.body.termsText).toContain(view.body.contractNumber);

    // Firma pública.
    const signed = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${token}`)
      .send({
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      });
    expect(signed.status).toBe(201);
    expect(signed.body.status).toBe('active');

    // El contrato quedó activo y hay registro de firma.
    const detail = await request(app.getHttpServer())
      .get(`/contracts/${contractId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.body.status).toBe('active');

    const sigs = await request(app.getHttpServer())
      .get(`/contracts/${contractId}/signatures`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(sigs.status).toBe(200);
    expect(sigs.body).toHaveLength(1);
    expect(sigs.body[0].method).toBe('typed');
  });

  it('token inválido → 401', async () => {
    const res = await request(app.getHttpServer()).get('/public/move-in/sign/no-existe.malo');
    expect(res.status).toBe(401);
  });

  it('booking público: disponibilidad + alta → token de firma → firma', async () => {
    const owner = await registerVerifiedUser(app, 'movein-book');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Book',
      typeName: 'Mediano',
      unitsCount: 2,
    });

    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    expect(avail.status).toBe(200);
    // Sin GA4 configurado -> null (no rompe el embudo aunque el tenant no lo use).
    expect(avail.body.googleAnalyticsId).toBeNull();
    const facility = avail.body.facilities[0];
    expect(facility.unitTypes[0].available).toBeGreaterThan(0);
    // Slug público del local: la reserva del dominio propio es /reservar/<slug>.
    expect(typeof facility.publicSlug).toBe('string');

    // Todos los datos personales son obligatorios: sin teléfono ni documento → 400.
    const incomplete = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: { firstName: 'Bea', lastName: 'López', email: 'bea@e2e.local' },
      });
    expect(incomplete.status).toBe(400);
    const badPhone = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: {
          firstName: 'Bea',
          lastName: 'López',
          email: 'bea@e2e.local',
          phone: '123',
          documentNumber: '12345678Z',
        },
      });
    expect(badPhone.status).toBe(400);
    const tooFar = new Date();
    tooFar.setUTCFullYear(tooFar.getUTCFullYear() + 2);
    const farBooking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: tooFar.toISOString().slice(0, 10),
        customer: {
          firstName: 'Bea',
          lastName: 'López',
          email: 'bea@e2e.local',
          phone: '600000000',
          documentNumber: '12345678Z',
        },
      });
    expect(farBooking.status).toBe(400);
    expect(farBooking.body.code).toBe('start_date_too_far');

    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Bea',
          lastName: 'López',
          email: 'bea@e2e.local',
        },
      });
    expect(booking.status).toBe(201);
    expect(booking.body.signingToken).toContain('.');

    // El paso de firma también expone GA4 (antes ni siquiera cargaba el
    // script en /book ni /sign, el embudo era invisible en analítica).
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ googleAnalyticsId: 'G-ABC1234567' })
      .expect(200);
    const signView = await request(app.getHttpServer()).get(
      `/public/move-in/sign/${booking.body.signingToken}`,
    );
    expect(signView.status).toBe(200);
    expect(signView.body.googleAnalyticsId).toBe('G-ABC1234567');

    const signed = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({
        signerName: 'Bea López',
        method: 'typed',
        typedSignature: 'Bea López',
        accept: true,
        generalTermsHash: await generalTermsHash(app, booking.body.signingToken),
      });
    expect(signed.status).toBe(201);
    expect(signed.body.status).toBe('active');

    // El inquilino nuevo también recibe el enlace por correo.
    const comms = await request(app.getHttpServer())
      .get('/communications?source=booking.signing_link')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect((comms.body as { recipient: string }[]).map((c) => c.recipient)).toContain(
      'bea@e2e.local',
    );

    // Volver al enlace tras firmar: «ya firmado» y se puede pagar la 1ª factura.
    const again = await request(app.getHttpServer())
      .get(`/public/move-in/sign/${booking.body.signingToken}`)
      .expect(200);
    expect(again.body.alreadySigned).toBe(true);
    expect(again.body.signedAt).toEqual(expect.any(String));
    expect(again.body.paymentPending).toBe(true);
    const session = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}/payment`)
      .expect(200);
    expect(session.body.portalToken).toEqual(expect.any(String));
  });

  it('el equipo edita el borrador, el inquilino no firma un texto que no vio y queda el registro', async () => {
    const owner = await registerVerifiedUser(app, 'movein-edit');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: 'editado@e2e.local',
    });
    const created = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-04-01', priceMonthly: 60 })
      .expect(201);
    const contractId = created.body.id as string;

    const reqSig = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/request-signature`)
      .set(auth)
      .expect(201);
    const token = tokenFromUrl(reqSig.body.signingUrl as string);
    const view = await request(app.getHttpServer())
      .get(`/public/move-in/sign/${token}`)
      .expect(200);
    expect(view.body.termsText).toContain('Arrendador:');
    expect(view.body.termsText).toContain('Condiciones generales:');
    expect(view.body.termsText).toContain('Cuota mensual: 60,00 € + IVA (21 %)');
    expect(view.body.termsHash).toMatch(/^[0-9a-f]{64}$/);

    // Registro en la ficha: borrador con el enlace vigente.
    const draftRecord = await request(app.getHttpServer())
      .get(`/contracts/${contractId}/signing`)
      .set(auth)
      .expect(200);
    expect(draftRecord.body).toMatchObject({
      status: 'draft',
      termsFrozen: false,
      signingLinkActive: true,
      termsHash: view.body.termsHash,
      signatures: [],
    });

    // Sin firmar no hay nada que pagar desde el enlace.
    const nothing = await request(app.getHttpServer()).post(
      `/public/move-in/sign/${token}/payment`,
    );
    expect(nothing.status).toBe(409);
    expect(nothing.body.code).toBe('nothing_to_pay');

    // El equipo cambia el borrador mientras el inquilino lo tiene abierto.
    const edited = await request(app.getHttpServer())
      .patch(`/contracts/${contractId}`)
      .set(auth)
      .send({ priceMonthly: 65, startDate: '2026-04-15', depositAmount: 120 })
      .expect(200);
    expect(edited.body).toMatchObject({ priceMonthly: 65, depositAmount: 120 });
    expect(edited.body.startDate.slice(0, 10)).toBe('2026-04-15');

    const signBody = {
      signerName: 'Eva Editada',
      method: 'drawn',
      signatureImage: 'data:image/png;base64,iVBORw0KGgo=',
      accept: true,
      generalTermsHash: view.body.generalTerms.hash,
    };
    const stale = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${token}`)
      .send({ ...signBody, termsHash: view.body.termsHash });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('terms_changed');

    const fresh = await request(app.getHttpServer())
      .get(`/public/move-in/sign/${token}`)
      .expect(200);
    expect(fresh.body.termsText).toContain('Cuota mensual: 65,00 €');
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${token}`)
      .send({ ...signBody, termsHash: fresh.body.termsHash })
      .expect(201);

    // Lo firmado queda con su evidencia y la huella del texto congelado.
    const record = await request(app.getHttpServer())
      .get(`/contracts/${contractId}/signing`)
      .set(auth)
      .expect(200);
    expect(record.body.status).toBe('active');
    expect(record.body.termsFrozen).toBe(true);
    expect(record.body.termsHash).toBe(fresh.body.termsHash);
    expect(record.body.signingLinkActive).toBe(false);
    expect(record.body.signatures).toHaveLength(1);
    expect(record.body.signatures[0]).toMatchObject({
      signerName: 'Eva Editada',
      method: 'drawn',
      signatureImage: 'data:image/png;base64,iVBORw0KGgo=',
      documentHash: fresh.body.termsHash,
      hashMatches: true,
    });

    // Firmado: precio, inicio y fianza ya no se tocan desde la edición.
    const locked = await request(app.getHttpServer())
      .patch(`/contracts/${contractId}`)
      .set(auth)
      .send({ priceMonthly: 70 });
    expect(locked.status).toBe(400);
    expect(locked.body.code).toBe('contract_not_draft');
  });

  it('booking con honeypot relleno → 400', async () => {
    const owner = await registerVerifiedUser(app, 'movein-spam');
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const res = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        startDate: '2026-03-01',
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Bot',
          lastName: 'Spam',
          email: 'bot@e2e.local',
        },
        website: 'http://spam.example',
      });
    expect(res.status).toBe(400);
  });

  it('con el email de un inquilino que ya existe no se devuelve el enlace: se le envía por correo', async () => {
    const owner = await registerVerifiedUser(app, 'movein-existing');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const victimId = await createCustomer(app, owner.accessToken, {
      email: 'victima.existente@e2e.local',
    });

    // Otra persona reserva con su email (cambiando mayúsculas).
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: fac.facilityId,
        unitTypeId: fac.unitTypeId,
        startDate: '2026-03-01',
        customer: {
          firstName: 'Intruso',
          lastName: 'Ajeno',
          email: 'Victima.Existente@E2E.local',
          phone: '600000000',
          documentNumber: '12345678Z',
        },
      });
    expect(booking.status).toBe(201);
    expect(booking.body.signingToken).toBeNull();
    expect(booking.body.signingLinkSentTo).toBe('v***e@e2e.local');

    // La reserva es del inquilino existente (no se duplica) y el enlace solo va a su email.
    const contract = await request(app.getHttpServer())
      .get(`/contracts/${booking.body.contractId}`)
      .set(auth)
      .expect(200);
    expect(contract.body.customerId).toBe(victimId);
    const comms = await request(app.getHttpServer())
      .get('/communications?source=booking.signing_link')
      .set(auth)
      .expect(200);
    const sent = comms.body as { recipient: string; bodyText: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.recipient).toBe('victima.existente@e2e.local');
    expect(sent[0]!.bodyText).toContain('/sign/');
    expect(sent[0]!.bodyText).toContain('Si no has hecho tú esta reserva');

    // Un cliente nuevo sigue en la misma pantalla con su enlace.
    const fresh = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: fac.facilityId,
        unitTypeId: fac.unitTypeId,
        startDate: '2026-03-01',
        customer: {
          firstName: 'Nuevo',
          lastName: 'Cliente',
          email: `nuevo-${Date.now()}@e2e.local`,
          phone: '600000001',
          documentNumber: '87654321X',
        },
      });
    expect(fresh.status).toBe(201);
    expect(fresh.body.signingToken).toContain('.');
    expect(fresh.body.signingLinkSentTo).toBeNull();
  });
});
