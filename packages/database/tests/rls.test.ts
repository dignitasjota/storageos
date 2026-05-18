import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/prisma-client';
import { withTenantContext } from '../src/tenant-context';

const APP_DATABASE_URL = process.env.DATABASE_URL_APP;
if (!APP_DATABASE_URL) {
  throw new Error('DATABASE_URL_APP no definido (lo prepara tests/setup.ts)');
}

// El cliente admin (storageos) bypassea RLS porque es owner de las tablas.
// Lo usamos para preparar el escenario.
const admin = createPrismaClient();

// El cliente app (storageos_app) esta sometido a RLS.
const app = createPrismaClient({ databaseUrl: APP_DATABASE_URL });

const SLUG_A = 'rls-test-tenant-a';
const SLUG_B = 'rls-test-tenant-b';

let tenantAId: string;
let tenantBId: string;

beforeAll(async () => {
  const a = await admin.tenant.upsert({
    where: { slug: SLUG_A },
    update: {},
    create: { name: 'RLS Tenant A', slug: SLUG_A },
  });
  const b = await admin.tenant.upsert({
    where: { slug: SLUG_B },
    update: {},
    create: { name: 'RLS Tenant B', slug: SLUG_B },
  });
  tenantAId = a.id;
  tenantBId = b.id;

  // Un user por tenant para que las queries devuelvan algo cuando RLS lo permita.
  await admin.user.upsert({
    where: { tenantId_email: { tenantId: a.id, email: 'a@rls.local' } },
    update: {},
    create: {
      tenantId: a.id,
      email: 'a@rls.local',
      passwordHash: 'placeholder',
      fullName: 'User A',
      role: 'staff',
    },
  });
  await admin.user.upsert({
    where: { tenantId_email: { tenantId: b.id, email: 'b@rls.local' } },
    update: {},
    create: {
      tenantId: b.id,
      email: 'b@rls.local',
      passwordHash: 'placeholder',
      fullName: 'User B',
      role: 'staff',
    },
  });
});

afterAll(async () => {
  await admin.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
  await admin.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await admin.$disconnect();
  await app.$disconnect();
});

describe('Row-Level Security', () => {
  it('sin app.current_tenant el rol app no ve filas (deny by default)', async () => {
    const tenants = await app.tenant.findMany({
      where: { slug: { in: [SLUG_A, SLUG_B] } },
    });
    const users = await app.user.findMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    });
    expect(tenants).toHaveLength(0);
    expect(users).toHaveLength(0);
  });

  it('con app.current_tenant = A el rol app solo ve datos de A', async () => {
    const visible = await withTenantContext(app, tenantAId, async (tx) => {
      const ts = await tx.tenant.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
      const us = await tx.user.findMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      return { ts, us };
    });
    expect(visible.ts.map((t) => t.slug)).toEqual([SLUG_A]);
    expect(visible.us.map((u) => u.email)).toEqual(['a@rls.local']);
  });

  it('con app.current_tenant = B el rol app solo ve datos de B', async () => {
    const visible = await withTenantContext(app, tenantBId, async (tx) => {
      const ts = await tx.tenant.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
      const us = await tx.user.findMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      return { ts, us };
    });
    expect(visible.ts.map((t) => t.slug)).toEqual([SLUG_B]);
    expect(visible.us.map((u) => u.email)).toEqual(['b@rls.local']);
  });

  it('INSERT con tenant_id ajeno al contexto falla por WITH CHECK', async () => {
    await expect(
      withTenantContext(app, tenantAId, (tx) =>
        tx.user.create({
          data: {
            tenantId: tenantBId, // tenant ajeno
            email: 'cross@rls.local',
            passwordHash: 'placeholder',
            fullName: 'Cross',
            role: 'staff',
          },
        }),
      ),
    ).rejects.toThrow();

    // Confirmamos que no se creo nada
    const leaked = await admin.user.findFirst({ where: { email: 'cross@rls.local' } });
    expect(leaked).toBeNull();
  });

  it('subscription_plans es global (no RLS) y el rol app puede consultarlo', async () => {
    const plans = await app.subscriptionPlan.findMany({ orderBy: { priceMonthly: 'asc' } });
    const slugs = plans.map((p) => p.slug);
    expect(slugs).toContain('free');
    expect(slugs).toContain('starter');
    expect(slugs).toContain('pro');
  });
});
