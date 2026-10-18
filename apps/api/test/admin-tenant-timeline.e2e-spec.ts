import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

interface Item {
  id: string;
  kind: string;
  title: string;
}

/** Historial unificado de un tenant en el panel admin. */
describe('Admin: historial del tenant (e2e)', () => {
  let app: INestApplication;
  let auth: Record<string, string>;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    const admin = await seedSuperAdmin('timeline');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken as string}` };
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('junta conversaciones, tickets, pagos, acciones y seguimientos; filtra y pagina', async () => {
    const owner = await registerVerifiedUser(app, 'timeline');
    const http = () => request(app.getHttpServer());
    await http()
      .post(`/admin/tenants/${owner.tenantId}/interactions`)
      .set(auth)
      .send({ type: 'call', content: 'Llamada de bienvenida' })
      .expect(201);
    await http()
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth)
      .send({ title: 'Revisar uso', dueDate: '2030-01-01' })
      .expect(201);
    await http()
      .post('/support/tickets')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ subject: 'No me llegan los correos', body: 'Hola', priority: 'normal' })
      .expect(201);
    await http()
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'bank_transfer', amount: 79, durationMonths: 1 })
      .expect(201);
    await http()
      .post(`/admin/tenants/${owner.tenantId}/suspend`)
      .set(auth)
      .send({ reason: 'Prueba de historial' })
      .expect(200);

    const all = await http().get(`/admin/tenants/${owner.tenantId}/timeline`).set(auth).expect(200);
    const kinds = new Set((all.body.items as Item[]).map((i) => i.kind));
    for (const k of ['interaction', 'followup', 'ticket', 'payment', 'admin_action']) {
      expect(kinds).toContain(k);
    }
    const suspended = (all.body.items as Item[]).find((i) => i.title === 'Tenant suspendido');
    expect(suspended).toBeDefined();
    // La llamada sale como conversación, no duplicada como acción del admin.
    expect(
      (all.body.items as Item[]).filter((i) => i.kind === 'admin_action').map((i) => i.title),
    ).not.toContain('admin.tenant.interaction_created');

    const payments = await http()
      .get(`/admin/tenants/${owner.tenantId}/timeline?kinds=payment,invoice`)
      .set(auth)
      .expect(200);
    expect(
      (payments.body.items as Item[]).every((i) => ['payment', 'invoice'].includes(i.kind)),
    ).toBe(true);
    expect(payments.body.items.length).toBeGreaterThan(0);

    // De 2 en 2: recorre todo sin repetir.
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await http()
        .get(
          `/admin/tenants/${owner.tenantId}/timeline?limit=2${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        )
        .set(auth)
        .expect(200);
      seen.push(...(res.body.items as Item[]).map((x) => x.id));
      before = res.body.nextBefore;
      if (!before) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(all.body.items.length);

    await http().get(`/admin/tenants/${owner.tenantId}/timeline?before=nope`).set(auth).expect(400);
    await http()
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000/timeline')
      .set(auth)
      .expect(404);
    await http().get(`/admin/tenants/${owner.tenantId}/timeline`).expect(401);
  });
});
