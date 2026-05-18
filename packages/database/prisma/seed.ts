/**
 * Seed de desarrollo para StorageOS.
 *
 * Idempotente: usa `upsert` y `count` para no duplicar datos al reejecutar.
 * Se conecta como admin (`storageos`), por lo que las politicas RLS NO
 * aplican (el owner de las tablas las bypassea).
 *
 * Datos creados:
 *   - 3 planes globales (Free, Starter, Pro).
 *   - 1 tenant demo en estado `trial` (14 dias).
 *   - 1 suscripcion del tenant al plan Starter en estado `trial`.
 *   - 1 usuario owner con password hasheado con argon2id.
 *   - 3 audit logs iniciales (solo si la tabla esta vacia para ese tenant).
 *
 * Credenciales del owner: leidas de variables de entorno con defaults para
 * dev (ver `.env.example`). Sobreescribelas en `.env` si necesitas otras.
 */
import { hash } from '@node-rs/argon2';
import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'jota@storageos.local';
const DEMO_OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? 'Jota69';
const DEMO_OWNER_NAME = process.env.DEMO_OWNER_NAME ?? 'Jota';
const DEMO_TENANT_NAME = process.env.DEMO_TENANT_NAME ?? 'Demo Storage SL';
const DEMO_TENANT_SLUG = process.env.DEMO_TENANT_SLUG ?? 'demo-storage';
const DEMO_TENANT_BILLING_EMAIL =
  process.env.DEMO_TENANT_BILLING_EMAIL ?? 'billing@demo-storage.local';

const TRIAL_DAYS = 14;

async function seedPlans() {
  const plans: Array<Prisma.SubscriptionPlanCreateInput> = [
    {
      name: 'Free',
      slug: 'free',
      priceMonthly: 0,
      priceYearly: 0,
      maxUnits: 50,
      maxFacilities: 1,
      maxUsers: 2,
      features: { support: 'community', branding: false, api: false },
    },
    {
      name: 'Starter',
      slug: 'starter',
      priceMonthly: 49,
      priceYearly: 490,
      maxUnits: 200,
      maxFacilities: 3,
      maxUsers: 10,
      features: { support: 'email', branding: false, api: false },
    },
    {
      name: 'Pro',
      slug: 'pro',
      priceMonthly: 149,
      priceYearly: 1490,
      maxUnits: null,
      maxFacilities: null,
      maxUsers: null,
      features: { support: 'priority', branding: true, api: true },
    },
  ];

  const created = await Promise.all(
    plans.map((data) =>
      prisma.subscriptionPlan.upsert({
        where: { slug: data.slug },
        update: {},
        create: data,
      }),
    ),
  );

  console.info(`  Planes: ${created.map((p) => p.slug).join(', ')}`);
  return Object.fromEntries(created.map((p) => [p.slug, p]));
}

async function seedDemoTenant(starterPlanId: string) {
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  const tenant = await prisma.tenant.upsert({
    where: { slug: DEMO_TENANT_SLUG },
    update: {},
    create: {
      name: DEMO_TENANT_NAME,
      slug: DEMO_TENANT_SLUG,
      status: 'trial',
      trialEndsAt,
      billingEmail: DEMO_TENANT_BILLING_EMAIL,
    },
  });

  const subscription = await prisma.tenantSubscription.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      planId: starterPlanId,
      status: 'trial',
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
    },
  });

  const passwordHash = await hash(DEMO_OWNER_PASSWORD);

  const owner = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: DEMO_OWNER_EMAIL } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: DEMO_OWNER_EMAIL,
      passwordHash,
      fullName: DEMO_OWNER_NAME,
      role: 'owner',
    },
  });

  console.info(`  Tenant: ${tenant.slug} (${tenant.id})`);
  console.info(`  Suscripcion: trial -> starter`);
  console.info(`  Owner: ${owner.email}`);

  return { tenant, subscription, owner };
}

async function seedAuditLogs(args: {
  tenantId: string;
  ownerId: string;
  subscriptionId: string;
  tenantName: string;
  ownerRole: string;
  planSlug: string;
}) {
  const existing = await prisma.auditLog.count({ where: { tenantId: args.tenantId } });
  if (existing > 0) {
    console.info(`  Audit logs: ${existing} ya presentes, no se anaden mas`);
    return;
  }

  await prisma.auditLog.createMany({
    data: [
      {
        tenantId: args.tenantId,
        userId: args.ownerId,
        action: 'tenant.created',
        entityType: 'Tenant',
        entityId: args.tenantId,
        changes: { name: args.tenantName },
      },
      {
        tenantId: args.tenantId,
        userId: args.ownerId,
        action: 'user.created',
        entityType: 'User',
        entityId: args.ownerId,
        changes: { role: args.ownerRole },
      },
      {
        tenantId: args.tenantId,
        userId: args.ownerId,
        action: 'subscription.started',
        entityType: 'TenantSubscription',
        entityId: args.subscriptionId,
        changes: { plan: args.planSlug, status: 'trial' },
      },
    ],
  });

  console.info('  Audit logs iniciales: 3');
}

async function main() {
  console.info('Seeding StorageOS...');

  const plans = await seedPlans();
  if (!plans.starter) {
    throw new Error('Plan "starter" no encontrado tras el upsert');
  }

  const { tenant, subscription, owner } = await seedDemoTenant(plans.starter.id);

  await seedAuditLogs({
    tenantId: tenant.id,
    ownerId: owner.id,
    subscriptionId: subscription.id,
    tenantName: tenant.name,
    ownerRole: owner.role,
    planSlug: plans.starter.slug,
  });

  console.info('\nCredenciales demo:');
  console.info(`  Email:    ${DEMO_OWNER_EMAIL}`);
  console.info(`  Password: ${DEMO_OWNER_PASSWORD}`);
  console.info(`  Tenant:   ${tenant.slug} (${tenant.id})`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('Seed error:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
