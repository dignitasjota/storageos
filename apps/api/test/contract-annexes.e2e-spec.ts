import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Anexos a un contrato firmado: el equipo los crea, el inquilino los firma con
 * el enlace del correo o desde su área de clientes.
 */
describe('Anexos a un contrato firmado (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

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

  const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;

  async function portalSession(auth: Record<string, string>, customerId: string) {
    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  async function signContract(auth: Record<string, string>, contractId: string) {
    const reqSig = await http()
      .post(`/contracts/${contractId}/request-signature`)
      .set(auth)
      .expect(201);
    const token = tokenOf(reqSig.body.signingUrl as string);
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      })
      .expect(201);
  }

  it('se crean en contratos firmados, se firman con el enlace y se pueden cancelar', async () => {
    const owner = await registerVerifiedUser(app, 'annexes');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const email = `annex-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 50 })
      .expect(201);
    const contractId = contract.body.id as string;
    const annex = {
      title: 'Cancelación si no abre',
      body: 'Si el local no abre el 1 de marzo, el inquilino puede cancelar sin coste.',
    };

    // En borrador, no: las condiciones van en el propio contrato.
    const draft = await http()
      .post(`/contracts/${contractId}/annexes`)
      .set(auth)
      .send(annex)
      .expect(409);
    expect(draft.body.code).toBe('contract_not_signed');

    await signContract(auth, contractId);
    const created = await http()
      .post(`/contracts/${contractId}/annexes`)
      .set(auth)
      .send(annex)
      .expect(201);
    expect(created.body.annex).toMatchObject({ number: 1, status: 'pending', sentTo: email });
    expect(created.body.emailed).toBe(true);
    expect(created.body.signingUrl).toContain('/sign/annex/');
    // Las partes salen del contrato firmado.
    expect(created.body.annex.termsText).toContain('Anexo 1 al contrato de alquiler');
    expect(created.body.annex.termsText).toMatch(/\nInquilino: /);
    expect((created.body.annex.termsText as string).match(/\nInquilino: /g)).toHaveLength(1);
    const comms = await http().get('/communications?source=contract.annex').set(auth).expect(200);
    expect((comms.body as { recipient: string }[])[0]!.recipient).toBe(email);

    // Firma con el enlace.
    const token = tokenOf(created.body.signingUrl as string);
    const view = await http().get(`/public/annexes/sign/${token}`).expect(200);
    expect(view.body).toMatchObject({ number: 1, status: 'pending', locale: 'es' });
    const badHash = await http()
      .post(`/public/annexes/sign/${token}`)
      .send({
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
        documentHash: '0'.repeat(64),
      })
      .expect(409);
    expect(badHash.body.code).toBe('annex_changed');
    const sign = {
      signerName: 'Ana García',
      method: 'typed',
      typedSignature: 'Ana García',
      accept: true,
      documentHash: view.body.documentHash,
    };
    await http().post(`/public/annexes/sign/${token}`).send(sign).expect(201);
    const twice = await http().post(`/public/annexes/sign/${token}`).send(sign).expect(409);
    expect(twice.body.code).toBe('annex_already_signed');
    expect((await http().get(`/public/annexes/sign/${token}`).expect(200)).body.status).toBe(
      'signed',
    );

    const list = await http().get(`/contracts/${contractId}/annexes`).set(auth).expect(200);
    expect(list.body[0]).toMatchObject({ number: 1, status: 'signed', signerName: 'Ana García' });
    expect(list.body[0].ipAddress).toBeTruthy();
    const resendSigned = await http()
      .post(`/contracts/${contractId}/annexes/${list.body[0].id as string}/resend`)
      .set(auth)
      .expect(409);
    expect(resendSigned.body.code).toBe('annex_not_pending');
    const notifs = await http().get('/notifications').set(auth).expect(200);
    expect(
      (notifs.body.items as { type: string }[]).some((n) => n.type === 'contract.annex_signed'),
    ).toBe(true);

    // Otro: se cancela y su enlace deja de valer.
    const second = await http()
      .post(`/contracts/${contractId}/annexes`)
      .set(auth)
      .send(annex)
      .expect(201);
    expect(second.body.annex.number).toBe(2);
    await http()
      .post(`/contracts/${contractId}/annexes/${second.body.annex.id as string}/cancel`)
      .set(auth)
      .expect(200);
    const cancelled = await http()
      .get(`/public/annexes/sign/${tokenOf(second.body.signingUrl as string)}`)
      .expect(401);
    expect(cancelled.body.code).toBe('annex_cancelled');

    // Un enlace caducado manda al área de clientes.
    const third = await http()
      .post(`/contracts/${contractId}/annexes`)
      .set(auth)
      .send(annex)
      .expect(201);
    const admin = app.get(PrismaAdminService);
    await admin.contractAnnex.update({
      where: { id: third.body.annex.id as string },
      data: { signingTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await http()
      .get(`/public/annexes/sign/${tokenOf(third.body.signingUrl as string)}`)
      .expect(401);
    expect(expired.body.code).toBe('annex_link_expired');

    // Área de clientes: ve el firmado y el pendiente (no el cancelado) y firma con un enlace nuevo.
    const portal = await portalSession(auth, customerId);
    const mine = await http().get('/portal/me/annexes').set(portal).expect(200);
    expect(
      (mine.body as { number: number; status: string }[]).map((a) => [a.number, a.status]),
    ).toEqual([
      [3, 'pending'],
      [1, 'signed'],
    ]);
    const pdfPending = await http()
      .get(`/portal/me/annexes/${third.body.annex.id as string}/pdf`)
      .set(portal)
      .expect(409);
    expect(pdfPending.body.code).toBe('annex_not_signed');
    const link = await http()
      .post(`/portal/me/annexes/${third.body.annex.id as string}/sign-link`)
      .set(portal)
      .expect(200);
    const fresh = await http()
      .get(`/public/annexes/sign/${link.body.token as string}`)
      .expect(200);
    await http()
      .post(`/public/annexes/sign/${link.body.token as string}`)
      .send({ ...sign, documentHash: fresh.body.documentHash })
      .expect(201);

    // El de otro inquilino no se puede pedir.
    const otherId = await createCustomer(app, owner.accessToken);
    const otherPortal = await portalSession(auth, otherId);
    await http()
      .post(`/portal/me/annexes/${third.body.annex.id as string}/sign-link`)
      .set(otherPortal)
      .expect(404);
    expect((await http().get('/portal/me/annexes').set(otherPortal).expect(200)).body).toEqual([]);
  }, 90_000);
});
