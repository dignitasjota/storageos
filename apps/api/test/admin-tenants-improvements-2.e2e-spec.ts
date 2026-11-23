import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AdminTenantLifecycleService } from '../src/modules/admin/admin-tenant-lifecycle.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-tenants-improvements-2@storageos.local';
const SUPPORT_EMAIL = 'admin-tenants-improvements-2-support@storageos.local';
const DAY = 86_400_000;

describe('Admin: mejoras del apartado Tenants (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let supportToken: string;
  let adminId: string;
  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${token}` });
  const support = () => ({ Authorization: `Bearer ${supportToken}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    const passwordHash = await argonHash('AdminTest!23');
    adminId = (
      await db.superAdmin.create({
        data: { email: ADMIN_EMAIL, passwordHash, fullName: 'Admin Mejoras', role: 'superadmin' },
      })
    ).id;
    await db.superAdmin.create({
      data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Mejoras', role: 'support' },
    });
    app = await createTestApp();
    token = (
      await http().post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: 'AdminTest!23' })
    ).body.accessToken as string;
    supportToken = (
      await http()
        .post('/admin/auth/login')
        .send({ email: SUPPORT_EMAIL, password: 'AdminTest!23' })
    ).body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await db.tenantDataExport.deleteMany({ where: { superAdminId: adminId } });
    await db.subscriptionAddon.deleteMany({ where: { slug: { startsWith: 'imp2-addon-' } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  /** Cliente que ya paga: activo, en pago manual, periodo pagado de un mes por delante. */
  async function paying(prefix: string): Promise<VerifiedUser> {
    const t = await registerVerifiedUser(app, prefix);
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    await db.tenantSubscription.update({
      where: { tenantId: t.tenantId },
      data: {
        status: 'active',
        billingMode: 'manual',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      },
    });
    return t;
  }

  async function addManager(tenantId: string, email: string) {
    return db.user.create({
      data: {
        tenantId,
        email,
        passwordHash: await argonHash('Secret123'),
        fullName: 'Gestora Ana',
        role: 'manager',
        emailVerifiedAt: new Date(),
      },
    });
  }

  it('dar de baja: vista previa, programada al fin del periodo, deshacer y aplicar', async () => {
    const t = await paying('impcancel');
    const preview = await http()
      .get(`/admin/tenants/${t.tenantId}/subscription-preview?action=cancel&effective=period_end`)
      .set(admin())
      .expect(200);
    expect(preview.body.before.nextCharge).not.toBeNull();
    expect(preview.body.after.nextCharge).toBeNull();
    expect(preview.body.after.tenantStatus).toBe('active');
    expect(preview.body.effects.join(' ')).toMatch(/dado de baja/);

    await http()
      .post(`/admin/tenants/${t.tenantId}/cancel`)
      .set(support())
      .send({ churnReason: 'price', reason: 'Se va', effective: 'now' })
      .expect(403);
    const scheduled = await http()
      .post(`/admin/tenants/${t.tenantId}/cancel`)
      .set(admin())
      .send({ churnReason: 'price', reason: 'Se va a la competencia', effective: 'period_end' })
      .expect(200);
    expect(scheduled.body.status).toBe('active');
    expect(scheduled.body.cancelScheduledAt).not.toBeNull();
    expect(scheduled.body.cancelScheduledReason).toBe('price');

    await http()
      .post(`/admin/tenants/${t.tenantId}/cancel/undo`)
      .set(admin())
      .send({ reason: 'Se queda' })
      .expect(200);
    const undone = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(undone.cancelScheduledAt).toBeNull();
    expect(undone.status).toBe('active');

    await http()
      .post(`/admin/tenants/${t.tenantId}/cancel`)
      .set(admin())
      .send({ churnReason: 'competitor', reason: 'Ahora sí', effective: 'period_end' })
      .expect(200);
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { cancelScheduledAt: new Date(Date.now() - DAY) },
    });
    const applied = await app.get(AdminTenantLifecycleService).applyDueCancellations();
    expect(applied).toBeGreaterThanOrEqual(1);
    const after = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(after.status).toBe('cancelled');
    expect(after.churnReason).toBe('competitor');
    expect(after.canceledAt).not.toBeNull();
    expect(after.cancelScheduledAt).toBeNull();

    // Sale en la lista con su fecha y motivo de baja.
    const overview = await http().get('/admin/tenants-overview').set(admin()).expect(200);
    const row = (overview.body as { id: string; churnReason: string; canceledAt: string }[]).find(
      (r) => r.id === t.tenantId,
    );
    expect(row?.churnReason).toBe('competitor');
    expect(row?.canceledAt).toBeTruthy();

    await http()
      .post(`/admin/tenants/${t.tenantId}/cancel`)
      .set(admin())
      .send({ churnReason: 'price', reason: 'Otra vez', effective: 'now' })
      .expect(400);
  });

  it('vista previa de otras acciones y de un dato no válido', async () => {
    const t = await registerVerifiedUser(app, 'imppreview');
    const plan = await http()
      .get(`/admin/tenants/${t.tenantId}/subscription-preview?action=change_plan&planSlug=pro`)
      .set(admin())
      .expect(200);
    expect(plan.body.after.planName).not.toBe(plan.body.before.planName);
    expect(plan.body.after.tenantStatus).toBe('active');
    const extend = await http()
      .get(`/admin/tenants/${t.tenantId}/subscription-preview?action=extend_trial&days=10`)
      .set(admin())
      .expect(200);
    expect(new Date(extend.body.after.trialEndsAt).getTime()).toBeGreaterThan(
      new Date(extend.body.before.trialEndsAt).getTime(),
    );
    await http()
      .get(`/admin/tenants/${t.tenantId}/subscription-preview?action=nada`)
      .set(admin())
      .expect(400);
  });

  it('anular un pago a mano deshace el periodo y vuelve a pago pendiente si ya venció', async () => {
    const t = await paying('impvoid');
    const overdueEnd = new Date(Date.now() - 5 * DAY);
    await db.tenantSubscription.update({
      where: { tenantId: t.tenantId },
      data: { currentPeriodEnd: overdueEnd },
    });
    const paid = await http()
      .post(`/admin/tenants/${t.tenantId}/saas-payments/manual`)
      .set(admin())
      .send({ provider: 'bank_transfer', amount: 49, durationMonths: 1 })
      .expect(201);
    expect(paid.body.voidable).toBe(true);
    const mid = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(mid.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

    const voided = await http()
      .post(`/admin/tenants/${t.tenantId}/saas-payments/${paid.body.id}/void`)
      .set(admin())
      .send({ reason: 'Registrado por error' })
      .expect(200);
    expect(voided.body.status).toBe('voided');
    expect(voided.body.voidable).toBe(false);
    const sub = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(Math.abs(sub.currentPeriodEnd.getTime() - overdueEnd.getTime())).toBeLessThan(1000);
    expect(sub.status).toBe('past_due');
    await http()
      .post(`/admin/tenants/${t.tenantId}/saas-payments/${paid.body.id}/void`)
      .set(admin())
      .send({ reason: 'Otra vez' })
      .expect(400);
  });

  it('editar un extra asignado y cobrarlo desde la ficha', async () => {
    const t = await paying('impaddon');
    const slug = `imp2-addon-${Date.now()}`;
    const addon = await http()
      .post('/admin/addons')
      .set(admin())
      .send({ slug, name: 'Extra de prueba', priceMonthly: 5 })
      .expect(201)
      .then((r) => r.body as { id: string });
    const summary = await http()
      .post(`/admin/tenants/${t.tenantId}/addons`)
      .set(admin())
      .send({ addonId: addon.id })
      .expect(201);
    const assignment = (summary.body.addons as { id: string; addonId: string }[]).find(
      (a) => a.addonId === addon.id,
    )!;
    const next = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    await http()
      .patch(`/admin/tenants/${t.tenantId}/addons/${assignment.id}`)
      .set(admin())
      .send({ quantity: 2, priceMonthly: 7, notes: 'Precio de lanzamiento', nextChargeAt: next })
      .expect(200);
    const row = await db.tenantSubscriptionAddon.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(row.quantity).toBe(2);
    expect(Number(row.priceMonthly)).toBe(7);
    expect(row.notes).toBe('Precio de lanzamiento');
    expect(row.nextChargeAt?.toISOString().slice(0, 10)).toBe(next);

    await http()
      .post(`/admin/tenants/${t.tenantId}/addons/${assignment.id}/charge-now`)
      .set(admin())
      .send({ provider: 'cash' })
      .expect(200);
    const charged = await db.tenantSubscriptionAddon.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(charged.nextChargeAt!.getTime()).toBeGreaterThan(row.nextChargeAt!.getTime());
    const payment = await db.tenantSubscriptionPayment.findFirst({
      where: { tenantId: t.tenantId, description: { startsWith: 'Add-on:' } },
    });
    expect(payment).not.toBeNull();
    expect(payment!.extendedPeriod).toBe(false);
  });

  it('avisa de incoherencias y las corrige', async () => {
    const t = await registerVerifiedUser(app, 'impcons');
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { trialEndsAt: new Date(Date.now() - 2 * DAY) },
    });
    const first = await http()
      .get(`/admin/tenants/${t.tenantId}/consistency`)
      .set(admin())
      .expect(200);
    const codes = (first.body.issues as { code: string }[]).map((i) => i.code);
    expect(codes).toContain('trial_expired');
    const fixed = await http()
      .post(`/admin/tenants/${t.tenantId}/consistency/trial_expired/fix`)
      .set(admin())
      .expect(200);
    expect((fixed.body.issues as { code: string }[]).map((i) => i.code)).not.toContain(
      'trial_expired',
    );
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).status).toBe(
      'active',
    );

    await db.tenant.update({ where: { id: t.tenantId }, data: { billingExempt: true } });
    await db.tenantSubscription.update({
      where: { tenantId: t.tenantId },
      data: { billingMode: 'sepa' },
    });
    const second = await http()
      .get(`/admin/tenants/${t.tenantId}/consistency`)
      .set(admin())
      .expect(200);
    expect((second.body.issues as { code: string }[]).map((i) => i.code)).toContain(
      'exempt_with_autocharge',
    );
    await http()
      .post(`/admin/tenants/${t.tenantId}/consistency/exempt_with_autocharge/fix`)
      .set(support())
      .expect(403);
    await http()
      .post(`/admin/tenants/${t.tenantId}/consistency/exempt_with_autocharge/fix`)
      .set(admin())
      .expect(200);
    const sub = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.billingMode).toBe('manual');
    await http()
      .post(`/admin/tenants/${t.tenantId}/consistency/exempt_with_autocharge/fix`)
      .set(admin())
      .expect(409);
  });

  it('anonimizar con periodo de gracia: se da de baja, se cancela y se ejecuta', async () => {
    const t = await paying('impanon');
    const res = await http()
      .post(`/admin/tenants/${t.tenantId}/anonymize`)
      .set(admin())
      .send({ reason: 'Baja RGPD', exported: true, graceDays: 30, churnReason: 'business_closure' })
      .expect(200);
    expect(res.body.scheduledFor).not.toBeNull();
    const scheduled = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(scheduled.status).toBe('cancelled');
    expect(scheduled.churnReason).toBe('business_closure');
    expect(scheduled.deletedAt).toBeNull();
    expect(scheduled.anonymizeScheduledAt!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);

    await http()
      .delete(`/admin/tenants/${t.tenantId}/anonymize-schedule`)
      .set(admin())
      .send({ reason: 'Lo pensamos mejor' })
      .expect(200);
    expect(
      (await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).anonymizeScheduledAt,
    ).toBeNull();

    await http()
      .post(`/admin/tenants/${t.tenantId}/anonymize`)
      .set(admin())
      .send({ reason: 'Baja RGPD', exported: true, graceDays: 5 })
      .expect(200);
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { anonymizeScheduledAt: new Date(Date.now() - DAY) },
    });
    const done = await app.get(AdminTenantLifecycleService).runDueAnonymizations();
    expect(done).toBeGreaterThanOrEqual(1);
    const anonymized = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(anonymized.deletedAt).not.toBeNull();
    expect(anonymized.anonymizeScheduledAt).toBeNull();

    // La ficha se sigue viendo, con lo que queda.
    const detail = await http().get(`/admin/tenants/${t.tenantId}`).set(admin()).expect(200);
    expect(detail.body.anonymizedAt).not.toBeNull();
    const overview = await http().get('/admin/tenants-overview').set(admin()).expect(200);
    expect(
      (overview.body as { id: string; anonymized: boolean }[]).find((r) => r.id === t.tenantId)
        ?.anonymized,
    ).toBe(true);
  });

  it('cambia el email de un usuario y traspasa la propiedad', async () => {
    const t = await registerVerifiedUser(app, 'impusers');
    const manager = await addManager(t.tenantId, `gestora-${Date.now()}@e2e.local`);
    await http()
      .post(`/admin/tenants/${t.tenantId}/users/${manager.id}/change-email`)
      .set(admin())
      .send({ email: t.email, reason: 'Pide cambiarlo' })
      .expect(400);
    const newEmail = `nueva-${Date.now()}@e2e.local`;
    await http()
      .post(`/admin/tenants/${t.tenantId}/users/${manager.id}/change-email`)
      .set(admin())
      .send({ email: newEmail.toUpperCase(), reason: 'Cambia de correo' })
      .expect(204);
    const changed = await db.user.findUniqueOrThrow({ where: { id: manager.id } });
    expect(changed.email).toBe(newEmail);
    expect(changed.emailVerifiedAt).toBeNull();

    await http()
      .post(`/admin/tenants/${t.tenantId}/users/${manager.id}/make-owner`)
      .set(support())
      .send({ reason: 'Venta del negocio' })
      .expect(403);
    await http()
      .post(`/admin/tenants/${t.tenantId}/users/${manager.id}/make-owner`)
      .set(admin())
      .send({ reason: 'Venta del negocio' })
      .expect(204);
    const [newOwner, oldOwner] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: manager.id } }),
      db.user.findUniqueOrThrow({ where: { id: t.userId } }),
    ]);
    expect(newOwner.role).toBe('owner');
    expect(oldOwner.role).toBe('manager');
  });

  it('impersona como un usuario y corta la sesión desde la ficha', async () => {
    const t = await registerVerifiedUser(app, 'impimp');
    const manager = await addManager(t.tenantId, `gestor-imp-${Date.now()}@e2e.local`);
    const imp = await http()
      .post(`/admin/tenants/${t.tenantId}/impersonate`)
      .set(admin())
      .send({ reason: 'Ver lo que ve la gestora', userId: manager.id })
      .expect(200);
    const me = await http()
      .get('/auth/me')
      .set({ Authorization: `Bearer ${imp.body.accessToken}` })
      .expect(200);
    expect(me.body.user.id).toBe(manager.id);
    expect(me.body.user.role).toBe('manager');
    // En solo lectura no se escribe.
    await http()
      .post('/customers')
      .set({ Authorization: `Bearer ${imp.body.accessToken}` })
      .send({ customerType: 'individual', firstName: 'X', lastName: 'Y', country: 'ES' })
      .expect(403);

    const logs = await http()
      .get(`/admin/impersonation-logs?tenantId=${t.tenantId}`)
      .set(admin())
      .expect(200);
    const session = logs.body.items[0];
    expect(session.userId).toBe(manager.id);
    expect(session.userName).toContain('Gestora Ana');
    expect(session.live).toBe(true);
    await http().post(`/admin/impersonation-logs/${session.id}/revoke`).set(support()).expect(403);
    await http().post(`/admin/impersonation-logs/${session.id}/revoke`).set(admin()).expect(200);
    await http()
      .get('/auth/me')
      .set({ Authorization: `Bearer ${imp.body.accessToken}` })
      .expect(401);
  });

  it('la solicitud de aprobación avisa si el tenant cambió desde que se pidió', async () => {
    const t = await registerVerifiedUser(app, 'impappr');
    const created = await http()
      .post('/admin/approvals')
      .set(support())
      .send({
        tenantId: t.tenantId,
        reason: 'Lo pide el cliente',
        request: { action: 'extend_trial', payload: { days: 7, reason: 'Más tiempo' } },
      })
      .expect(201);
    let list = await http().get(`/admin/approvals?tenantId=${t.tenantId}`).set(admin()).expect(200);
    let row = (
      list.body as { id: string; changedSinceRequest: string[]; currentState: string }[]
    ).find((r) => r.id === created.body.id)!;
    expect(row.changedSinceRequest).toEqual([]);
    expect(row.currentState).toContain('en prueba');

    await http()
      .post(`/admin/tenants/${t.tenantId}/change-plan`)
      .set(admin())
      .send({ planSlug: 'pro', reason: 'Sube' })
      .expect(200);
    list = await http().get(`/admin/approvals?tenantId=${t.tenantId}`).set(admin()).expect(200);
    row = (list.body as { id: string; changedSinceRequest: string[]; currentState: string }[]).find(
      (r) => r.id === created.body.id,
    )!;
    expect(row.changedSinceRequest.join(' ')).toMatch(/Plan/);
  });

  it('lista: vistas con columnas y orden, y posibles duplicados del alta', async () => {
    const t = await registerVerifiedUser(app, 'impdup', { tenantName: 'Trasteros Duplicado Sol' });
    const saved = await http()
      .post('/admin/saved-views')
      .set(admin())
      .send({
        page: 'tenants',
        name: `Con columnas ${Date.now()}`,
        filters: { status: 'active' },
        columns: ['plan', 'monthly'],
        sort: { key: 'monthly', dir: -1 },
      })
      .expect(201);
    expect(saved.body.columns).toEqual(['plan', 'monthly']);
    expect(saved.body.sort).toEqual({ key: 'monthly', dir: -1 });
    await http().delete(`/admin/saved-views/${saved.body.id}`).set(admin()).expect(204);

    const dup = await http()
      .get(
        `/admin/tenant-duplicates?name=${encodeURIComponent('trasteros duplicado sol, S.L.')}&email=${encodeURIComponent(t.email)}`,
      )
      .set(admin())
      .expect(200);
    const match = (dup.body as { id: string; matches: string[] }[]).find(
      (d) => d.id === t.tenantId,
    );
    expect(match?.matches).toEqual(
      expect.arrayContaining(['Nombre parecido', 'El email ya es de un usuario suyo']),
    );
  });

  it('correo al tenant: destinatarios visibles y elegibles, solo del tenant', async () => {
    const t = await registerVerifiedUser(app, 'impmail');
    const managerEmail = `gestor-mail-${Date.now()}@e2e.local`;
    await addManager(t.tenantId, managerEmail);
    const list = await http()
      .get(`/admin/tenants/${t.tenantId}/email-recipients`)
      .set(admin())
      .expect(200);
    const rows = list.body as { email: string; defaultSelected: boolean; kind: string }[];
    expect(rows.find((r) => r.email === t.email)?.defaultSelected).toBe(true);
    expect(rows.find((r) => r.email === managerEmail)?.defaultSelected).toBe(false);

    await http()
      .post(`/admin/tenants/${t.tenantId}/email`)
      .set(admin())
      .send({
        subject: 'Hola',
        body: 'Texto',
        replyExpected: false,
        recipients: ['otro@e2e.local'],
      })
      .expect(400);
    const sent = await http()
      .post(`/admin/tenants/${t.tenantId}/email`)
      .set(admin())
      .send({ subject: 'Hola', body: 'Texto', replyExpected: false, recipients: [managerEmail] })
      .expect(200);
    expect(sent.body.recipients).toBe(1);
  });

  it('exportación en segundo plano con historial y las hojas nuevas', async () => {
    const t = await registerVerifiedUser(app, 'impexp');
    const req = await http()
      .post(`/admin/tenants/${t.tenantId}/data-export`)
      .set(admin())
      .expect(202);
    expect(req.body.status).toBe('pending');
    let row: { id: string; status: string; counts: Record<string, number> | null } | undefined;
    for (let i = 0; i < 60; i++) {
      const list = await http()
        .get(`/admin/tenants/${t.tenantId}/data-exports`)
        .set(admin())
        .expect(200);
      row = (list.body as (typeof row & object)[]).find((r) => r.id === req.body.id);
      if (row && row.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(row?.status).toBe('done');
    expect(Object.keys(row!.counts ?? {})).toEqual(
      expect.arrayContaining(['Reservas', 'Usuarios', 'Comunicaciones', 'Accesos', 'Remesas SEPA']),
    );
    expect(row!.counts!['Usuarios']).toBe(1);
    const dl = await http()
      .get(`/admin/tenants/${t.tenantId}/data-exports/${req.body.id}/download`)
      .set(admin())
      .expect(200);
    expect(dl.body.url).toMatch(/^https?:\/\//);
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'tenant.data_export', recipientId: adminId },
    });
    expect(notice).not.toBeNull();
  });

  it('historial con búsqueda, autor, fechas y una nota fijada', async () => {
    const t = await registerVerifiedUser(app, 'imptime');
    const a = await http()
      .post(`/admin/tenants/${t.tenantId}/interactions`)
      .set(admin())
      .send({ type: 'call', content: 'Hablamos del precio del zafiro' })
      .expect(201);
    await http()
      .post(`/admin/tenants/${t.tenantId}/interactions`)
      .set(admin())
      .send({ type: 'note', content: 'Otra nota sin más' })
      .expect(201);
    await http()
      .post(`/admin/tenants/${t.tenantId}/interactions/${a.body.id}/pin`)
      .set(admin())
      .send({ pinned: true })
      .expect(200);
    const first = await http()
      .get(`/admin/tenants/${t.tenantId}/timeline`)
      .set(admin())
      .expect(200);
    expect(first.body.pinned?.id).toBe(`interaction:${a.body.id}`);

    const search = await http()
      .get(`/admin/tenants/${t.tenantId}/timeline?q=ZAFIRO`)
      .set(admin())
      .expect(200);
    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].detail).toContain('zafiro');

    const byActor = await http()
      .get(`/admin/tenants/${t.tenantId}/timeline?actorId=${adminId}`)
      .set(admin())
      .expect(200);
    expect(
      (byActor.body.items as { actor: string | null }[]).every((i) => i.actor === 'Admin Mejoras'),
    ).toBe(true);
    const past = await http()
      .get(`/admin/tenants/${t.tenantId}/timeline?to=2020-01-01`)
      .set(admin())
      .expect(200);
    expect(past.body.items).toHaveLength(0);
    await http()
      .get(`/admin/tenants/${t.tenantId}/timeline?from=no-es-fecha`)
      .set(admin())
      .expect(400);
  });

  it('inquilinos y locales por páginas, con buscador, deuda, prueba y borrados', async () => {
    const t = await registerVerifiedUser(app, 'imppage');
    const c1 = await createCustomer(app, t.accessToken, {
      firstName: 'Zoila',
      email: 'zoila@e2e.local',
    });
    const c2 = await createCustomer(app, t.accessToken, { documentNumber: '12345678Z' });
    const c3 = await createCustomer(app, t.accessToken);
    await db.customer.update({ where: { id: c2 }, data: { isTest: true } });
    await db.customer.update({ where: { id: c3 }, data: { deletedAt: new Date() } });
    const invoiceId = await createDraftInvoice(app, t.accessToken, c1, { unitPrice: 100 });
    await http()
      .post(`/invoices/${invoiceId}/issue`)
      .set({ Authorization: `Bearer ${t.accessToken}` })
      .expect(200);

    const page1 = await http()
      .get(`/admin/tenants/${t.tenantId}/customers/page?limit=2`)
      .set(admin())
      .expect(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await http()
      .get(`/admin/tenants/${t.tenantId}/customers/page?limit=2&cursor=${page1.body.nextCursor}`)
      .set(admin())
      .expect(200);
    const all = [...page1.body.items, ...page2.body.items] as {
      id: string;
      isTest: boolean;
      deletedAt: string | null;
      debt: number;
      documentNumber: string | null;
    }[];
    expect(all.find((c) => c.id === c2)?.isTest).toBe(true);
    expect(all.find((c) => c.id === c3)?.deletedAt).not.toBeNull();
    expect(all.find((c) => c.id === c1)?.debt).toBe(121);

    const search = await http()
      .get(`/admin/tenants/${t.tenantId}/customers/page?search=zoila`)
      .set(admin())
      .expect(200);
    expect(search.body.items.map((c: { id: string }) => c.id)).toEqual([c1]);
    // El rol soporte ve el documento enmascarado.
    const masked = await http()
      .get(`/admin/tenants/${t.tenantId}/customers/page?search=12345678`)
      .set(support())
      .expect(200);
    expect(masked.body.items[0].documentNumber).toBe('***678Z');

    await createFacilityWithUnits(app, t.accessToken, { facilityName: 'Local Norte' });
    await createFacilityWithUnits(app, t.accessToken, { facilityName: 'Local Sur' });
    const facilities = await http()
      .get(`/admin/tenants/${t.tenantId}/facilities/page?limit=1&search=local`)
      .set(admin())
      .expect(200);
    expect(facilities.body.total).toBe(2);
    expect(facilities.body.items).toHaveLength(1);
    expect(facilities.body.nextCursor).not.toBeNull();
  });
});
