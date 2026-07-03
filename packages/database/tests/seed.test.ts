import { afterAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/prisma-client';

const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('seed dev', () => {
  it('deja los 3 planes esperados', async () => {
    const slugs = (
      await prisma.subscriptionPlan.findMany({ orderBy: { priceMonthly: 'asc' } })
    ).map((p) => p.slug);
    expect(slugs).toEqual(['free', 'starter', 'pro']);
  });

  it('siembra el catálogo de add-ons (uno por feature premium)', async () => {
    const addons = await prisma.subscriptionAddon.findMany();
    // 9 features premium → 9 add-ons; cada uno con feature y precio > 0.
    expect(addons.length).toBeGreaterThanOrEqual(9);
    const withFeature = addons.filter((a) => a.feature);
    expect(withFeature.length).toBeGreaterThanOrEqual(9);
    for (const a of withFeature) {
      expect(Number(a.priceMonthly)).toBeGreaterThan(0);
    }
    // El del dominio propio existe y apunta a custom_domain.
    const domain = addons.find((a) => a.feature === 'custom_domain');
    expect(domain).toBeTruthy();
  });

  it('deja el tenant demo con su suscripcion trial al plan starter', async () => {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: 'demo-storage' },
      include: { subscription: { include: { plan: true } } },
    });
    expect(tenant).not.toBeNull();
    expect(tenant?.status).toBe('trial');
    expect(tenant?.subscription?.status).toBe('trial');
    expect(tenant?.subscription?.plan.slug).toBe('starter');
  });

  it('deja un owner con role=owner', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { slug: 'demo-storage' } });
    if (!tenant) throw new Error('tenant demo no encontrado');
    const owner = await prisma.user.findFirst({
      where: { tenantId: tenant.id, role: 'owner' },
    });
    expect(owner).not.toBeNull();
    expect(owner?.email).toBe(process.env.DEMO_OWNER_EMAIL ?? 'jota@storageos.local');
  });
});
