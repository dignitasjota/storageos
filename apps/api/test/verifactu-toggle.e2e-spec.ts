import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { VerifactuDispatcher } from '../src/modules/billing/verifactu-dispatcher.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  createDraftInvoice,
  ensureDefaultSeries,
  waitForAeatStatus,
} from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Año de hoy en Madrid (el bloqueo dura hasta el 31 de diciembre de ese año). */
const madridYear = () =>
  Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric' }).format());

/**
 * Veri*Factu por negocio: apagado por defecto (sin huella, QR ni envío), se
 * activa cuando le toca, su primera factura abre la cadena y no se apaga
 * hasta el 31 de diciembre.
 */
describe('Veri*Factu por negocio (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

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

  const http = () => request(app.getHttpServer());

  async function issue(token: string, customerId: string) {
    const id = await createDraftInvoice(app, token, customerId);
    const res = await http()
      .post(`/invoices/${id}/issue`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    return res.body as {
      id: string;
      hash: string | null;
      previousHash: string | null;
      qrCodeUrl: string | null;
      aeatStatus: string | null;
    };
  }

  /** Simula la configuración de la plataforma (modo de la AEAT, entorno). */
  function withConfig(values: Record<string, unknown>) {
    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    return jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string, opts?: unknown) =>
        key in values ? values[key] : original(key, opts as never)) as never);
  }

  it('apagado por defecto: la factura sale sin huella, sin QR y sin envío', async () => {
    const owner = await registerVerifiedUser(app, 'vftoff');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    const settings = await http().get('/billing/verifactu/settings').set(auth).expect(200);
    expect(settings.body).toMatchObject({
      enabled: false,
      enabledAt: null,
      lockedUntil: null,
      platformMode: 'stub',
      blockers: [],
      pendingCount: 0,
    });

    const scheduleSpy = jest.spyOn(app.get(VerifactuDispatcher), 'schedule');
    try {
      const inv = await issue(owner.accessToken, customerId);
      expect(inv).toMatchObject({ hash: null, previousHash: null, qrCodeUrl: null });
      expect(inv.aeatStatus).toBeNull();
      // No se programa ningún envío a la AEAT para este negocio.
      expect(scheduleSpy.mock.calls.filter(([tenantId]) => tenantId === owner.tenantId)).toEqual(
        [],
      );
      const row = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      expect(row.chainSeq).toBeNull();

      // No hay registro que reenviar ni consultar.
      const resend = await http()
        .post(`/billing/invoices/${inv.id}/resend-aeat`)
        .set(auth)
        .expect(400);
      expect(resend.body.code).toBe('not_a_verifactu_record');
      const refresh = await http()
        .post(`/billing/invoices/${inv.id}/refresh-aeat-status`)
        .set(auth)
        .expect(400);
      expect(refresh.body.code).toBe('not_a_verifactu_record');
    } finally {
      scheduleSpy.mockRestore();
    }

    // Configuración avisa y la puesta en marcha lo da por pendiente.
    const health = await http().get('/settings/tenant/health').set(auth).expect(200);
    expect(health.body.map((i: { key: string }) => i.key)).toContain('verifactu_off');
    const onboarding = await http().get('/dashboard/onboarding').set(auth).expect(200);
    expect(onboarding.body.steps.find((s: { key: string }) => s.key === 'verifactu')).toMatchObject(
      { done: false },
    );
  });

  it('activado: la primera factura abre la cadena; con facturas este año, la baja queda para el 31 de diciembre', async () => {
    const owner = await registerVerifiedUser(app, 'vfton');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    // Una factura emitida antes de activarlo: no entra en la cadena.
    const before = await issue(owner.accessToken, customerId);
    expect(before.hash).toBeNull();

    const on = await http()
      .put('/billing/verifactu/settings')
      .set(auth)
      .send({ enabled: true })
      .expect(200);
    // Sin ningún registro aún: se podría apagar en el momento.
    expect(on.body).toMatchObject({ enabled: true, lockedUntil: null, renuncia: null });
    expect(on.body.enabledAt).toEqual(expect.any(String));
    // Su número de instalación en la AEAT: la activación y el principio del id.
    const installed = await db.tenant.findUniqueOrThrow({
      where: { id: owner.tenantId },
      select: { verifactuInstallation: true },
    });
    expect(installed.verifactuInstallation).toBe(
      `${new Date(on.body.enabledAt as string)
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)}-${owner.tenantId.slice(0, 8)}`,
    );

    const first = await issue(owner.accessToken, customerId);
    expect(first.hash).toMatch(/^[0-9A-F]{64}$/);
    expect(first.previousHash).toBeNull(); // primer registro del emisor
    expect(first.qrCodeUrl).toMatch(/^data:image\/png/);
    expect(await waitForAeatStatus(app, owner.accessToken, first.id)).toBe('accepted');
    const second = await issue(owner.accessToken, customerId);
    expect(second.previousHash).toBe(first.hash);
    const rows = await db.invoice.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, chainSeq: true },
    });
    expect(rows.find((r) => r.id === first.id)?.chainSeq).toBe(1);
    expect(rows.find((r) => r.id === second.id)?.chainSeq).toBe(2);

    // Con facturas enviadas este año sigue hasta el 31 de diciembre (art. 17.2):
    // desactivarlo programa la baja para ese día.
    const year = madridYear();
    const scheduled = await http()
      .put('/billing/verifactu/settings')
      .set(auth)
      .send({ enabled: false })
      .expect(200);
    expect(scheduled.body).toMatchObject({
      enabled: true,
      lockedUntil: `${year}-12-31`,
      renuncia: { endDate: `${year}-12-31`, communicatedAt: null },
    });

    const health = await http().get('/settings/tenant/health').set(auth).expect(200);
    expect(health.body.map((i: { key: string }) => i.key)).not.toContain('verifactu_off');
    const onboarding = await http().get('/dashboard/onboarding').set(auth).expect(200);
    expect(onboarding.body.steps.find((s: { key: string }) => s.key === 'verifactu')).toMatchObject(
      { done: true },
    );

    // Sin facturas este año (las suyas, del año pasado): se apaga ya y las nuevas
    // salen sin huella. Antes se anula la baja programada (aún no salió).
    await http().put('/billing/verifactu/settings').set(auth).send({ enabled: true }).expect(200);
    await db.verifactuRecord.updateMany({
      where: { tenantId: owner.tenantId },
      data: { createdAt: new Date(Date.UTC(year - 1, 5, 1)) },
    });
    const off = await http()
      .put('/billing/verifactu/settings')
      .set(auth)
      .send({ enabled: false })
      .expect(200);
    expect(off.body).toMatchObject({ enabled: false, enabledAt: null, lockedUntil: null });
    expect((await issue(owner.accessToken, customerId)).hash).toBeNull();

    const audit = await db.auditLog.findMany({
      where: { tenantId: owner.tenantId, action: { startsWith: 'tenant.verifactu_' } },
      select: { action: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'tenant.verifactu_disabled',
      'tenant.verifactu_enabled',
      'tenant.verifactu_renuncia_cancelled',
      'tenant.verifactu_renuncia_scheduled',
    ]);
  });

  it('no se activa sin lo que hace falta para enviar de verdad', async () => {
    const owner = await registerVerifiedUser(app, 'vftblock');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const enable = () =>
      http().put('/billing/verifactu/settings').set(auth).send({ enabled: true });

    // En producción con la plataforma aún sin conectar a la AEAT.
    const notReady = withConfig({ AEAT_MODE: 'stub', NODE_ENV: 'production' });
    try {
      const s = await http().get('/billing/verifactu/settings').set(auth).expect(200);
      expect(s.body.blockers.map((b: { code: string }) => b.code)).toContain(
        'verifactu_platform_not_ready',
      );
      expect((await enable()).status).toBe(409);
    } finally {
      notReady.mockRestore();
    }

    // Sin los datos fiscales del negocio.
    const prev = process.env.E2E_SKIP_READINESS;
    process.env.E2E_SKIP_READINESS = 'false';
    try {
      const res = await enable();
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('issuer_fiscal_data_required');
    } finally {
      process.env.E2E_SKIP_READINESS = prev;
    }

    // Con envío real: NIF válido y un certificado vigente.
    const real = withConfig({ AEAT_MODE: 'sandbox' });
    try {
      const r1 = await enable();
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('tenant_tax_id_required');
      await db.tenant.update({ where: { id: owner.tenantId }, data: { taxId: 'B12345674' } });
      const r2 = await enable();
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe('aeat_certificate_required');
      await db.tenantAeatCredential.create({
        data: {
          tenantId: owner.tenantId,
          certP12Encrypted: Buffer.from('x'),
          certPasswordEncrypted: 'x',
          certCommonName: 'TEST',
          certNif: 'B12345674',
          certIssuer: 'TEST',
          certValidFrom: new Date(Date.now() - 86_400_000),
          certValidTo: new Date(Date.now() + 365 * 86_400_000),
          uploadedById: owner.userId,
        },
      });
      const r3 = await enable();
      expect(r3.status).toBe(200);
      expect(r3.body).toMatchObject({ enabled: true, blockers: [] });
    } finally {
      real.mockRestore();
    }
  });

  it('la reserva online solo exige un DNI válido si el negocio envía de verdad', async () => {
    const owner = await registerVerifiedUser(app, 'vftbook');
    await ensureDefaultSeries(app, owner.accessToken);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    const facility = avail.body.facilities[0];
    const body = (email: string) => ({
      facilityId: facility.id,
      unitTypeId: facility.unitTypes[0].id,
      startDate: '2026-12-01',
      customer: {
        firstName: 'Nora',
        lastName: 'Vidal',
        email,
        phone: '600111222',
        documentNumber: '12345678A', // letra incorrecta
      },
    });
    const real = withConfig({ AEAT_MODE: 'sandbox' });
    try {
      // Sin Veri*Factu activado no se envía nada: se admite.
      const ok = await http()
        .post(`/public/move-in/book/${owner.slug}`)
        .send(body(`nora.${Date.now()}@e2e.local`));
      expect(ok.status).toBe(201);
      await db.tenant.update({
        where: { id: owner.tenantId },
        data: { verifactuEnabled: true, verifactuEnabledAt: new Date() },
      });
      const bad = await http()
        .post(`/public/move-in/book/${owner.slug}`)
        .send(body(`nora2.${Date.now()}@e2e.local`));
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('invalid_tax_id');
    } finally {
      real.mockRestore();
    }
  });
});
