import type { Prisma } from '@storageos/database';

/**
 * Definiciones comunes de las métricas de negocio del panel super admin, para
 * que Métricas, Finanzas, los snapshots de MRR y los add-ons cuenten lo mismo.
 */

/** Estados de un tenant que cuentan como baja. */
export const CHURNED_STATUSES = ['suspended', 'cancelled'] as const;

/** Tenant que sigue con nosotros (no de baja, no borrado, no exento). */
export const LIVE_TENANT_WHERE = {
  deletedAt: null,
  billingExempt: false,
  status: { in: ['active', 'trial'] },
} satisfies Prisma.TenantWhereInput;

/**
 * Suscripción que suma al MRR: activa y de un tenant vivo. Suspender a un
 * tenant a mano no toca su suscripción, por eso se mira también el tenant.
 */
export const PAYING_SUBSCRIPTION_WHERE = {
  status: 'active',
  tenant: LIVE_TENANT_WHERE,
} satisfies Prisma.TenantSubscriptionWhereInput;

export function isLiveTenantStatus(status: string): boolean {
  return status === 'active' || status === 'trial';
}

/**
 * Bajas en `[from, to)`. La fecha de baja es `canceledAt`; las bajas anteriores
 * a esa columna caen a `updatedAt`. Incluye a los anonimizados (borrados).
 */
export function churnedBetweenWhere(from: Date, to?: Date): Prisma.TenantWhereInput {
  const range = to ? { gte: from, lt: to } : { gte: from };
  return {
    billingExempt: false,
    status: { in: [...CHURNED_STATUSES] },
    OR: [{ canceledAt: range }, { canceledAt: null, updatedAt: range }],
  };
}

/** Fecha de baja de un tenant de baja. */
export function churnDate(t: { canceledAt: Date | null; updatedAt: Date }): Date {
  return t.canceledAt ?? t.updatedAt;
}

/** Tenants vivos en un instante: dados de alta antes y no de baja todavía. */
export function aliveAtWhere(at: Date): Prisma.TenantWhereInput {
  return {
    billingExempt: false,
    createdAt: { lt: at },
    OR: [
      { status: { notIn: [...CHURNED_STATUSES] }, deletedAt: null },
      { status: { in: [...CHURNED_STATUSES] }, canceledAt: { gte: at } },
      { status: { in: [...CHURNED_STATUSES] }, canceledAt: null, updatedAt: { gte: at } },
    ],
  };
}

/** Importe neto de un pago de suscripción (cobrado − devuelto). */
export function netPaid(p: { amount: unknown; refundedAmount: unknown }): number {
  return Math.max(0, Number(p.amount) - Number(p.refundedAmount ?? 0));
}

/** Forma de cobro agrupada de un pago de suscripción. */
export function financeSource(provider: string): 'stripe' | 'sepa' | 'redsys' | 'manual' {
  if (provider === 'stripe' || provider === 'sepa' || provider === 'redsys') return provider;
  return 'manual';
}

/** Llamadas a la IA hechas con la clave propia del tenant (no nos cuestan). */
export const OWN_KEY_AI_FEATURES = ['whatsapp_own'];
