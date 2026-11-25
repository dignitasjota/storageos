import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { reconcileCustomDomainPause } from '../src/common/custom-domain-pause';
import { AdminDomainsOpsService } from '../src/modules/admin/admin-domains-ops.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  createDraftInvoice,
  quiesceVerifactuQueue,
  setAeatStatus,
  waitForAeatStatus,
} from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, enableVerifactu } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const SUPER_EMAIL = 'admin-bdf-super@storageos.local';
const SUPPORT_EMAIL = 'admin-bdf-support@storageos.local';
const DAY = 86_400_000;

describe('Problemas de facturación y dominios propios: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let sup: { Authorization: string };
  let supp: { Authorization: string };
  const http = () => request(app.getHttpServer());

  async function login(email: string): Promise<{ Authorization: string }> {
    const r = await http().post('/admin/auth/login').send({ email, password: 'AdminTest!23' });
    return { Authorization: `Bearer ${r.body.accessToken as string}` };
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    const passwordHash = await argonHash('AdminTest!23');
    await db.superAdmin.create({
      data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super BDF', role: 'superadmin' },
    });
    await db.superAdmin.create({
      data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte BDF', role: 'support' },
    });
    app = await createTestApp();
    sup = await login(SUPER_EMAIL);
    supp = await login(SUPPORT_EMAIL);
  });

  afterAll(async () => {
    await quiesceVerifactuQueue(app);
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  // --------------------------------------------------------- facturación

  describe('facturación', () => {
    let tenantId: string;
    let slug: string;
    let token: string;
    let ownerEmail: string;
    const ids: Record<'rejected' | 'error' | 'warnings' | 'stale' | 'unsent', string> = {
      rejected: '',
      error: '',
      warnings: '',
      stale: '',
      unsent: '',
    };

    beforeAll(async () => {
      const owner = await registerVerifiedUser(app, 'bdfbill');
      tenantId = owner.tenantId;
      slug = owner.slug;
      token = owner.accessToken;
      ownerEmail = owner.email;
      await enableVerifactu(slug);
      const customerId = await createCustomer(app, token, { email: 'bdf@e2e.local' });
      for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
        const id = await createDraftInvoice(app, token, customerId, { unitPrice: 50 });
        await http()
          .post(`/invoices/${id}/issue`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        await waitForAeatStatus(app, token, id);
        ids[key] = id;
      }
      await setAeatStatus(app, ids.rejected, 'rejected', '[1100] Valor o tipo incorrecto');
      await setAeatStatus(app, ids.error, 'error', 'aeat_server_error');
      await setAeatStatus(app, ids.warnings, 'accepted_with_warnings', '[2000] Aviso');
      // Enviada hace 3 días y sin respuesta.
      await setAeatStatus(app, ids.stale, 'pending');
      await db.invoice.update({
        where: { id: ids.stale },
        data: { aeatSentAt: new Date(Date.now() - 3 * DAY) },
      });
      // Nunca llegó a enviarse: registro pendiente de hace 3 días, con el XML guardado.
      await setAeatStatus(app, ids.unsent, 'pending');
      const rec = await db.verifactuRecord.findFirstOrThrow({ where: { invoiceId: ids.unsent } });
      await db.verifactuRecord.update({
        where: { id: rec.id },
        data: { createdAt: new Date(Date.now() - 3 * DAY), sentAt: null, xml: '<RegistroAlta/>' },
      });
      await db.invoice.update({ where: { id: ids.unsent }, data: { aeatSentAt: null } });
      await db.verifactuEmitter.upsert({
        where: { tenantId_emitterKey: { tenantId, emitterKey: 'self' } },
        create: {
          tenantId,
          emitterKey: 'self',
          consecutiveFailures: 3,
          lastError: 'ECONNRESET',
          retryAt: new Date(Date.now() + 3_600_000),
        },
        update: {
          consecutiveFailures: 3,
          lastError: 'ECONNRESET',
          retryAt: new Date(Date.now() + 3_600_000),
        },
      });
      await quiesceVerifactuQueue(app);
    });

    it('envíos atascados: desde cuándo, intentos y último error', async () => {
      const r = await http().get('/admin/billing-ops/stuck').set(supp).expect(200);
      const row = r.body.find((s: { tenantId: string }) => s.tenantId === tenantId);
      expect(row).toMatchObject({
        pendingRecords: expect.any(Number),
        consecutiveFailures: 3,
        lastError: 'ECONNRESET',
        ownerId: null,
      });
      expect(row.pendingRecords).toBeGreaterThanOrEqual(1);
      expect(row.retryAt).toBeTruthy();
    });

    it('lista de facturas con problema: tipos, filtro por tenant y páginas', async () => {
      const all = await http()
        .get(`/admin/billing-ops/issues?tenantId=${tenantId}&limit=200`)
        .set(supp)
        .expect(200);
      const byProblem = Object.fromEntries(
        all.body.items.map((i: { invoiceId: string; problem: string }) => [i.invoiceId, i.problem]),
      );
      expect(byProblem[ids.rejected]).toBe('rejected');
      expect(byProblem[ids.error]).toBe('error');
      expect(byProblem[ids.warnings]).toBe('warnings');
      expect(byProblem[ids.stale]).toBe('stale');
      expect(byProblem[ids.unsent]).toBe('unsent');
      expect(all.body.nextCursor).toBeNull();
      // Un único criterio: la lista paginada suma lo mismo que el total del resumen.
      const health = (await http().get('/admin/billing-health').set(supp).expect(200)).body;
      let total = 0;
      let cursor: string | null = null;
      do {
        const page: { body: { items: unknown[]; nextCursor: string | null } } = await http()
          .get(`/admin/billing-ops/issues?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
          .set(supp)
          .expect(200);
        total += page.body.items.length;
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(total).toBe(health.invoicesTotal);
      const rejected = all.body.items.find(
        (i: { invoiceId: string }) => i.invoiceId === ids.rejected,
      );
      expect(rejected).toMatchObject({ errorCode: '1100', tenantId });

      const only = await http()
        .get(`/admin/billing-ops/issues?tenantId=${tenantId}&type=unsent`)
        .set(supp)
        .expect(200);
      expect(only.body.items.map((i: { invoiceId: string }) => i.invoiceId)).toEqual([ids.unsent]);

      const page1 = await http()
        .get(`/admin/billing-ops/issues?tenantId=${tenantId}&limit=2`)
        .set(supp)
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toBeTruthy();
      const page2 = await http()
        .get(
          `/admin/billing-ops/issues?tenantId=${tenantId}&limit=2&cursor=${page1.body.nextCursor}`,
        )
        .set(supp)
        .expect(200);
      const seen = new Set(page1.body.items.map((i: { invoiceId: string }) => i.invoiceId));
      for (const i of page2.body.items as { invoiceId: string }[])
        expect(seen.has(i.invoiceId)).toBe(false);

      await http().get('/admin/billing-ops/issues?type=nada').set(supp).expect(400);
    });

    it('vista de Veri*Factu por tenant con contadores, modo y filtros', async () => {
      const r = await http().get(`/admin/billing-ops/tenants?search=${slug}`).set(supp).expect(200);
      const row = r.body.find((t: { tenantId: string }) => t.tenantId === tenantId);
      expect(row).toMatchObject({
        rejected: 1,
        error: 1,
        warnings: 1,
        stale: 1,
        unsent: 1,
        hasCertificate: false,
        hasProblem: true,
        mode: 'stub',
      });
      expect(row.pendingRecords).toBeGreaterThanOrEqual(1);
      const healthy = await http()
        .get(`/admin/billing-ops/tenants?problem=healthy&search=${slug}`)
        .set(supp)
        .expect(200);
      expect(healthy.body).toHaveLength(0);
      const rej = await http()
        .get(`/admin/billing-ops/tenants?problem=rejected&search=${slug}`)
        .set(supp)
        .expect(200);
      expect(rej.body).toHaveLength(1);
      await http().get('/admin/billing-ops/tenants?problem=nada').set(supp).expect(400);
    });

    it('ficha de la incidencia: mensaje, código, guía y registro; XML guardado', async () => {
      const d = await http()
        .get(`/admin/billing-ops/invoices/${ids.rejected}`)
        .set(supp)
        .expect(200);
      expect(d.body).toMatchObject({
        invoiceId: ids.rejected,
        errorCode: '1100',
        message: '[1100] Valor o tipo incorrecto',
        aeatStatus: 'rejected',
      });
      expect(d.body.guide.kind).toBe('fix');
      expect(d.body.record.hashShort).toMatch(/…$/);
      expect(d.body.records.length).toBeGreaterThanOrEqual(1);
      const xml = await http()
        .get(`/admin/billing-ops/invoices/${ids.unsent}/xml`)
        .set(supp)
        .expect(200);
      expect(xml.body.xml).toBe('<RegistroAlta/>');
      await http()
        .get('/admin/billing-ops/invoices/00000000-0000-4000-8000-000000000000')
        .set(supp)
        .expect(404);
    });

    it('aviso al tenant: vista previa, envío, historial y enfriamiento de 7 días', async () => {
      const preview = await http()
        .post('/admin/billing-ops/notices/preview')
        .set(supp)
        .send({ tenantId, kind: 'invoice_rejected', message: 'Llámanos si quieres.' })
        .expect(200);
      expect(preview.body.subject).toMatch(/rechazada/i);
      expect(preview.body.body).toContain('Llámanos si quieres.');
      expect(preview.body.recipients).toContain(ownerEmail.toLowerCase());
      expect(preview.body.cooldownUntil).toBeNull();

      // No aplica: sin envíos de Holded.
      const na = await http()
        .post('/admin/billing-ops/notices')
        .set(supp)
        .send({ tenantId, kind: 'holded_review' })
        .expect(400);
      expect(na.body.code).toBe('notice_not_applicable');

      const sent = await http()
        .post('/admin/billing-ops/notices')
        .set(supp)
        .send({ tenantId, kind: 'invoice_rejected' })
        .expect(200);
      expect(sent.body.sent).toBeGreaterThanOrEqual(1);
      const again = await http()
        .post('/admin/billing-ops/notices')
        .set(supp)
        .send({ tenantId, kind: 'invoice_rejected' })
        .expect(409);
      expect(again.body.code).toBe('notice_cooldown');
      const after = await http()
        .post('/admin/billing-ops/notices/preview')
        .set(supp)
        .send({ tenantId, kind: 'invoice_rejected' })
        .expect(200);
      expect(after.body.cooldownUntil).toBeTruthy();
      // Otro tipo de aviso sigue disponible (falta el certificado).
      await http()
        .post('/admin/billing-ops/notices')
        .set(supp)
        .send({ tenantId, kind: 'certificate_missing' })
        .expect(200);

      const hist = await http()
        .get(`/admin/tenants/${tenantId}/interactions`)
        .set(supp)
        .expect(200);
      expect(
        hist.body.some((i: { content: string }) =>
          i.content.includes('Facturas rechazadas por la AEAT'),
        ),
      ).toBe(true);
    });

    it('calendario de certificados (también de propietarios) y avisos de caducidad', async () => {
      const user = await db.user.findFirstOrThrow({ where: { tenantId, role: 'owner' } });
      const ownerRow = await db.owner.create({
        data: { tenantId, legalName: 'Propietario Calendario SL', taxId: 'B12345674' },
      });
      const mk = (ownerId: string | null, days: number) =>
        db.tenantAeatCredential.create({
          data: {
            tenantId,
            ownerId,
            certP12Encrypted: Buffer.from('x'),
            certPasswordEncrypted: 'x',
            certCommonName: 'TEST',
            certNif: 'B12345674',
            certIssuer: 'CN=FNMT',
            certValidFrom: new Date(Date.now() - 300 * DAY),
            certValidTo: new Date(Date.now() + days * DAY),
            uploadedById: user.id,
          },
        });
      await mk(null, 45);
      await mk(ownerRow.id, 20);
      const cal = await http().get('/admin/billing-ops/certificates?days=60').set(supp).expect(200);
      const mine = cal.body.filter((c: { tenantId: string }) => c.tenantId === tenantId);
      expect(mine).toHaveLength(2);
      expect(mine[0].ownerName).toBe('Propietario Calendario SL');
      expect(mine[0].daysLeft).toBeLessThanOrEqual(mine[1].daysLeft);
      // El certificado que caduca se puede avisar, indicando cuál.
      const credentialId = (
        await db.tenantAeatCredential.findFirstOrThrow({
          where: { tenantId, ownerId: ownerRow.id },
        })
      ).id;
      const prev = await http()
        .post('/admin/billing-ops/notices/preview')
        .set(supp)
        .send({ tenantId, kind: 'certificate_expiring', credentialId })
        .expect(200);
      expect(prev.body.body).toContain('Propietario Calendario SL');
      // Con certificado la vista del tenant lo enseña vigente y sin aviso de falta.
      const t = await http().get(`/admin/billing-ops/tenants?search=${slug}`).set(supp).expect(200);
      expect(t.body[0].hasCertificate).toBe(true);
      expect(t.body[0].certificateDaysLeft).toBe(45);
      // Tenant que emite en Holded: su certificado no cuenta.
      await db.tenant.update({ where: { id: tenantId }, data: { invoicingMode: 'holded' } });
      const holded = await http()
        .get('/admin/billing-ops/certificates?days=60')
        .set(supp)
        .expect(200);
      expect(holded.body.some((c: { tenantId: string }) => c.tenantId === tenantId)).toBe(false);
      await db.tenant.update({ where: { id: tenantId }, data: { invoicingMode: 'app' } });
    });

    it('otros problemas de emisión', async () => {
      await db.notification.create({
        data: {
          tenantId,
          type: 'invoice.first_invoice_failed',
          title: 'No se pudo emitir la primera factura',
          body: 'Sin serie',
        },
      });
      await db.invoiceSeries.updateMany({ where: { tenantId }, data: { isDefault: false } });
      const r = await http().get('/admin/billing-ops/other').set(supp).expect(200);
      const mine = r.body.items.filter((i: { tenantId: string }) => i.tenantId === tenantId);
      const kinds = mine.map((i: { kind: string }) => i.kind);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'first_invoice_failed',
          'no_default_series',
          'missing_fiscal_data',
        ]),
      );
      expect(mine[0].link).toContain(tenantId);
    });

    it('«Reintentar ahora» solo para el superadmin y exige algo pendiente', async () => {
      await http().post('/admin/billing-ops/stuck/retry').set(supp).send({ tenantId }).expect(403);
      const ok = await http()
        .post('/admin/billing-ops/stuck/retry')
        .set(sup)
        .send({ tenantId })
        .expect(200);
      expect(ok.body.scheduledAt).toBeTruthy();
      // El emisor ya no tiene el reintento aplazado.
      const emitter = await db.verifactuEmitter.findFirstOrThrow({ where: { tenantId } });
      expect(emitter.retryAt).toBeNull();
      await quiesceVerifactuQueue(app);
    });

    it('reenviar una factura exige superadmin y un motivo, y queda en el historial', async () => {
      // El reintento de antes ya la envía (en segundo plano): se espera y se deja otra vez con error.
      await new Promise((r) => setTimeout(r, 1500));
      await setAeatStatus(app, ids.unsent, 'error');
      await http()
        .post(`/admin/billing-ops/invoices/${ids.unsent}/resend`)
        .set(supp)
        .send({ reason: 'revisión' })
        .expect(403);
      await http()
        .post(`/admin/billing-ops/invoices/${ids.unsent}/resend`)
        .set(sup)
        .send({ reason: 'ab' })
        .expect(400);
      await http()
        .post(`/admin/billing-ops/invoices/${ids.unsent}/resend`)
        .set(sup)
        .send({ reason: 'Se cayó la conexión' })
        .expect(200);
      const hist = await http().get(`/admin/tenants/${tenantId}/interactions`).set(sup).expect(200);
      expect(
        hist.body.some((i: { content: string }) => i.content.includes('Se cayó la conexión')),
      ).toBe(true);
      const audit = await db.superAdminAuditLog.findFirst({
        where: { targetTenantId: tenantId, action: 'admin.invoice.aeat_resent' },
      });
      expect(audit).toBeTruthy();
      await quiesceVerifactuQueue(app);
    });

    it('acciones en lote: resultado por factura, reenviar solo superadmin con motivo', async () => {
      const refresh = await http()
        .post('/admin/billing-ops/invoices/batch')
        .set(supp)
        .send({
          action: 'refresh',
          invoiceIds: [ids.rejected, '00000000-0000-4000-8000-000000000000'],
        })
        .expect(200);
      expect(refresh.body.results).toHaveLength(2);
      expect(refresh.body.ok + refresh.body.failed).toBe(2);
      expect(
        refresh.body.results.find((r: { invoiceId: string }) => r.invoiceId.startsWith('0000')).ok,
      ).toBe(false);
      await http()
        .post('/admin/billing-ops/invoices/batch')
        .set(supp)
        .send({ action: 'resend', invoiceIds: [ids.rejected], reason: 'motivo' })
        .expect(403);
      await http()
        .post('/admin/billing-ops/invoices/batch')
        .set(sup)
        .send({ action: 'resend', invoiceIds: [ids.rejected] })
        .expect(400);
      await http()
        .post('/admin/billing-ops/invoices/batch')
        .set(sup)
        .send({ action: 'refresh', invoiceIds: Array.from({ length: 51 }, () => ids.rejected) })
        .expect(400);
      await quiesceVerifactuQueue(app);
    });
  });

  // ------------------------------------------------------------- dominios

  describe('dominios propios', () => {
    let tenantId: string;
    let token: string;
    const tag = Math.random().toString(36).slice(2, 7);

    beforeAll(async () => {
      const owner = await registerVerifiedUser(app, 'bdfdom');
      tenantId = owner.tenantId;
      token = owner.accessToken;
    });

    const setDomain = (domain: string | null, verified: boolean) =>
      db.tenant.update({
        where: { id: tenantId },
        data: {
          customDomain: domain,
          customDomainVerifiedAt: verified ? new Date() : null,
          customDomainReadyAt: null,
        },
      });

    it('comprobación completa: DNS de la raíz y de www, https y certificado', async () => {
      await setDomain(`ready${tag}.com`, false);
      const ok = await http().post(`/admin/domains/${tenantId}/check`).set(supp).expect(200);
      expect(ok.body).toMatchObject({
        ok: true,
        dns: { root: { ok: true }, www: { ok: true } },
        https: { ok: true, status: 200 },
        tls: { valid: true },
      });
      expect(ok.body.tls.daysLeft).toBeGreaterThan(60);
      expect(ok.body.checkedAt).toBeTruthy();

      await setDomain(`notready${tag}.com`, false);
      const bad = await http().post(`/admin/domains/${tenantId}/check`).set(supp).expect(200);
      expect(bad.body.ok).toBe(false);
      expect(bad.body.dns.root.ok).toBe(false);
      expect(bad.body.https.ok).toBe(false);
      expect(bad.body.https.error).toBeTruthy();

      await setDomain(`readybadcert${tag}.com`, false);
      const cert = await http().post(`/admin/domains/${tenantId}/check`).set(supp).expect(200);
      expect(cert.body.tls.valid).toBe(false);
      expect(cert.body.ok).toBe(false);

      await db.tenant.update({ where: { id: tenantId }, data: { customDomain: null } });
      await http().post(`/admin/domains/${tenantId}/check`).set(supp).expect(404);
    });

    it('vigilancia de los activos: avisos de caída y de certificado, una vez por hito', async () => {
      await setDomain(`readysoon${tag}.com`, true);
      await http()
        .put('/admin/domains/settings')
        .set(supp)
        .send({ notifyTenantEnabled: true })
        .expect(403);
      await http()
        .put('/admin/domains/settings')
        .set(sup)
        .send({ notifyTenantEnabled: true })
        .expect(200);

      const service = app.get(AdminDomainsOpsService);
      const before = await db.superAdminNotification.count({
        where: { type: 'custom_domain.cert_expiring', title: { contains: `readysoon${tag}` } },
      });
      expect(before).toBe(0);
      await service.checkAll({ byId: null, onlyActive: true });
      const notes = await db.superAdminNotification.findMany({
        where: { type: 'custom_domain.cert_expiring', title: { contains: `readysoon${tag}` } },
      });
      expect(notes).toHaveLength(1);
      // El correo al tenant queda reservado con su enfriamiento.
      const state = await db.$queryRaw<Array<{ kind: string }>>`
        SELECT kind FROM security_alert_states
        WHERE kind = 'custom_domain.tenant_notice.cert' AND identifier = ${tenantId}`;
      expect(state).toHaveLength(1);
      // Segunda pasada: no se repite.
      await service.checkAll({ byId: null, onlyActive: true });
      expect(
        await db.superAdminNotification.count({
          where: { type: 'custom_domain.cert_expiring', title: { contains: `readysoon${tag}` } },
        }),
      ).toBe(1);

      await setDomain(`notready${tag}.com`, true);
      await service.checkAll({ byId: null, onlyActive: true });
      const down = await db.superAdminNotification.findMany({
        where: { type: 'custom_domain.broken', title: { contains: `notready${tag}` } },
      });
      expect(down).toHaveLength(1);
      await http()
        .put('/admin/domains/settings')
        .set(sup)
        .send({ notifyTenantEnabled: false })
        .expect(200);
    });

    it('guía paso a paso y casillas guardadas por dominio', async () => {
      await setDomain(`ready${tag}.com`, false);
      const g = await http().get(`/admin/domains/${tenantId}/guide`).set(supp).expect(200);
      expect(g.body.proxyHostNames).toEqual([`ready${tag}.com`, `www.ready${tag}.com`]);
      expect(g.body.records.length).toBeGreaterThanOrEqual(1);
      expect(g.body.dnsText).toContain('203.0.113.10');
      expect(g.body.npmText).toContain('3000');
      expect(g.body.checklist).toEqual({});

      await http()
        .put(`/admin/domains/${tenantId}/checklist`)
        .set(supp)
        .send({ steps: { dns: true } })
        .expect(403);
      const saved = await http()
        .put(`/admin/domains/${tenantId}/checklist`)
        .set(sup)
        .send({ steps: { dns: true, proxy_host: true, otra: true } })
        .expect(200);
      expect(saved.body.checklist).toEqual({ dns: true, proxy_host: true });
      // Al cambiar de dominio las casillas del anterior no valen.
      await setDomain(`ready2${tag}.com`, false);
      const other = await http().get(`/admin/domains/${tenantId}/guide`).set(supp).expect(200);
      expect(other.body.checklist).toEqual({});
    });

    it('resumen: última comprobación, casillas y dominio de correo', async () => {
      await setDomain(`ready${tag}.com`, false);
      await http().post(`/admin/domains/${tenantId}/check`).set(supp).expect(200);
      await db.tenantEmailDomain.upsert({
        where: { tenantId },
        create: {
          tenantId,
          domain: `mail${tag}.com`,
          status: 'verified',
          ownershipToken: 'tok',
        },
        update: { domain: `mail${tag}.com`, status: 'verified' },
      });
      const o = await http().get('/admin/domains/overview').set(supp).expect(200);
      const row = o.body.rows.find((r: { tenantId: string }) => r.tenantId === tenantId);
      expect(row.lastCheck.ok).toBe(true);
      expect(row.emailDomain).toMatchObject({ domain: `mail${tag}.com`, verified: true });
      expect(typeof o.body.notifyTenantEnabled).toBe('boolean');
      const all = await http().post('/admin/domains/check-all').set(supp).expect(200);
      expect(all.body.checked).toBeGreaterThanOrEqual(1);
    });

    it('limpieza del Proxy Host al cambiar o quitar el dominio, con «Hecho»', async () => {
      await setDomain(`ready${tag}.com`, true);
      await http()
        .patch('/settings/tenant/branding')
        .set('Authorization', `Bearer ${token}`)
        .send({ customDomain: '' })
        .expect(200);
      const list = await http().get('/admin/domains/cleanups').set(supp).expect(200);
      const mine = list.body.filter((c: { tenantId: string }) => c.tenantId === tenantId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        domain: `ready${tag}.com`,
        reason: 'removed',
        doneAt: null,
      });
      expect(mine[0].proxyHost).toContain(`www.ready${tag}.com`);
      const note = await db.superAdminNotification.findFirst({
        where: { type: 'custom_domain.removed', title: { contains: `ready${tag}.com` } },
      });
      expect(note).toBeTruthy();
      await http().post(`/admin/domains/cleanups/${mine[0].id}/done`).set(supp).expect(403);
      const done = await http()
        .post(`/admin/domains/cleanups/${mine[0].id}/done`)
        .set(sup)
        .expect(200);
      expect(done.body.doneAt).toBeTruthy();
      const after = await http().get('/admin/domains/cleanups').set(supp).expect(200);
      expect(after.body.some((c: { id: string }) => c.id === mine[0].id)).toBe(false);
    });

    it('un dominio en pausa por plan es un estado propio: historial y sin avisos de caída', async () => {
      const dead = `notready${tag}pause.com`;
      await setDomain(dead, true);
      await db.tenant.update({
        where: { id: tenantId },
        data: { customDomainCheckOk: null, customDomainCheckIssue: null },
      });
      await db.tenantFeatureOverride.upsert({
        where: { tenantId_feature: { tenantId, feature: 'custom_domain' } },
        create: { tenantId, feature: 'custom_domain', enabled: false },
        update: { enabled: false },
      });
      expect(await reconcileCustomDomainPause(app.get(PrismaAdminService), tenantId)).toBe(
        'paused',
      );
      const row = (
        await http().get('/admin/tenants/custom-domains').set(supp).expect(200)
      ).body.find((d: { tenantId: string }) => d.tenantId === tenantId);
      expect(row).toMatchObject({ pausedByPlan: true, verifiedAt: null });

      // La comprobación completa guarda el estado de la fila, pero un dominio en pausa no avisa.
      await http().post(`/admin/domains/${tenantId}/check`).set(sup).expect(200);
      const after = await db.tenant.findUnique({ where: { id: tenantId } });
      expect(after).toMatchObject({ customDomainCheckOk: false, customDomainCheckIssue: 'dns' });
      expect(
        await db.superAdminNotification.count({
          where: { type: 'custom_domain.broken', title: { contains: dead } },
        }),
      ).toBe(0);

      const h = await http().get(`/admin/domains/${tenantId}/history`).set(supp).expect(200);
      expect(h.body.map((i: { kind: string }) => i.kind)).toContain('paused');

      // «Comprobar todos» y la vigilancia diaria incluyen los dominios en pausa.
      const all = await app.get(AdminDomainsOpsService).checkAll({ byId: null, onlyActive: true });
      expect(all.checked).toBeGreaterThanOrEqual(1);
      await db.tenantFeatureOverride.deleteMany({ where: { tenantId, feature: 'custom_domain' } });
    });

    it('historial del dominio: activaciones, comprobaciones y avisos', async () => {
      await setDomain(`ready${tag}.com`, false);
      // Activar comprueba el plan (arreglos): se le da la función por cortesía.
      await db.tenantFeatureOverride.upsert({
        where: { tenantId_feature: { tenantId, feature: 'custom_domain' } },
        create: { tenantId, feature: 'custom_domain', enabled: true },
        update: { enabled: true },
      });
      await http().post(`/admin/tenants/${tenantId}/custom-domain/verify`).set(sup).expect(200);
      await http().post(`/admin/domains/${tenantId}/check`).set(sup).expect(200);
      await http().post(`/admin/tenants/${tenantId}/custom-domain/revoke`).set(sup).expect(200);
      const h = await http().get(`/admin/domains/${tenantId}/history`).set(supp).expect(200);
      const kinds = h.body.map((i: { kind: string }) => i.kind);
      expect(kinds).toEqual(expect.arrayContaining(['activated', 'revoked', 'check']));
      const sorted = [...h.body].sort((a: { at: string }, b: { at: string }) =>
        b.at.localeCompare(a.at),
      );
      expect(h.body).toEqual(sorted);
      const check = h.body.find(
        (i: { kind: string; by: string | null }) => i.kind === 'check' && i.by,
      );
      expect(check.by).toBe('Super BDF');
    });
  });
});
