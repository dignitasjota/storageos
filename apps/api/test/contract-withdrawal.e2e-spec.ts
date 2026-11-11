import { withdrawalDeadline, withdrawalKeptCents } from '@storageos/shared';
import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Hoy en hora de España (la app fecha así la firma y el plazo). */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function tokenFromUrl(url: string): string {
  return url.slice(url.indexOf('/sign/') + '/sign/'.length);
}

/**
 * Desistimiento de los contratos que un particular firma a distancia: la
 * casilla de empezar ya al firmar, desistir desde el área de clientes o
 * registrarlo el equipo, con lo que se devuelve.
 */
describe('Desistimiento (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  const http = () => request(app.getHttpServer());

  /** Contrato del equipo enviado a firmar por enlace. */
  async function draftWithLink(
    suffix: string,
    opts: { startDate?: string; business?: boolean; deposit?: number } = {},
  ) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const email = `${suffix}@e2e.local`;
    const customerId = opts.business
      ? ((
          await http()
            .post('/customers')
            .set(auth)
            .send({
              customerType: 'business',
              companyName: 'Empresa SL',
              email,
              documentType: 'cif',
              documentNumber: 'B12345674',
              country: 'ES',
            })
            .expect(201)
        ).body.id as string)
      : await createCustomer(app, owner.accessToken, { email });
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: opts.startDate ?? today(),
        priceMonthly: 50,
        depositAmount: opts.deposit ?? 0,
        billingCycle: 'monthly',
      })
      .expect(201);
    const link = await http()
      .post(`/contracts/${contract.body.id}/request-signature`)
      .set(auth)
      .expect(201);
    return {
      owner,
      auth,
      customerId,
      unitId: unitIds[0]!,
      contractId: contract.body.id as string,
      token: tokenFromUrl(link.body.signingUrl as string),
    };
  }

  async function sign(token: string, immediateStart?: boolean) {
    return http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        signerName: 'Ana Ruiz',
        method: 'typed',
        typedSignature: 'Ana Ruiz',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
        ...(immediateStart !== undefined ? { immediateStart } : {}),
      });
  }

  it('al firmar a distancia hay que pedir empezar ya si empieza dentro de los 14 días', async () => {
    const d = await draftWithLink('wdr-sign');
    const view = await http().get(`/public/move-in/sign/${d.token}`).expect(200);
    expect(view.body.withdrawal).toEqual({
      applies: true,
      deadline: withdrawalDeadline(today()),
      immediateStartRequired: true,
    });
    expect(view.body.termsText).toContain('19. Desistimiento.');
    expect(view.body.termsText).toContain('Modelo de formulario de desistimiento');

    const missing = await sign(d.token);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('immediate_start_required');

    await sign(d.token, true).then((r) => expect(r.status).toBe(201));
    const frozen = await admin.contract.findUniqueOrThrow({ where: { id: d.contractId } });
    expect(frozen.signedTermsText).toContain('Modelo de formulario de desistimiento');
    const contract = await http().get(`/contracts/${d.contractId}`).set(d.auth).expect(200);
    expect(contract.body.withdrawalDeadline).toBe(withdrawalDeadline(today()));
    expect(contract.body.immediateStartRequestedAt).toEqual(expect.any(String));
    expect(contract.body.withdrawnAt).toBeNull();
    const record = await http().get(`/contracts/${d.contractId}/signing`).set(d.auth).expect(200);
    expect(record.body.withdrawalDeadline).toBe(withdrawalDeadline(today()));
    expect(record.body.immediateStartRequestedAt).toEqual(expect.any(String));

    // Si empieza después del plazo, no hace falta la casilla.
    const later = await draftWithLink('wdr-later', { startDate: addDays(today(), 20) });
    const laterView = await http().get(`/public/move-in/sign/${later.token}`).expect(200);
    expect(laterView.body.withdrawal.immediateStartRequired).toBe(false);
    await sign(later.token).then((r) => expect(r.status).toBe(201));
    const laterContract = await admin.contract.findUniqueOrThrow({
      where: { id: later.contractId },
    });
    expect(laterContract.withdrawalDeadline).not.toBeNull();
    expect(laterContract.immediateStartRequestedAt).toBeNull();

    // Una empresa no tiene derecho de desistimiento: ni casilla ni plazo.
    const business = await draftWithLink('wdr-business', { business: true });
    const businessView = await http().get(`/public/move-in/sign/${business.token}`).expect(200);
    expect(businessView.body.withdrawal.applies).toBe(false);
    expect(businessView.body.termsText).not.toContain('Modelo de formulario de desistimiento');
    await sign(business.token).then((r) => expect(r.status).toBe(201));
    const preview = await http()
      .get(`/contracts/${business.contractId}/withdrawal`)
      .set(business.auth)
      .expect(200);
    expect(preview.body).toMatchObject({ allowed: false, reason: 'not_applicable' });
  });

  it('desiste desde el área de clientes: se descuentan los días usados y la fianza se devuelve entera', async () => {
    const d = await draftWithLink('wdr-portal', { deposit: 60 });
    const signed = await sign(d.token, true);
    expect(signed.status).toBe(201);
    const portal = { Authorization: `Bearer ${signed.body.portalToken as string}` };

    // Paga la primera factura y la fianza en el local.
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId: d.contractId, kind: 'invoice' },
    });
    const receipt = await admin.invoice.findFirstOrThrow({
      where: { contractId: d.contractId, kind: 'deposit_receipt' },
    });
    for (const inv of [invoice, receipt]) {
      await http()
        .post(`/invoices/${inv.id}/mark-paid`)
        .set(d.auth)
        .send({ amount: Number(inv.total), methodType: 'cash' })
        .expect(200);
    }

    // El área de clientes enseña hasta cuándo puede desistir.
    const contracts = await http().get('/portal/me/contracts').set(portal).expect(200);
    const mine = (contracts.body as { id: string; withdrawalDeadline: string | null }[]).find(
      (c) => c.id === d.contractId,
    )!;
    expect(mine.withdrawalDeadline).toBe(withdrawalDeadline(today()));

    const paidCents = Math.round(Number(invoice.total) * 100);
    const keptCents = withdrawalKeptCents({
      paidCents,
      periodStart: invoice.periodStart!.toISOString().slice(0, 10),
      periodEnd: invoice.periodEnd!.toISOString().slice(0, 10),
      startDate: today(),
      communicatedOn: today(),
      immediateStartRequested: true,
    });
    expect(keptCents).toBeGreaterThan(0);
    const preview = await http()
      .get(`/portal/me/contracts/${d.contractId}/withdrawal`)
      .set(portal)
      .expect(200);
    expect(preview.body).toMatchObject({
      allowed: true,
      reason: null,
      immediateStartRequested: true,
      usedDays: 1,
      rentPaid: paidCents / 100,
      rentKept: keptCents / 100,
      rentRefund: (paidCents - keptCents) / 100,
      depositRefund: 60,
    });

    await http()
      .post(`/portal/me/contracts/${d.contractId}/withdraw`)
      .set(portal)
      .expect(200, { withdrawn: true });

    const contract = await admin.contract.findUniqueOrThrow({ where: { id: d.contractId } });
    expect(contract.status).toBe('cancelled');
    expect(contract.withdrawnAt).not.toBeNull();
    expect(contract.depositStatus).toBe('returned');
    const unit = await admin.unit.findUniqueOrThrow({ where: { id: d.unitId } });
    expect(unit.status).toBe('available');
    const refundedInvoice = await admin.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(Math.round(Number(refundedInvoice.amountRefunded) * 100)).toBe(paidCents - keptCents);
    const refundedReceipt = await admin.invoice.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(refundedReceipt.amountRefunded)).toBe(60);
    // Sin abono aparte de lo prepagado: lo devuelto ya está devuelto.
    expect(
      await admin.invoice.count({
        where: { rectifiesInvoiceId: invoice.id, status: 'draft' },
      }),
    ).toBe(0);

    // Aviso al equipo y acuse de recibo al inquilino.
    const notice = await admin.notification.findFirstOrThrow({
      where: { tenantId: contract.tenantId, type: 'contract.withdrawn' },
    });
    expect(notice.body).toContain('A devolver a mano');
    const ack = await admin.communication.findFirstOrThrow({
      where: { contractId: d.contractId, source: 'contract.withdrawal' },
    });
    expect(ack.recipient).toBe('wdr-portal@e2e.local');
    expect(ack.bodyText).toContain('Hemos registrado tu desistimiento');

    // No se puede desistir dos veces.
    const again = await http().post(`/portal/me/contracts/${d.contractId}/withdraw`).set(portal);
    expect(again.status).toBe(400);
    expect(again.body.details.reason).toBe('closed');
  });

  it('el equipo registra un desistimiento recibido por correo; fuera de plazo no se puede', async () => {
    // Sin pedir empezar ya (empieza después del plazo): se devuelve todo.
    const d = await draftWithLink('wdr-staff', { startDate: addDays(today(), 20) });
    await sign(d.token).then((r) => expect(r.status).toBe(201));

    const future = await http()
      .get(`/contracts/${d.contractId}/withdrawal?communicatedOn=${addDays(today(), 1)}`)
      .set(d.auth);
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('invalid_communicated_on');

    const preview = await http()
      .get(`/contracts/${d.contractId}/withdrawal?communicatedOn=${today()}`)
      .set(d.auth)
      .expect(200);
    expect(preview.body).toMatchObject({
      allowed: true,
      immediateStartRequested: false,
      usedDays: 0,
      rentKept: 0,
    });

    // Pasado el plazo, ya no.
    await admin.contract.update({
      where: { id: d.contractId },
      data: { withdrawalDeadline: new Date(`${addDays(today(), -1)}T00:00:00Z`) },
    });
    const late = await http()
      .post(`/contracts/${d.contractId}/withdraw`)
      .set(d.auth)
      .send({ communicatedOn: today() });
    expect(late.status).toBe(400);
    expect(late.body.details.reason).toBe('deadline_passed');

    // Comunicado dentro del plazo aunque se registre después: sí.
    await admin.contract.update({
      where: { id: d.contractId },
      data: { withdrawalDeadline: new Date(`${today()}T00:00:00Z`) },
    });
    const ok = await http()
      .post(`/contracts/${d.contractId}/withdraw`)
      .set(d.auth)
      .send({ communicatedOn: today(), note: 'Correo del inquilino' })
      .expect(200);
    expect(ok.body.status).toBe('cancelled');
    expect(ok.body.withdrawnAt).toEqual(expect.any(String));
    // La primera factura no estaba cobrada: se anula.
    const invoices = await admin.invoice.findMany({
      where: { contractId: d.contractId, kind: 'invoice', rectifiesInvoiceId: null },
    });
    for (const inv of invoices) expect(['cancelled', 'rectified']).toContain(inv.status);
    const events = await admin.contractEvent.findMany({
      where: { contractId: d.contractId, eventType: 'note_added' },
    });
    const event = events.find((e) => (e.payload as { kind?: string }).kind === 'withdrawn');
    expect(event?.payload).toMatchObject({
      kind: 'withdrawn',
      by: 'staff',
      note: 'Correo del inquilino',
    });

    // Un contrato firmado en el local no tiene desistimiento.
    const local = await draftWithLink('wdr-local');
    await http().post(`/contracts/${local.contractId}/sign`).set(local.auth).send({}).expect(200);
    const localPreview = await http()
      .get(`/contracts/${local.contractId}/withdrawal`)
      .set(local.auth)
      .expect(200);
    expect(localPreview.body).toMatchObject({ allowed: false, reason: 'not_applicable' });
    // Ni el formulario de desistimiento en el texto firmado.
    const localContract = await admin.contract.findUniqueOrThrow({
      where: { id: local.contractId },
    });
    expect(localContract.signedTermsText).toContain('19. Desistimiento.');
    expect(localContract.signedTermsText).not.toContain('Modelo de formulario de desistimiento');
  });
});
