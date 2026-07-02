/**
 * Bootstrap de produccion: siembra los datos iniciales que el `pnpm db:seed`
 * crea en dev pero que NO pueden generarse en produccion (la imagen no lleva
 * `tsx` ni los fuentes TS). Es IDEMPOTENTE: se puede correr en cada deploy.
 *
 *   1. Planes de suscripcion (free/starter/pro). El registro de un tenant
 *      exige el plan `starter`; sin el, falla con "Configuracion de planes
 *      incompleta".
 *   2. Super admin inicial — SOLO si se definen las env
 *      `BOOTSTRAP_SUPERADMIN_EMAIL` y `BOOTSTRAP_SUPERADMIN_PASSWORD`. Si el
 *      admin ya existe, NO se le resetea la password (solo se reasegura
 *      role=superadmin + isActive), para no pisar un cambio manual.
 *
 * Uso:
 *   - Manual:   docker exec <api> node dist/scripts/bootstrap.js
 *   - Compose:  servicio one-shot `bootstrap` (ver docker-compose.portainer.yml)
 *
 * Conecta con el rol admin (DATABASE_ADMIN_URL, bypass RLS) para poder
 * escribir en tablas globales (subscription_plans, super_admins).
 */
import { hash as argonHash } from '@node-rs/argon2';
import { type Prisma, PrismaClient } from '@storageos/database';

const PLANS: Prisma.SubscriptionPlanCreateInput[] = [
  {
    name: 'Free',
    slug: 'free',
    priceMonthly: 0,
    priceYearly: 0,
    maxUnits: 50,
    maxFacilities: 1,
    maxUsers: 2,
    features: { support: 'community', branding: false, api: false },
    tenantFeatures: [],
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
    tenantFeatures: ['rent_increases', 'insurance', 'access_control', 'automations', 'collections'],
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
    tenantFeatures: [
      'ai_assistant',
      'sepa',
      'bank_reconciliation',
      'rent_increases',
      'insurance',
      'access_control',
      'automations',
      'custom_domain',
      'collections',
    ],
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Falta DATABASE_ADMIN_URL (o DATABASE_URL) en el entorno');
  }
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    for (const data of PLANS) {
      await prisma.subscriptionPlan.upsert({
        where: { slug: data.slug },
        update: { tenantFeatures: data.tenantFeatures as string[] },
        create: data,
      });
    }
    console.info(`[bootstrap] planes OK: ${PLANS.map((p) => p.slug).join(', ')}`);

    const email = process.env.BOOTSTRAP_SUPERADMIN_EMAIL?.trim();
    const password = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD;
    if (email && password) {
      // @node-rs/argon2 usa Argon2id por defecto (igual que AuthService).
      const passwordHash = await argonHash(password);
      await prisma.superAdmin.upsert({
        where: { email },
        // No reseteamos la password si ya existe (puede haberla cambiado).
        update: { role: 'superadmin', isActive: true },
        create: {
          email,
          passwordHash,
          fullName: process.env.BOOTSTRAP_SUPERADMIN_NAME?.trim() || email,
          role: 'superadmin',
        },
      });
      console.info(`[bootstrap] super admin OK: ${email}`);
    } else {
      console.info(
        '[bootstrap] super admin omitido (define BOOTSTRAP_SUPERADMIN_EMAIL y BOOTSTRAP_SUPERADMIN_PASSWORD)',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('[bootstrap] error:', err);
  process.exit(1);
});
