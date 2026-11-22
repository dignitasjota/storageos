import { platformPricing, type PlatformPricing } from '../modules/billing-saas/platform-pricing';

import { todayInTimezone, zonedMonthStart } from './format';

import type { PrismaAdminService } from '../modules/database/prisma-admin.service';
import type { Prisma } from '@storageos/database';

/**
 * Definiciones comunes de las métricas de negocio del panel super admin, para
 * que Métricas, Finanzas, Negocio, «Hoy», la lista de tenants y los snapshots
 * de MRR cuenten lo mismo.
 *
 * Estados de un tenant a efectos de negocio:
 *  - **en prueba**: `tenant.status = 'trial'`. No paga.
 *  - **pagando**: tenant `active` con la suscripción `active` y cuota > 0.
 *  - **pago atrasado**: tenant `active` con la suscripción `past_due`. Sigue en
 *    el MRR hasta que el escalado lo suspende; no es baja ni reactivación.
 *  - **solo lectura**: tenant `active` con la suscripción `expired` (la prueba
 *    terminó sin pagar). No es cliente vivo ni baja: va aparte. Si llegó a
 *    pagar antes, sí cuenta como baja (con la fecha de fin de su periodo).
 *  - **baja**: tenant `suspended` o `cancelled` (también los anonimizados) que
 *    llegó a pagar. La fecha es `canceledAt` (o `updatedAt` en las antiguas).
 * Las cuentas exentas (`billingExempt`) quedan fuera de todo.
 */

const DAY = 86_400_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Zona de los cortes de mes de las métricas de la plataforma. */
export const SAAS_TIMEZONE = 'Europe/Madrid';

/** Estados de un tenant que cuentan como baja. */
export const CHURNED_STATUSES = ['suspended', 'cancelled'] as const;

/** Estados de la suscripción que suman al MRR (el atrasado sigue sumando). */
export const MRR_SUBSCRIPTION_STATUSES = ['active', 'past_due'] as const;

/** Pagos de suscripción que se llegaron a cobrar (aunque se devolvieran luego). */
export const COLLECTED_PAYMENT_STATUSES = ['paid', 'partially_refunded', 'refunded'] as const;

/** Tenant que sigue con nosotros (no de baja, no borrado, no exento). */
export const LIVE_TENANT_WHERE = {
  deletedAt: null,
  billingExempt: false,
  status: { in: ['active', 'trial'] },
} satisfies Prisma.TenantWhereInput;

/** Tenant que puede estar pagando: activo (ni en prueba ni suspendido), sin borrar ni exento. */
export const PAYING_TENANT_WHERE = {
  deletedAt: null,
  billingExempt: false,
  status: 'active',
} satisfies Prisma.TenantWhereInput;

/**
 * Suscripción que suma al MRR: activa o con el pago atrasado, de un tenant
 * activo. Suspender a mano no toca la suscripción, por eso se mira también el
 * tenant. La cuota > 0 se comprueba al calcular su MRR (`tenantMrr`).
 */
export const PAYING_SUBSCRIPTION_WHERE = {
  status: { in: [...MRR_SUBSCRIPTION_STATUSES] },
  tenant: PAYING_TENANT_WHERE,
} satisfies Prisma.TenantSubscriptionWhereInput;

export function isLiveTenantStatus(status: string): boolean {
  return status === 'active' || status === 'trial';
}

export function isChurnedStatus(status: string): boolean {
  return (CHURNED_STATUSES as readonly string[]).includes(status);
}

/** Suscripción y tenant que suman al MRR (falta comprobar que la cuota sea > 0). */
export function isPayingSubscription(
  sub: { status: string } | null | undefined,
  tenant: { status: string; billingExempt?: boolean; deletedAt?: Date | null },
): boolean {
  return (
    !!sub &&
    (MRR_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status) &&
    tenant.status === 'active' &&
    !tenant.billingExempt &&
    !tenant.deletedAt
  );
}

export type TenantMetricsState =
  | 'trial'
  | 'active'
  | 'past_due'
  | 'read_only'
  | 'suspended'
  | 'cancelled';

/** Estado de un tenant para «Tenants por estado». */
export function tenantMetricsState(
  tenantStatus: string,
  subStatus: string | null | undefined,
): TenantMetricsState {
  if (tenantStatus === 'trial') return 'trial';
  if (tenantStatus === 'suspended') return 'suspended';
  if (tenantStatus === 'cancelled') return 'cancelled';
  if (subStatus === 'expired') return 'read_only';
  if (subStatus === 'past_due') return 'past_due';
  return 'active';
}

// --- Meses en hora de España ------------------------------------------------

/** Índice absoluto del mes (año × 12 + mes − 1) de un instante en hora de España. */
export function madridMonthIndex(d: Date): number {
  const day = todayInTimezone(SAAS_TIMEZONE, d);
  return day.getUTCFullYear() * 12 + day.getUTCMonth();
}

/** Índice de un mes guardado como fecha del día 1 (columnas `DATE`, p. ej. snapshots). */
export function dateMonthIndex(d: Date): number {
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Instante en que empieza el mes (medianoche del día 1 en hora de España). */
export function monthIndexStart(idx: number): Date {
  return zonedMonthStart(Math.floor(idx / 12), (idx % 12) + 1, SAAS_TIMEZONE);
}

/** Día 1 del mes como fecha UTC (clave de las columnas `DATE`). */
export function monthIndexDate(idx: number): Date {
  return new Date(Date.UTC(Math.floor(idx / 12), idx % 12, 1));
}

/** «AAAA-MM» de un índice de mes. */
export function monthIndexKey(idx: number): string {
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** «dic 25». */
export function monthIndexLabel(idx: number): string {
  return `${MONTHS_ES[idx % 12]} ${String(Math.floor(idx / 12) % 100).padStart(2, '0')}`;
}

/**
 * El mismo momento del mes, un año antes (p. ej. el 22 de noviembre a las 10:00
 * → el 22 de noviembre del año pasado a las 10:00, sin pasar del fin de mes).
 */
export function sameInstantLastYear(now: Date): Date {
  const idx = madridMonthIndex(now);
  const offset = now.getTime() - monthIndexStart(idx).getTime();
  const start = monthIndexStart(idx - 12);
  const end = monthIndexStart(idx - 11);
  return new Date(Math.min(start.getTime() + offset, end.getTime()));
}

/** Lee `months` de la URL: un número (1-`max`) o el valor por defecto si no lo es. */
export function parseMonthsParam(raw: string | undefined, fallback = 12, max = 24): number {
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

// --- Cobros --------------------------------------------------------------------

/** Fecha de baja de un tenant suspendido o cancelado. */
export function churnDate(t: { canceledAt: Date | null; updatedAt: Date }): Date {
  return t.canceledAt ?? t.updatedAt;
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

// --- MRR de un tenant ---------------------------------------------------------

/**
 * Ciclo de una suscripción: un periodo de más de 200 días es anual. La remesa
 * SEPA y el cobro automático de Redsys cobran siempre la cuota mensual, aunque
 * el último periodo pagado fuera de un año (p. ej. un pago a mano de 12 meses
 * antes de domiciliar).
 */
export function subscriptionCycle(sub: {
  billingMode: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}): 'monthly' | 'yearly' {
  if (sub.billingMode === 'sepa' || sub.billingMode === 'redsys') return 'monthly';
  const len = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
  return len > 200 * DAY ? 'yearly' : 'monthly';
}

/** Precio sin IVA de un precio de lista de la plataforma. */
export function listPriceWithoutVat(price: number, pricing: PlatformPricing): number {
  return pricing.includeVat ? price / (1 + pricing.taxRate / 100) : price;
}

/** Importe cobrado (los cobros llevan siempre el IVA) sin el IVA. */
export function chargedWithoutVat(amount: number, pricing: PlatformPricing): number {
  return amount / (1 + pricing.taxRate / 100);
}

export interface MrrSubscriptionInput {
  billingMode: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  plan: { priceMonthly: unknown; priceYearly: unknown };
}

export interface TenantMrrBreakdown {
  /** Cuota del plan al mes, con su descuento y sin IVA. */
  plan: number;
  /** Extras activos al mes, sin IVA. */
  addons: number;
  total: number;
}

/**
 * MRR de un tenant: lo que aporta al mes, **sin IVA**.
 *  - Cuota del plan: la mensual o, si paga por años, la anual entre 12.
 *  - Descuento: la proporción de descuento de su último pago del plan (cupón
 *    o descuento a mano) se aplica a la cuota. Los cupones de Stripe no se
 *    guardan en el pago, así que con Stripe cuenta el precio de lista.
 *  - Extras: los activos (sin suspender), a su precio congelado.
 *  - IVA: si los precios lo incluyen, se descuenta (precio / (1 + tipo)).
 * No mira si el tenant paga: eso lo decide `isPayingSubscription` (una prueba
 * tiene la cuota que pagaría, pero no suma al MRR).
 */
export function tenantMrr(
  sub: MrrSubscriptionInput,
  opts: { addonsMonthly: number; discountRatio: number; pricing: PlatformPricing },
): TenantMrrBreakdown {
  const yearly = subscriptionCycle(sub) === 'yearly';
  const list = yearly ? Number(sub.plan.priceYearly) / 12 : Number(sub.plan.priceMonthly);
  const ratio = Math.min(Math.max(opts.discountRatio, 0), 1);
  const plan = round2(listPriceWithoutVat(list * (1 - ratio), opts.pricing));
  const addons = round2(listPriceWithoutVat(opts.addonsMonthly, opts.pricing));
  return { plan, addons, total: round2(plan + addons) };
}

export interface TenantMrrDetail extends TenantMrrBreakdown {
  /** Lo que se deja de ingresar al mes por el descuento, sin IVA. */
  discount: number;
  cycle: 'monthly' | 'yearly';
}

/** `tenantMrr` con el descuento que se deja de ingresar y el ciclo de pago. */
export function tenantMrrDetail(
  sub: MrrSubscriptionInput,
  opts: { addonsMonthly: number; discountRatio: number; pricing: PlatformPricing },
): TenantMrrDetail {
  const base = tenantMrr(sub, opts);
  const cycle = subscriptionCycle(sub);
  const list =
    cycle === 'yearly' ? Number(sub.plan.priceYearly) / 12 : Number(sub.plan.priceMonthly);
  const ratio = Math.min(Math.max(opts.discountRatio, 0), 1);
  return { ...base, discount: round2(listPriceWithoutVat(list * ratio, opts.pricing)), cycle };
}

/** Datos para calcular el MRR de varios tenants con pocas consultas. */
export interface MrrContext {
  pricing: PlatformPricing;
  /** Extras activos al mes (precio de lista) por tenant. */
  addonsByTenant: Map<string, number>;
  /** Proporción de descuento (0-1) del último pago del plan por tenant. */
  discountByTenant: Map<string, number>;
}

export async function loadMrrContext(
  admin: PrismaAdminService,
  tenantIds?: string[],
): Promise<MrrContext> {
  const scope = tenantIds ? { tenantId: { in: tenantIds } } : {};
  const [pricing, addons, lastPayments] = await Promise.all([
    platformPricing(admin),
    admin.tenantSubscriptionAddon.findMany({
      where: { ...scope, suspendedAt: null },
      select: { tenantId: true, priceMonthly: true, quantity: true },
    }),
    // Último pago del plan de cada tenant (los cobros sueltos de un extra no
    // llevan el descuento del plan).
    admin.tenantSubscriptionPayment.findMany({
      where: {
        ...scope,
        status: { in: ['paid', 'partially_refunded'] },
        paidAt: { not: null },
        planSlug: { not: null },
        // Ojo: `NOT startsWith` deja fuera los NULL en SQL; por eso el OR.
        OR: [{ description: null }, { NOT: { description: { startsWith: 'Add-on:' } } }],
      },
      orderBy: [{ tenantId: 'asc' }, { paidAt: 'desc' }],
      distinct: ['tenantId'],
      select: { tenantId: true, amount: true, discount: true },
    }),
  ]);
  const addonsByTenant = new Map<string, number>();
  for (const a of addons) {
    addonsByTenant.set(
      a.tenantId,
      (addonsByTenant.get(a.tenantId) ?? 0) + Number(a.priceMonthly) * a.quantity,
    );
  }
  const discountByTenant = new Map<string, number>();
  for (const p of lastPayments) {
    const discount = Number(p.discount ?? 0);
    const gross = Number(p.amount) + discount;
    if (discount > 0 && gross > 0) discountByTenant.set(p.tenantId, discount / gross);
  }
  return { pricing, addonsByTenant, discountByTenant };
}

export function mrrFor(
  ctx: MrrContext,
  tenantId: string,
  sub: MrrSubscriptionInput,
): TenantMrrDetail {
  return tenantMrrDetail(sub, {
    addonsMonthly: ctx.addonsByTenant.get(tenantId) ?? 0,
    discountRatio: ctx.discountByTenant.get(tenantId) ?? 0,
    pricing: ctx.pricing,
  });
}

export const MRR_SUBSCRIPTION_SELECT = {
  tenantId: true,
  status: true,
  billingMode: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  plan: { select: { slug: true, name: true, priceMonthly: true, priceYearly: true } },
} satisfies Prisma.TenantSubscriptionSelect;

export interface PayingTenantMrr extends TenantMrrDetail {
  tenantId: string;
  planSlug: string;
  planName: string;
  subscriptionStatus: string;
}

/**
 * MRR actual de los tenants que pagan (suscripción activa o atrasada, tenant
 * activo y cuota > 0), por tenant. La única definición del MRR de la
 * plataforma: la usan Métricas, Finanzas, Negocio, «Hoy» y los snapshots.
 */
export async function currentMrrByTenant(
  admin: PrismaAdminService,
): Promise<Map<string, PayingTenantMrr>> {
  const subs = await admin.tenantSubscription.findMany({
    where: PAYING_SUBSCRIPTION_WHERE,
    select: MRR_SUBSCRIPTION_SELECT,
  });
  const ctx = await loadMrrContext(
    admin,
    subs.map((s) => s.tenantId),
  );
  const out = new Map<string, PayingTenantMrr>();
  for (const s of subs) {
    const mrr = mrrFor(ctx, s.tenantId, s);
    if (mrr.total <= 0) continue;
    out.set(s.tenantId, {
      ...mrr,
      tenantId: s.tenantId,
      planSlug: s.plan.slug,
      planName: s.plan.name,
      subscriptionStatus: s.status,
    });
  }
  return out;
}

// --- Clientes que han pagado y sus bajas ----------------------------------------

export interface PayerLifecycle {
  tenantId: string;
  name: string;
  slug: string;
  createdAt: Date;
  /** Primer pago (cobro, snapshot de MRR o, si no hay, cuándo empezó su cuota). */
  firstPaidAt: Date;
  /** Fecha de baja; null si sigue con nosotros. */
  churnedAt: Date | null;
  churnReason: string | null;
  status: string;
  subscription: { status: string; cancelAtPeriodEnd: boolean } | null;
  /** Último MRR conocido (snapshot) o el de su cuota ahora, sin IVA. */
  lastMrr: number;
}

/**
 * Tenants que han llegado a pagar (cobros de suscripción, un snapshot de MRR
 * con importe o la suscripción activa o atrasada con cuota) y, si se fueron,
 * cuándo. Una prueba que terminó sin pagar no está: no es cliente ni baja.
 * Es la base de la retención, el churn y el LTV.
 */
export async function loadPayerLifecycles(
  admin: PrismaAdminService,
  now = new Date(),
): Promise<PayerLifecycle[]> {
  const [firstPayments, firstSnapshots, lastSnapshots, tenants, ctx] = await Promise.all([
    admin.tenantSubscriptionPayment.groupBy({
      by: ['tenantId'],
      where: { status: { in: [...COLLECTED_PAYMENT_STATUSES] }, paidAt: { not: null } },
      _min: { paidAt: true },
    }),
    admin.mrrSnapshot.groupBy({
      by: ['tenantId'],
      where: { mrr: { gt: 0 } },
      _min: { month: true },
    }),
    admin.mrrSnapshot.findMany({
      where: { mrr: { gt: 0 } },
      orderBy: [{ tenantId: 'asc' }, { month: 'desc' }],
      distinct: ['tenantId'],
      select: { tenantId: true, mrr: true },
    }),
    admin.tenant.findMany({
      where: { billingExempt: false },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        canceledAt: true,
        trialEndedAt: true,
        churnReason: true,
        subscription: {
          select: { ...MRR_SUBSCRIPTION_SELECT, cancelAtPeriodEnd: true, updatedAt: true },
        },
      },
    }),
    loadMrrContext(admin),
  ]);
  const firstPaid = new Map<string, Date>();
  const remember = (id: string, d: Date | null | undefined) => {
    if (!d) return;
    const prev = firstPaid.get(id);
    if (!prev || d < prev) firstPaid.set(id, d);
  };
  for (const p of firstPayments) remember(p.tenantId, p._min.paidAt);
  // El snapshot guarda el día 1 del mes: se toma su comienzo en hora de España.
  for (const s of firstSnapshots) {
    if (s._min.month) remember(s.tenantId, monthIndexStart(dateMonthIndex(s._min.month)));
  }
  const lastMrrBy = new Map(lastSnapshots.map((s) => [s.tenantId, Number(s.mrr)]));

  const out: PayerLifecycle[] = [];
  for (const t of tenants) {
    const sub = t.subscription;
    const currentMrr = sub ? mrrFor(ctx, t.id, sub).total : 0;
    // Paga ahora (o pagaba al suspenderlo: suspender no toca la suscripción).
    const subPaying =
      !!sub &&
      t.status !== 'trial' &&
      (MRR_SUBSCRIPTION_STATUSES as readonly string[]).includes(sub.status) &&
      currentMrr > 0;
    if (subPaying && !firstPaid.has(t.id)) {
      remember(t.id, t.trialEndedAt ?? sub.currentPeriodStart);
    }
    const first = firstPaid.get(t.id);
    if (!first) continue;

    let churnedAt: Date | null = null;
    if (isChurnedStatus(t.status)) churnedAt = churnDate(t);
    else if (t.status === 'active' && sub?.status === 'expired') {
      // Pagó y quedó en solo lectura: se fue al acabar el periodo pagado.
      churnedAt = sub.currentPeriodEnd <= now ? sub.currentPeriodEnd : sub.updatedAt;
    }
    out.push({
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      createdAt: t.createdAt,
      firstPaidAt: first < t.createdAt ? t.createdAt : first,
      churnedAt,
      churnReason: t.churnReason,
      status: t.status,
      subscription: sub ? { status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : null,
      lastMrr: lastMrrBy.get(t.id) ?? currentMrr,
    });
  }
  return out;
}

/** ¿Se dio de baja en `[from, to)`? */
export function churnedBetween(p: PayerLifecycle, from: Date, to?: Date): boolean {
  return !!p.churnedAt && p.churnedAt >= from && (!to || p.churnedAt < to);
}

/** ¿Era un cliente que pagaba en el instante `at`? */
export function payingAt(p: PayerLifecycle, at: Date): boolean {
  return p.firstPaidAt < at && (!p.churnedAt || p.churnedAt >= at);
}

/**
 * En qué acabó una prueba (embudo y «Pruebas terminadas»): pagan (también con
 * el pago atrasado), terminaron sin pagar, o pagaron y se dieron de baja.
 */
export function trialOutcome(
  t: { status: string },
  payer: PayerLifecycle | undefined,
): 'converted' | 'toFree' | 'churned' | 'inTrial' {
  if (t.status === 'trial') return 'inTrial';
  if (!payer) return 'toFree';
  return payer.churnedAt ? 'churned' : 'converted';
}
