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
import { DEFAULT_SAAS_ADDONS } from '@storageos/shared';

import { BUILTIN_TEMPLATES } from '../modules/communications/builtin-templates';

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
      'cameras',
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

    // Catálogo por defecto de add-ons facturables (idempotente por slug; no
    // sobrescribe precios/ediciones posteriores del super admin).
    for (const a of DEFAULT_SAAS_ADDONS) {
      await prisma.subscriptionAddon.upsert({
        where: { slug: a.slug },
        update: {},
        create: {
          slug: a.slug,
          name: a.name,
          description: a.description,
          priceMonthly: a.priceMonthly,
          feature: a.feature,
        },
      });
    }
    console.info(`[bootstrap] add-ons OK: ${DEFAULT_SAAS_ADDONS.length}`);

    // Backfill de plantillas transaccionales para tenants dados de alta antes de
    // que el registro las sembrara (idempotente: skipDuplicates por el unique
    // (tenant_id, code)). Sin esto, los emails del ciclo de vida caen al
    // fallback en código pero no aparecen en /message-templates para editarlas.
    const tenants = await prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    let seededTemplates = 0;
    for (const t of tenants) {
      const res = await prisma.messageTemplate.createMany({
        data: BUILTIN_TEMPLATES.map((b) => ({
          tenantId: t.id,
          code: b.code,
          kind: b.kind,
          channel: b.channel,
          name: b.name,
          subject: b.subject,
          bodyText: b.bodyText,
          bodyHtml: b.bodyHtml,
          locale: b.locale,
          variables: b.variables,
          metadata: b.trigger ? { trigger: b.trigger } : {},
        })),
        skipDuplicates: true,
      });
      seededTemplates += res.count;
    }
    console.info(
      `[bootstrap] plantillas transaccionales: ${seededTemplates} nuevas en ${tenants.length} tenants`,
    );

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
