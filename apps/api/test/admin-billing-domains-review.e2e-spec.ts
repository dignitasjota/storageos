import { ConfigService } from '@nestjs/config';
import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { CustomDomainCheckService } from '../src/modules/users/custom-domain-check.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import {
  cleanupTestTenants,
  enableVerifactu,
  setTenantFeatureOverride,
  setTenantPlan,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-bdr-test@storageos.local';
const DAY = 86_400_000;

/** Dominio de prueba cuyo DNS «apunta» (los que empiezan por `ready`). */
const readyDomain = () =>
  `ready-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.example.com`;
/** Dominio de prueba cuyo DNS no apunta. */
const deadDomain = () =>
  `dead-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.example.com`;

describe('Problemas de facturación y dominios propios: arreglos (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminAuth: { Authorization: string };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin BDR',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  /** Simula la configuración de la plataforma (modo de la AEAT). */
  function withConfig(values: Record<string, unknown>) {
    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    return jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string, opts?: unknown) =>
        key in values ? values[key] : original(key, opts as never)) as never);
  }

  /** Tenant con Veri*Factu activado y una factura emitida y ya procesada. */
  async function tenantWithInvoice(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    await enableVerifactu(owner.slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `${prefix}@e2e.local`,
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    // Espera a que el envío simulado termine para que nada lo toque después.
    let record = await admin.verifactuRecord.findFirst({ where: { invoiceId } });
    for (let i = 0; i < 40 && (!record || record.status === 'pending'); i++) {
      await new Promise((r) => setTimeout(r, 250));
      record = await admin.verifactuRecord.findFirst({ where: { invoiceId } });
    }
    const tenant = await admin.tenant.findUniqueOrThrow({
      where: { id: owner.tenantId },
      select: { id: true },
    });
    return { owner, auth, invoiceId, tenantId: tenant.id };
  }

  const health = async () =>
    (await http().get('/admin/billing-health').set(adminAuth).expect(200)).body;
  const rowOf = (body: { tenants: { tenantId: string }[] }, tenantId: string) =>
    body.tenants.find((t) => t.tenantId === tenantId);

  // ------------------------------------------------------------------ facturación

  it('F1/F2/F3: registros sin enviar, aceptadas con errores y envíos fallidos', async () => {
    const stuck = await tenantWithInvoice('bdrstuck');
    // El registro nunca llegó a enviarse: pendiente desde hace 10 días.
    await admin.verifactuRecord.updateMany({
      where: { invoiceId: stuck.invoiceId },
      data: { status: 'pending', sentAt: null, createdAt: new Date(Date.now() - 10 * DAY) },
    });
    await admin.invoice.update({
      where: { id: stuck.invoiceId },
      data: { aeatStatus: 'pending', aeatSentAt: null },
    });
    await admin.verifactuEmitter.upsert({
      where: { tenantId_emitterKey: { tenantId: stuck.tenantId, emitterKey: 'self' } },
      create: {
        tenantId: stuck.tenantId,
        emitterKey: 'self',
        consecutiveFailures: 6,
        lastError: 'SOAP fault: certificado no válido',
      },
      update: { consecutiveFailures: 6, lastError: 'SOAP fault: certificado no válido' },
    });

    const body = await health();
    const row = rowOf(body, stuck.tenantId);
    expect(row).toMatchObject({
      unsentRecords: 1,
      unsentLastError: 'SOAP fault: certificado no válido',
      verifactuEnabled: true,
    });
    expect(row.unsentSince).not.toBeNull();
    expect(row.issues).toBeGreaterThanOrEqual(1);
    const inv = body.invoices.find((i: { invoiceId: string }) => i.invoiceId === stuck.invoiceId);
    expect(inv).toMatchObject({ unsent: true, aeatStatus: 'pending' });
    expect(inv.message).toContain('SOAP fault');
    expect(body.invoicesTotal).toBeGreaterThanOrEqual(body.invoices.length);
    const today = await http().get('/admin/today').set(adminAuth).expect(200);
    expect(
      today.body.aeatIssues.some((t: { tenantId: string }) => t.tenantId === stuck.tenantId),
    ).toBe(true);

    // Un emisor que falla de forma repetida cuenta aunque el registro sea reciente.
    const fresh = await tenantWithInvoice('bdrfail');
    await admin.verifactuRecord.updateMany({
      where: { invoiceId: fresh.invoiceId },
      data: { status: 'pending', sentAt: null },
    });
    await admin.invoice.update({
      where: { id: fresh.invoiceId },
      data: { aeatStatus: 'pending', aeatSentAt: null },
    });
    await admin.verifactuEmitter.upsert({
      where: { tenantId_emitterKey: { tenantId: fresh.tenantId, emitterKey: 'self' } },
      create: {
        tenantId: fresh.tenantId,
        emitterKey: 'self',
        consecutiveFailures: 4,
        lastError: 'timeout',
      },
      update: { consecutiveFailures: 4, lastError: 'timeout' },
    });
    expect(rowOf(await health(), fresh.tenantId)).toMatchObject({ unsentRecords: 1 });

    // F2: aceptada con errores.
    const warn = await tenantWithInvoice('bdrwarn');
    await admin.invoice.update({
      where: { id: warn.invoiceId },
      data: { aeatStatus: 'accepted_with_warnings' },
    });
    const warnBody = await health();
    expect(rowOf(warnBody, warn.tenantId)).toMatchObject({ aeatWarnings: 1 });
    expect(
      warnBody.invoices.find((i: { invoiceId: string }) => i.invoiceId === warn.invoiceId),
    ).toMatchObject({ aeatStatus: 'accepted_with_warnings' });
    expect(
      (await http().get('/admin/today').set(adminAuth)).body.aeatIssues.some(
        (t: { tenantId: string }) => t.tenantId === warn.tenantId,
      ),
    ).toBe(true);

    // F3: envío entero fallido, y deja de salir si uno posterior fue correcto.
    const sub = await tenantWithInvoice('bdrsub');
    const failedAt = new Date();
    await admin.verifactuSubmission.create({
      data: {
        tenantId: sub.tenantId,
        emitterTaxId: 'B12345674',
        mode: 'sandbox',
        status: 'rejected',
        recordCount: 1,
        message: 'Cabecera no válida',
        sentAt: failedAt,
      },
    });
    expect(rowOf(await health(), sub.tenantId)).toMatchObject({
      failedSubmissions: 1,
      lastSubmissionError: 'Cabecera no válida',
    });
    await admin.verifactuSubmission.create({
      data: {
        tenantId: sub.tenantId,
        emitterTaxId: 'B12345674',
        mode: 'sandbox',
        status: 'accepted',
        recordCount: 1,
        sentAt: new Date(Date.now() + 60_000),
      },
    });
    const after = rowOf(await health(), sub.tenantId);
    expect(after.failedSubmissions).toBe(0);
    expect(after.lastSentAt).not.toBeNull();
  });

  it('F4/F5/F8 y decisión 3: certificados, tenants excluidos y Holded', async () => {
    const t = await tenantWithInvoice('bdrcert');
    const ownerUser = await admin.user.findFirstOrThrow({
      where: { tenantId: t.tenantId, role: 'owner' },
      select: { id: true },
    });
    const real = withConfig({ AEAT_MODE: 'sandbox' });
    try {
      // Sin certificado y con envío real → problema.
      let body = await health();
      expect(body.aeatMode).toBe('sandbox');
      expect(rowOf(body, t.tenantId)).toMatchObject({ certificateMissing: true });
      expect(
        (await http().get('/admin/today').set(adminAuth)).body.aeatIssues.some(
          (x: { tenantId: string }) => x.tenantId === t.tenantId,
        ),
      ).toBe(true);

      // Certificado de un propietario que caduca: se nombra.
      const owner = await admin.owner.create({
        data: {
          tenantId: t.tenantId,
          legalName: 'Inmuebles Norte SL',
          taxId: `B${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        },
      });
      await admin.tenantAeatCredential.create({
        data: {
          tenantId: t.tenantId,
          ownerId: owner.id,
          certP12Encrypted: Buffer.from('x'),
          certPasswordEncrypted: 'x',
          certCommonName: 'TEST',
          certNif: 'B12345674',
          certIssuer: 'CN=FNMT',
          certValidFrom: new Date(Date.now() - 300 * DAY),
          certValidTo: new Date(Date.now() + 5 * DAY),
          uploadedById: ownerUser.id,
        },
      });
      body = await health();
      expect(rowOf(body, t.tenantId).ownerCertificates).toEqual([
        expect.objectContaining({ ownerName: 'Inmuebles Norte SL', daysLeft: 5 }),
      ]);
      let today = await http().get('/admin/today').set(adminAuth);
      expect(
        today.body.certificatesExpiring.some(
          (c: { tenantId: string; ownerName: string | null }) =>
            c.tenantId === t.tenantId && c.ownerName === 'Inmuebles Norte SL',
        ),
      ).toBe(true);

      // Decisión 3: emitiendo en Holded, el certificado no cuenta.
      await admin.tenant.update({ where: { id: t.tenantId }, data: { invoicingMode: 'holded' } });
      body = await health();
      expect(rowOf(body, t.tenantId)).toMatchObject({ certificateMissing: false });
      expect(rowOf(body, t.tenantId).ownerCertificates).toEqual([]);
      today = await http().get('/admin/today').set(adminAuth);
      expect(
        today.body.certificatesExpiring.some(
          (c: { tenantId: string }) => c.tenantId === t.tenantId,
        ),
      ).toBe(false);
      expect(
        today.body.aeatIssues.some((x: { tenantId: string }) => x.tenantId === t.tenantId),
      ).toBe(false);
    } finally {
      real.mockRestore();
    }

    // F8: con Veri*Factu activo y sano sale la fila aunque no haya problemas.
    const ok = await tenantWithInvoice('bdrhealthy');
    const okRow = rowOf(await health(), ok.tenantId);
    expect(okRow).toMatchObject({ issues: 0, verifactuEnabled: true });

    // F5: tenants borrados, cancelados o con Veri*Factu apagado no cuentan.
    const bad = await tenantWithInvoice('bdrgone');
    await admin.invoice.update({ where: { id: bad.invoiceId }, data: { aeatStatus: 'rejected' } });
    expect(rowOf(await health(), bad.tenantId)).toMatchObject({ aeatRejected: 1 });
    await admin.tenant.update({ where: { id: bad.tenantId }, data: { status: 'cancelled' } });
    let b = await health();
    expect(rowOf(b, bad.tenantId)).toBeUndefined();
    expect(b.invoices.some((i: { invoiceId: string }) => i.invoiceId === bad.invoiceId)).toBe(
      false,
    );
    await admin.tenant.update({
      where: { id: bad.tenantId },
      data: { status: 'active', verifactuEnabled: false },
    });
    b = await health();
    expect(b.invoices.some((i: { invoiceId: string }) => i.invoiceId === bad.invoiceId)).toBe(
      false,
    );
  });

  it('F6: reenviar exige motivo y queda en el registro de acciones', async () => {
    const t = await tenantWithInvoice('bdrresend');
    await admin.verifactuRecord.updateMany({
      where: { invoiceId: t.invoiceId },
      data: { status: 'error' },
    });
    await admin.invoice.update({ where: { id: t.invoiceId }, data: { aeatStatus: 'error' } });
    const url = `/admin/billing-health/invoices/${t.invoiceId}/resend-aeat`;
    await http().post(url).set(adminAuth).send({}).expect(400);
    await http().post(url).set(adminAuth).send({ reason: 'ab' }).expect(400);
    await http()
      .post(url)
      .set(adminAuth)
      .send({ reason: 'Corregido el NIF del cliente' })
      .expect(200);
    const log = await admin.superAdminAuditLog.findFirst({
      where: { action: 'admin.invoice.aeat_resent', targetTenantId: t.tenantId },
      orderBy: { occurredAt: 'desc' },
    });
    expect((log?.changes as { reason?: string } | null)?.reason).toBe(
      'Corregido el NIF del cliente',
    );
  });

  // ------------------------------------------------------------------ dominios

  async function tenantWithDomain(prefix: string, domain: string, plan = 'pro') {
    const owner = await registerVerifiedUser(app, prefix);
    await setTenantPlan(owner.slug, plan);
    await http()
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ customDomain: domain })
      .expect(200);
    return owner;
  }
  const verify = (tenantId: string, body: object = {}) =>
    http().post(`/admin/tenants/${tenantId}/custom-domain/verify`).set(adminAuth).send(body);
  const listRow = async (tenantId: string) =>
    (
      (await http().get('/admin/tenants/custom-domains').set(adminAuth).expect(200)).body as {
        tenantId: string;
        [k: string]: unknown;
      }[]
    ).find((d) => d.tenantId === tenantId)!;

  it('D2/D6: activar se bloquea sin DNS o sin plan, con «activar igualmente» y avisos', async () => {
    const dead = deadDomain();
    const owner = await tenantWithDomain('bdrdead', dead);
    const blocked = await verify(owner.tenantId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('custom_domain_not_ready');
    expect(blocked.body.details.featureMissing).toBe(false);
    expect(blocked.body.details.hosts[0]).toMatchObject({
      purpose: 'primary',
      pointsToPlatform: false,
    });

    // Plan sin la función: bloquea aunque el DNS apunte.
    const ready = readyDomain();
    const noPlan = await tenantWithDomain('bdrnoplan', ready);
    await setTenantPlan(noPlan.slug, 'starter');
    const noFeature = await verify(noPlan.tenantId);
    expect(noFeature.status).toBe(409);
    expect(noFeature.body.details.featureMissing).toBe(true);

    // Con DNS y plan: se activa y el tenant recibe un aviso.
    const ok = await tenantWithDomain('bdrok', readyDomain());
    const activated = await verify(ok.tenantId).expect(200);
    expect(activated.body.verifiedAt).not.toBeNull();
    expect(activated.body.activatedByName).toBe('Admin BDR');
    expect(activated.body.pausedByPlan).toBe(false);
    const notices = await admin.notification.findMany({
      where: { tenantId: ok.tenantId, type: 'custom_domain.activated' },
    });
    expect(notices).toHaveLength(1);

    // Activar igualmente (solo con `force`).
    const forced = await verify(owner.tenantId, { force: true }).expect(200);
    expect(forced.body.verifiedAt).not.toBeNull();
    const audit = await admin.auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'admin.tenant.custom_domain_verified' },
    });
    expect((audit?.changes as { forced?: boolean }).forced).toBe(true);

    // Desactivar avisa al tenant.
    await http()
      .post(`/admin/tenants/${ok.tenantId}/custom-domain/revoke`)
      .set(adminAuth)
      .expect(200);
    expect(
      await admin.notification.count({
        where: { tenantId: ok.tenantId, type: 'custom_domain.deactivated' },
      }),
    ).toBe(1);

    // El rol soporte no activa (403).
    await http()
      .post(`/admin/tenants/${owner.tenantId}/custom-domain/verify`)
      .send({ force: true })
      .expect(401);
  });

  it('D1: sin la función en el plan, el dominio queda en pausa y los enlaces vuelven a la plataforma', async () => {
    const domain = readyDomain();
    const owner = await tenantWithDomain('bdrpause', domain);
    await verify(owner.tenantId).expect(200);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, { email: 'pause@e2e.local' });
    const link = async () =>
      (await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201)).body
        .url as string;

    expect(await link()).toContain(`https://${domain}/`);

    // Baja de plan desde el panel: se pausa al momento.
    await http()
      .post(`/admin/tenants/${owner.tenantId}/change-plan`)
      .set(adminAuth)
      .send({ planSlug: 'starter', reason: 'prueba de pausa' })
      .expect(200);
    const paused = await listRow(owner.tenantId);
    expect(paused).toMatchObject({ pausedByPlan: true, verifiedAt: null, featureEnabled: false });
    expect(paused.activatedAt).not.toBeNull();
    expect(await link()).not.toContain(domain);
    await http().get('/public/landing/resolve-domain').query({ host: domain }).expect(404);
    const branding = await http().get('/settings/tenant/branding').set(auth).expect(200);
    expect(branding.body).toMatchObject({ customDomainPaused: true, customDomainVerifiedAt: null });

    // Al recuperar la función (cortesía del super admin), vuelve sola.
    await setTenantFeatureOverride(owner.slug, 'custom_domain', true);
    await http()
      .put(`/admin/tenants/${owner.tenantId}/features`)
      .set(adminAuth)
      .send({ overrides: [{ feature: 'custom_domain', enabled: true }] })
      .expect(200);
    const back = await listRow(owner.tenantId);
    expect(back).toMatchObject({ pausedByPlan: false });
    expect(back.verifiedAt).not.toBeNull();
    expect(await link()).toContain(`https://${domain}/`);

    // La tarea de repaso también lo deja bien (idempotente).
    const result = await app.get(CustomDomainCheckService).syncWithPlans();
    expect(result.paused).not.toContain(owner.tenantId);
  });

  it('D3/D5: vigila los dominios activos y limpia «DNS listo» si deja de apuntar', async () => {
    const svc = app.get(CustomDomainCheckService);
    // Activo cuyo DNS ya no apunta: aviso una sola vez.
    const domain = deadDomain();
    const owner = await tenantWithDomain('bdrwatch', domain);
    await verify(owner.tenantId, { force: true }).expect(200);
    const row = await listRow(owner.tenantId);
    expect(row.checkOk).toBe(false);
    expect(row.checkIssue).toBe('dns');
    const count = () =>
      admin.superAdminNotification.count({
        where: { type: 'custom_domain.broken', title: { contains: domain } },
      });
    expect(await count()).toBe(1);
    await svc.checkActive();
    await svc.checkActive();
    expect(await count()).toBe(1);

    // Vuelve a apuntar: queda «Responde» y un nuevo fallo avisaría otra vez.
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: { customDomain: readyDomain() },
    });
    await svc.checkActive();
    expect((await listRow(owner.tenantId)).checkOk).toBe(true);

    // D5: «DNS listo desde…» se limpia si deja de apuntar antes de activarse.
    const pending = await tenantWithDomain('bdrready', readyDomain());
    await http()
      .post(`/admin/tenants/${pending.tenantId}/custom-domain/check`)
      .set(adminAuth)
      .expect(200);
    expect((await listRow(pending.tenantId)).dnsReadyAt).not.toBeNull();
    await admin.tenant.update({
      where: { id: pending.tenantId },
      data: { customDomain: deadDomain() },
    });
    const res = await http()
      .post(`/admin/tenants/${pending.tenantId}/custom-domain/check`)
      .set(adminAuth)
      .expect(200);
    expect(res.body.pointsToPlatform).toBe(false);
    expect(res.body.hosts.length).toBeGreaterThanOrEqual(1);
    expect(res.body.readyAt).toBeNull();
    expect((await listRow(pending.tenantId)).dnsReadyAt).toBeNull();
  });

  it('D6/D7: quitar el dominio avisa al super admin y la lista trae estado del tenant', async () => {
    const domain = readyDomain();
    const owner = await tenantWithDomain('bdrremove', domain);
    await verify(owner.tenantId).expect(200);
    await admin.tenant.update({ where: { id: owner.tenantId }, data: { status: 'suspended' } });
    const row = await listRow(owner.tenantId);
    expect(row).toMatchObject({ tenantStatus: 'suspended', tenantName: expect.any(String) });
    await admin.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });

    await http()
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ customDomain: '' })
      .expect(200);
    const notice = await admin.superAdminNotification.findFirst({
      where: { type: 'custom_domain.removed', title: { contains: domain } },
    });
    expect(notice).not.toBeNull();
    expect(notice!.body).toContain('Proxy Host');
    const after = await admin.tenant.findUniqueOrThrow({
      where: { id: owner.tenantId },
      select: {
        customDomain: true,
        customDomainVerifiedAt: true,
        customDomainPausedVerifiedAt: true,
        customDomainCheckOk: true,
      },
    });
    expect(after).toEqual({
      customDomain: null,
      customDomainVerifiedAt: null,
      customDomainPausedVerifiedAt: null,
      customDomainCheckOk: null,
    });
  });
});
