import request from 'supertest';

import { AEAT_CLIENT, type AeatClient } from '../src/modules/billing/aeat-client';
import { formatSpanishDate } from '../src/modules/billing/aeat-client/verifactu-xml-builder';
import { computeAltaHash } from '../src/modules/billing/verifactu-hash';
import { VerifactuSettingsService } from '../src/modules/billing/verifactu-settings.service';
import { VerifactuService } from '../src/modules/billing/verifactu.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  createDraftInvoice,
  quiesceVerifactuQueue,
  recordsOf,
  setAeatStatus,
  waitForAeatStatus,
} from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, enableVerifactu } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { SendBatchArgs } from '../src/modules/billing/aeat-client/aeat-client';
import type { INestApplication } from '@nestjs/common';

/**
 * Registros de Veri*Factu por separado: subsanación de lo rechazado o
 * aceptado con avisos, anulación de una factura emitida por error, baja a
 * final de año (renuncia, art. 17) e incidencias (art. 16.4). La AEAT es la
 * simulada (`AEAT_MODE=stub`): acepta todo lo que se le envía.
 */
describe('Veri*Factu: subsanación, anulación, renuncia e incidencias (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let aeat: AeatClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    aeat = app.get(AEAT_CLIENT);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    // Los envíos que quedaron esperando a la AEAT simulada no salen ya.
    await quiesceVerifactuQueue(app);
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  async function setup(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    await enableVerifactu(owner.slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const issue = async (unitPrice = 50): Promise<string> => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
      await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
      expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');
      return id;
    };
    return { owner, auth, customerId, issue };
  }

  it('una rechazada se corrige con un registro nuevo de subsanación al final de la cadena', async () => {
    const { owner, auth, issue } = await setup('vfsubs');
    const id = await issue();
    await setAeatStatus(app, id, 'rejected', '[1105] NIF del destinatario no identificado');

    const res = await http()
      .post(`/billing/invoices/${id}/resend-aeat`)
      .set(auth)
      .send({ reason: 'Corregido el NIF del cliente' })
      .expect(202);
    expect(res.body).toEqual({ queued: true, invoiceId: id, subsanacion: true });
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');

    const [original, fix] = await recordsOf(app, id);
    // El original no se toca: sigue rechazado.
    expect(original).toMatchObject({ kind: 'alta', subsanacion: false, status: 'rejected' });
    // La AEAT no tiene la factura (el alta se rechazó): RechazoPrevio=X.
    expect(fix).toMatchObject({
      kind: 'alta',
      subsanacion: true,
      rechazoPrevio: 'X',
      status: 'accepted',
      chainSeq: original!.chainSeq + 1,
      previousRecordId: original!.id,
      previousHash: original!.hash,
      reason: 'Corregido el NIF del cliente',
    });
    expect(fix!.xml).toContain('<sum1:Subsanacion>S</sum1:Subsanacion>');
    expect(fix!.xml).toContain('<sum1:RechazoPrevio>X</sum1:RechazoPrevio>');
    expect(fix!.xml).toContain(`<sum1:RefExterna>${fix!.id}</sum1:RefExterna>`);

    // Su huella es la oficial, encadenada con la del registro rechazado.
    const invoice = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(
      computeAltaHash({
        emitterTaxId: 'PENDIENTE',
        invoiceNumber: invoice.invoiceNumber,
        issueDate: formatSpanishDate(invoice.issueDate!),
        invoiceType: invoice.invoiceType,
        cuotaTotal: Number(invoice.taxAmount),
        importeTotal: Number(invoice.total),
        previousHash: original!.hash,
        recordTimestamp: fix!.recordTimestamp,
      }),
    ).toBe(fix!.hash);
    // La factura conserva la huella y el QR de su alta.
    expect(invoice.hash).toBe(original!.hash);

    const list = await http()
      .get(`/billing/invoices/${id}/verifactu-records`)
      .set(auth)
      .expect(200);
    expect(list.body.map((r: { subsanacion: boolean }) => r.subsanacion)).toEqual([false, true]);
    expect(list.body[0]).toMatchObject({
      status: 'rejected',
      message: '[1105] NIF del destinatario no identificado',
    });

    // Ya aceptada: no se reenvía.
    const again = await http().post(`/billing/invoices/${id}/resend-aeat`).set(auth).expect(400);
    expect(again.body.code).toBe('already_accepted');
  });

  it('aceptada con avisos: subsanación sin rechazo previo; rechazada esa, con RechazoPrevio=S', async () => {
    const { owner, auth, issue } = await setup('vfsubs2');
    const id = await issue();
    await setAeatStatus(app, id, 'accepted_with_warnings', '[2001] NIF no censado');

    await http().post(`/billing/invoices/${id}/resend-aeat`).set(auth).expect(202);
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');
    let records = await recordsOf(app, id);
    expect(records[1]).toMatchObject({ subsanacion: true, rechazoPrevio: null });
    expect(records[1]!.xml).not.toContain('RechazoPrevio');

    // La AEAT tiene la factura (la primera alta se registró): RechazoPrevio=S.
    await setAeatStatus(app, id, 'rejected', '[1100] Valor incorrecto');
    await http().post(`/billing/invoices/${id}/resend-aeat`).set(auth).expect(202);
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');
    records = await recordsOf(app, id);
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({ subsanacion: true, rechazoPrevio: 'S' });
  });

  it('anular por error: registro de anulación, fuera del libro de IVA y con las condiciones', async () => {
    const { owner, auth, issue } = await setup('vfvoid');
    const id = await issue(80);
    const keep = await issue(30);

    // Sin motivo, no.
    await http().post(`/invoices/${id}/void`).set(auth).send({ reason: 'x' }).expect(400);
    // Mientras su registro no tiene respuesta de la AEAT, no.
    await setAeatStatus(app, id, 'pending');
    const busy = await http()
      .post(`/invoices/${id}/void`)
      .set(auth)
      .send({ reason: 'Factura de prueba emitida por error' })
      .expect(409);
    expect(busy.body.code).toBe('verifactu_record_pending');
    await setAeatStatus(app, id, 'accepted');

    const res = await http()
      .post(`/invoices/${id}/void`)
      .set(auth)
      .send({ reason: 'Factura de prueba emitida por error' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      voidReason: 'Factura de prueba emitida por error',
    });
    expect(res.body.voidedAt).toBeTruthy();
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');

    const [alta, anulacion] = await recordsOf(app, id);
    expect(anulacion).toMatchObject({
      kind: 'anulacion',
      sinRegistroPrevio: false,
      rechazoPrevio: null,
      status: 'accepted',
      previousHash: expect.any(String),
    });
    expect(anulacion!.chainSeq).toBeGreaterThan(alta!.chainSeq);
    expect(anulacion!.xml).toContain('<sum1:RegistroAnulacion>');
    expect(anulacion!.xml).toContain(
      `<sum1:NumSerieFacturaAnulada>${res.body.invoiceNumber}</sum1:NumSerieFacturaAnulada>`,
    );

    // Deja de contar en los libros; la otra sigue.
    const year = new Date().getUTCFullYear();
    const book = await http()
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(auth)
      .expect(200);
    const numbers = (book.body.rows as { invoiceId?: string; invoiceNumber: string }[]).map(
      (r) => r.invoiceNumber,
    );
    expect(numbers).not.toContain(res.body.invoiceNumber);
    const kept = await admin.invoice.findUniqueOrThrow({ where: { id: keep } });
    expect(numbers).toContain(kept.invoiceNumber);

    // No se anula dos veces; una cobrada, tampoco.
    const twice = await http()
      .post(`/invoices/${id}/void`)
      .set(auth)
      .send({ reason: 'Otra vez por error' })
      .expect(400);
    expect(twice.body.code).toBe('invoice_not_voidable');
    await http()
      .post(`/invoices/${keep}/mark-paid`)
      .set(auth)
      .send({ amount: 36.3, methodType: 'cash' })
      .expect(200);
    const paid = await http()
      .post(`/invoices/${keep}/void`)
      .set(auth)
      .send({ reason: 'Factura de prueba emitida por error' })
      .expect(400);
    expect(paid.body.code).toBe('invoice_not_voidable');
  });

  it('anular una que la AEAT rechazó: anulación sin registro previo', async () => {
    const { auth, issue, owner } = await setup('vfvoidrej');
    const id = await issue();
    await setAeatStatus(app, id, 'rejected', '[1105] NIF del destinatario no identificado');
    await http()
      .post(`/invoices/${id}/void`)
      .set(auth)
      .send({ reason: 'Emitida por error a otro cliente' })
      .expect(200);
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');
    const records = await recordsOf(app, id);
    expect(records[1]).toMatchObject({ kind: 'anulacion', sinRegistroPrevio: true });
    expect(records[1]!.xml).toContain('<sum1:SinRegistroPrevio>S</sum1:SinRegistroPrevio>');
  });

  it('sin Veri*Factu activado, anular por error no genera ningún registro', async () => {
    const owner = await registerVerifiedUser(app, 'vfvoidoff');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
    const res = await http()
      .post(`/invoices/${id}/void`)
      .set(auth)
      .send({ reason: 'Factura duplicada' })
      .expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(await recordsOf(app, id)).toHaveLength(0);
  });

  it('dejar Veri*Factu: sin registros se apaga ya; con registros, baja a final de año con la renuncia', async () => {
    // Activado sin haber emitido nada: se apaga en el momento.
    const fresh = await registerVerifiedUser(app, 'vfrenew');
    await enableVerifactu(fresh.slug);
    const off = await http()
      .put('/billing/verifactu/settings')
      .set({ Authorization: `Bearer ${fresh.accessToken}` })
      .send({ enabled: false })
      .expect(200);
    expect(off.body).toMatchObject({ enabled: false, renuncia: null });

    const { owner, auth, issue } = await setup('vfrenun');
    await issue();
    const year = new Date().getUTCFullYear();
    const scheduled = await http()
      .put('/billing/verifactu/settings')
      .set(auth)
      .send({ enabled: false })
      .expect(200);
    expect(scheduled.body).toMatchObject({
      enabled: true,
      lockedUntil: `${year}-12-31`,
      renuncia: { endDate: `${year}-12-31`, communicatedAt: null, pendingEmitters: 1 },
    });

    // El siguiente envío lleva la renuncia en la cabecera.
    const calls: SendBatchArgs[] = [];
    const real = aeat.sendBatch.bind(aeat);
    jest.spyOn(aeat, 'sendBatch').mockImplementation(async (args) => {
      calls.push(args);
      return real(args);
    });
    await issue();
    expect(calls[0]!.remision?.fechaFinVerifactu?.toISOString().slice(0, 10)).toBe(`${year}-12-31`);
    const sub = await admin.verifactuSubmission.findFirstOrThrow({
      where: { tenantId: owner.tenantId },
      orderBy: { sentAt: 'desc' },
    });
    expect(sub.fechaFinVerifactu?.toISOString().slice(0, 10)).toBe(`${year}-12-31`);
    const settings = await http().get('/billing/verifactu/settings').set(auth).expect(200);
    expect(settings.body.renuncia.communicatedAt).toBeTruthy();
    expect(settings.body.renuncia.pendingEmitters).toBe(0);

    // Comunicada, ya no se anula.
    const undo = await http()
      .put('/billing/verifactu/settings')
      .set(auth)
      .send({ enabled: true })
      .expect(409);
    expect(undo.body.code).toBe('verifactu_renuncia_sent');

    // Pasado el 31 de diciembre, se apaga.
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: { verifactuEndDate: new Date(`${year - 1}-12-31T00:00:00Z`) },
    });
    await admin.verifactuSubmission.update({
      where: { id: sub.id },
      data: { fechaFinVerifactu: new Date(`${year - 1}-12-31T00:00:00Z`) },
    });
    await admin.verifactuRecord.updateMany({
      where: { tenantId: owner.tenantId },
      data: { createdAt: new Date(`${year - 1}-11-30T10:00:00Z`) },
    });
    const run = await app.get(VerifactuSettingsService).applyDueRenuncias();
    expect(run.disabled).toBeGreaterThanOrEqual(1);
    const after = await admin.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } });
    expect(after.verifactuEnabled).toBe(false);
  });

  it('la baja que no llega a la AEAT no se aplica: sigue activado y se avisa; antes se puede anular', async () => {
    const { owner, auth, issue } = await setup('vfrenun2');
    await issue();
    await http().put('/billing/verifactu/settings').set(auth).send({ enabled: false }).expect(200);
    // Aún no ha salido ningún envío con la renuncia: se puede anular.
    const undo = await http()
      .put('/billing/verifactu/settings')
      .set(auth)
      .send({ enabled: true })
      .expect(200);
    expect(undo.body.renuncia).toBeNull();

    // Programada otra vez y el año acaba sin ningún envío más.
    await http().put('/billing/verifactu/settings').set(auth).send({ enabled: false }).expect(200);
    const year = new Date().getUTCFullYear();
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: { verifactuEndDate: new Date(`${year - 1}-12-31T00:00:00Z`) },
    });
    await admin.verifactuRecord.updateMany({
      where: { tenantId: owner.tenantId },
      data: { createdAt: new Date(`${year - 1}-11-30T10:00:00Z`) },
    });
    await app.get(VerifactuSettingsService).applyDueRenuncias();
    const after = await admin.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } });
    expect(after).toMatchObject({ verifactuEnabled: true, verifactuEndDate: null });
    const notice = await admin.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'verifactu.renuncia_not_sent' },
    });
    expect(notice?.title).toBe('Sigues en Veri*Factu');
  });

  it('tras un fallo, lo pendiente sale marcado como incidencia y aparte de lo demás', async () => {
    const { owner, customerId, issue } = await setup('vfincid');
    await issue();
    // El último envío del emisor falló: lo que se emite ahora sale tarde.
    await admin.verifactuEmitter.updateMany({
      where: { tenantId: owner.tenantId },
      data: { consecutiveFailures: 1, retryAt: new Date(Date.now() + 3_600_000) },
    });
    const calls: SendBatchArgs[] = [];
    const real = aeat.sendBatch.bind(aeat);
    jest.spyOn(aeat, 'sendBatch').mockImplementation(async (args) => {
      calls.push(args);
      return real(args);
    });
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    await http()
      .post(`/invoices/${id}/issue`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    expect((await recordsOf(app, id))[0]!.incident).toBe(true);
    const alert = await http()
      .get('/billing/verifactu/alert')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    expect(alert.body.unsentCount).toBe(1);

    // Llega el reintento: sale con Incidencia=S.
    await admin.verifactuEmitter.updateMany({
      where: { tenantId: owner.tenantId },
      data: { retryAt: null, nextSendAt: null },
    });
    await app.get(VerifactuService).sendPending(owner.tenantId, null);
    expect(calls.at(-1)!.remision?.incidencia).toBe(true);
    const sub = await admin.verifactuSubmission.findFirstOrThrow({
      where: { tenantId: owner.tenantId },
      orderBy: { sentAt: 'desc' },
    });
    expect(sub.incident).toBe(true);
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');
    const cleared = await http()
      .get('/billing/verifactu/alert')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    expect(cleared.body.unsentCount).toBe(0);
  });
});
