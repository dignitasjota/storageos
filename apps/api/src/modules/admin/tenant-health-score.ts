import {
  churnRiskOf,
  DEFAULT_HEALTH_CLIENT_WEIGHTS,
  DEFAULT_HEALTH_TRIAL_WEIGHTS,
  mainDragOf,
  payProbabilityOf,
  type HealthClientWeights,
  type HealthTrialWeights,
} from '@storageos/shared';

import { tenantMetricsState } from '../../common/saas-metrics';

import type {
  AdminHealthSegment,
  AdminTenantHealthDto,
  AdminTenantHealthFactorDto,
  AdminTenantHealthLevel,
} from '@storageos/shared';

/**
 * Cálculo puro de la salud de un cliente y de la activación de una prueba a
 * partir de las señales ya recopiladas (sin base de datos, con pruebas
 * unitarias).
 *
 * **Salud de cliente** (clientes que pagan, activos sin pagar y exentas):
 *  - Actividad del equipo (30 %): días desde el último uso del panel (inicio
 *    de sesión o sesión renovada). Cuando ya hay un mes de registro diario,
 *    la mitad pasa a ser la frecuencia: días con alguien en el panel en los
 *    últimos 30 (12 o más = 100).
 *  - Facturación al día (20 %): contratos activos cuya última factura cubre su
 *    ciclo (mensual: emitida en 35 días o con el periodo pagado vigente; con
 *    prepago, el periodo que pagó). Sin contratos que deban facturar, no cuenta.
 *  - Suscripción (20 %): según el estado de pago (`tenantMetricsState`). En las
 *    exentas no cuenta.
 *  - Adopción (15 %): contratos activos y locales.
 *  - Área de clientes (10 %): inquilinos con contrato que han entrado en 90
 *    días. Si el tenant nunca ha dado acceso a ningún inquilino, no cuenta.
 *  - Soporte (5 %): tickets abiertos sin responder en más de 48 h.
 * Los pesos de los factores que no cuentan se reparten entre los demás. Los
 * pesos se configuran en el panel (`platform_health_settings`); los de arriba
 * son los de por defecto.
 *
 * **Activación de una prueba**: local creado (15 %), trasteros (15 %), primer
 * inquilino (15 %), primer contrato firmado (25 %), primera factura emitida
 * (15 %) y equipo entrando (15 %).
 */

const DAY = 86_400_000;

export interface HealthSignalsInput {
  id: string;
  name: string;
  slug: string;
  status: string;
  billingExempt: boolean;
  planName: string | null;
  subStatus: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  /** Suscripción que suma al MRR con cuota > 0 (paga de verdad). */
  paying: boolean;
  lastActivityAt: Date | null;
  /** Contratos que ya deberían tener su factura del ciclo y los que la tienen. */
  billingExpected: number;
  billingOnTime: number;
  activeContracts: number;
  facilities: number;
  units: number;
  /** Inquilinos con contrato vivo (sin los de prueba). */
  customers: number;
  /** Inquilinos dados de alta (sin los de prueba), con o sin contrato. */
  customersTotal: number;
  /** Inquilinos con contrato vivo que han entrado al área de clientes en 90 días. */
  portalUsers: number;
  /** Inquilinos a los que alguna vez se dio acceso o que alguna vez entraron. */
  portalEverUsed: number;
  staleTickets: number;
  signedContracts: number;
  issuedInvoices: number;
  previousScore: number | null;
  // --- Datos extra (opcionales: sin ellos no cambia la puntuación) ---
  planSlug?: string | null;
  tags?: string[];
  salesRepId?: string | null;
  salesRepName?: string | null;
  /** Lo que paga al mes sin IVA (0 si no paga). */
  mrr?: number;
  /** En prueba: lo que pagaría (null si no). */
  wouldPay?: number | null;
  /** Días y usuarios con actividad en los últimos 30 días (null = sin registro). */
  activeDays30?: number | null;
  activeUsers30?: number | null;
  /** Ya hay al menos 30 días de registro diario (si no, la frecuencia no cuenta). */
  activityTracked?: boolean;
  totalUsers?: number;
  /** Puntuaciones de las últimas semanas (la más antigua primero). */
  sparkline?: number[];
}

export interface HealthWeights {
  client: HealthClientWeights;
  trial: HealthTrialWeights;
}

export const DEFAULT_HEALTH_WEIGHTS: HealthWeights = {
  client: DEFAULT_HEALTH_CLIENT_WEIGHTS,
  trial: DEFAULT_HEALTH_TRIAL_WEIGHTS,
};

export function healthSegment(s: {
  status: string;
  billingExempt: boolean;
  paying: boolean;
}): AdminHealthSegment {
  if (s.billingExempt) return 'exempt';
  if (s.status === 'trial') return 'trial';
  return s.paying ? 'paying' : 'unpaid';
}

export function healthLevel(score: number): AdminTenantHealthLevel {
  return score >= 75 ? 'healthy' : score >= 50 ? 'warm' : score >= 25 ? 'at_risk' : 'dormant';
}

function days(n: number): string {
  const d = Math.floor(n);
  return `${d} ${d === 1 ? 'día' : 'días'}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function factor(
  key: string,
  label: string,
  score: number,
  weight: number,
  detail: string,
  counted = true,
): AdminTenantHealthFactorDto {
  return { key, label, score, weight: counted ? weight : 0, counted, detail };
}

/** Media ponderada de los factores que cuentan (los pesos se reparten). */
function weighted(factors: AdminTenantHealthFactorDto[]): number {
  const counted = factors.filter((f) => f.counted);
  const total = counted.reduce((a, f) => a + f.weight, 0);
  if (total <= 0) return 0;
  return Math.round(counted.reduce((a, f) => a + f.score * f.weight, 0) / total);
}

function activityFactor(last: Date | null, now: number): { daysSince: number; text: string } {
  const daysSince = last ? (now - last.getTime()) / DAY : Infinity;
  const text = last
    ? daysSince < 1
      ? 'Ha entrado hoy'
      : `Último acceso hace ${days(daysSince)}`
    : 'Nadie del equipo ha entrado nunca';
  return { daysSince, text };
}

/** Frecuencia de uso: días con alguien del equipo en el panel (de 30). */
export function frequencyScore(activeDays: number): number {
  return activeDays >= 12
    ? 100
    : activeDays >= 6
      ? 80
      : activeDays >= 3
        ? 50
        : activeDays >= 1
          ? 25
          : 0;
}

export function scoreHealth(
  s: HealthSignalsInput,
  now = Date.now(),
  weights: HealthWeights = DEFAULT_HEALTH_WEIGHTS,
): AdminTenantHealthDto {
  const segment = healthSegment(s);
  const factors =
    segment === 'trial'
      ? activationFactors(s, now, weights.trial)
      : clientFactors(s, segment, now, weights.client);
  const score = weighted(factors);
  const previous = s.previousScore;
  const trend = previous !== null ? score - previous : null;
  const trialDaysLeft =
    segment === 'trial' && s.trialEndsAt ? Math.ceil((s.trialEndsAt.getTime() - now) / DAY) : null;
  const pay =
    segment === 'trial' ? payProbabilityOf(score, trialDaysLeft, s.signedContracts > 0) : null;
  return {
    tenantId: s.id,
    name: s.name,
    slug: s.slug,
    status: s.status,
    planName: s.planName,
    segment,
    kind: segment === 'trial' ? 'activation' : 'health',
    trialEndsAt: segment === 'trial' ? (s.trialEndsAt?.toISOString() ?? null) : null,
    score,
    level: healthLevel(score),
    factors,
    lastActivityAt: s.lastActivityAt?.toISOString() ?? null,
    trend,
    planSlug: s.planSlug ?? null,
    tags: s.tags ?? [],
    salesRepId: s.salesRepId ?? null,
    salesRepName: s.salesRepName ?? null,
    mrr: s.mrr ?? 0,
    wouldPay: s.wouldPay ?? null,
    activeDays30: s.activeDays30 ?? null,
    activeUsers30: s.activeUsers30 ?? null,
    totalUsers: s.totalUsers ?? 0,
    churnRisk: segment === 'trial' ? null : churnRiskOf(score, trend),
    payProbability: pay?.pct ?? null,
    payProbabilityLevel: pay?.level ?? null,
    trialDaysLeft,
    mainDrag: mainDragOf(factors),
    sparkline: s.sparkline ?? [],
  };
}

function clientFactors(
  s: HealthSignalsInput,
  segment: AdminHealthSegment,
  now: number,
  w: HealthClientWeights,
): AdminTenantHealthFactorDto[] {
  // 1) Actividad del equipo: lo reciente y, con un mes de registro, la frecuencia.
  const act = activityFactor(s.lastActivityAt, now);
  const recency =
    act.daysSince <= 7
      ? 100
      : act.daysSince <= 14
        ? 80
        : act.daysSince <= 30
          ? 50
          : act.daysSince <= 90
            ? 20
            : 0;
  const withFrequency =
    !!s.activityTracked && s.activeDays30 !== null && s.activeDays30 !== undefined;
  const engagement = withFrequency
    ? Math.round((recency + frequencyScore(s.activeDays30 ?? 0)) / 2)
    : recency;
  const usersText =
    s.activeUsers30 !== null && s.activeUsers30 !== undefined && s.totalUsers
      ? ` · ${s.activeUsers30} de ${count(s.totalUsers, 'usuario', 'usuarios')}`
      : '';
  const engagementDetail = withFrequency
    ? `${act.text} · ${count(s.activeDays30 ?? 0, 'día activo', 'días activos')} de 30${usersText}`
    : act.text;

  // 2) Facturación al día: lo emitido frente a lo que tocaba emitir.
  const billingCounted = s.billingExpected > 0;
  const billingPct = billingCounted ? (s.billingOnTime / s.billingExpected) * 100 : 0;
  const billing = billingPct >= 90 ? 100 : billingPct >= 70 ? 70 : billingPct >= 40 ? 40 : 10;
  const billingDetail = billingCounted
    ? `${s.billingOnTime} de ${count(s.billingExpected, 'contrato', 'contratos')} con la factura de su ciclo al día`
    : s.activeContracts > 0
      ? 'Sus contratos aún no han cumplido un ciclo de facturación: no cuenta'
      : 'Sin contratos activos: no cuenta';

  // 3) Suscripción: el estado de pago real.
  const state = tenantMetricsState(s.status, s.subStatus);
  let subscription: number;
  let subDetail: string;
  if (state === 'past_due') {
    subscription = 10;
    subDetail = 'Pago de la suscripción atrasado';
  } else if (state === 'read_only') {
    subscription = 10;
    subDetail = 'Sin pagar: en solo lectura';
  } else if (state === 'suspended' || state === 'cancelled') {
    subscription = 0;
    subDetail = state === 'suspended' ? 'Cuenta suspendida' : 'Cuenta dada de baja';
  } else if (!s.subStatus) {
    subscription = 10;
    subDetail = 'Sin suscripción';
  } else if (s.subStatus === 'cancelled') {
    subscription = 10;
    subDetail = 'Suscripción cancelada';
  } else if (s.cancelAtPeriodEnd) {
    subscription = 20;
    subDetail = 'Cancelación programada';
  } else if (s.paying) {
    subscription = 100;
    subDetail = 'Suscripción activa y al día';
  } else {
    subscription = 50;
    subDetail = 'Plan gratis: no paga';
  }

  // 4) Adopción: contratos activos + locales.
  const adoption =
    s.activeContracts >= 10
      ? 100
      : s.activeContracts >= 3
        ? 70
        : s.activeContracts >= 1
          ? 40
          : s.facilities > 0
            ? 15
            : 0;
  const adoptionDetail = `${count(s.activeContracts, 'contrato activo', 'contratos activos')} · ${count(s.facilities, 'local', 'locales')}`;

  // 5) Área de clientes: solo si alguna vez se dio acceso a algún inquilino.
  const portalCounted = s.portalEverUsed > 0 && s.customers > 0;
  const portalPct = portalCounted ? (s.portalUsers / s.customers) * 100 : 0;
  const portal = portalPct >= 50 ? 100 : portalPct >= 25 ? 70 : portalPct > 0 ? 40 : 10;
  const portalDetail = !portalCounted
    ? s.portalEverUsed === 0
      ? 'No ha dado acceso al área de clientes a ningún inquilino: no cuenta'
      : 'Sin inquilinos con contrato: no cuenta'
    : `El ${Math.round(portalPct)} % de sus inquilinos entró en 90 días`;

  // 6) Soporte.
  const support = s.staleTickets === 0 ? 100 : s.staleTickets === 1 ? 40 : 10;
  const supportDetail =
    s.staleTickets === 0
      ? 'Sin tickets esperando respuesta'
      : `${count(s.staleTickets, 'ticket', 'tickets')} sin responder en más de 48 h`;

  return [
    factor('engagement', 'Actividad del equipo', engagement, w.engagement / 100, engagementDetail),
    factor(
      'billing',
      'Facturación al día',
      billing,
      w.billing / 100,
      billingDetail,
      billingCounted,
    ),
    factor(
      'subscription',
      'Suscripción',
      subscription,
      w.subscription / 100,
      segment === 'exempt' ? 'Cuenta exenta: no paga, no cuenta' : subDetail,
      segment !== 'exempt',
    ),
    factor('adoption', 'Adopción', adoption, w.adoption / 100, adoptionDetail),
    factor('portal', 'Área de clientes', portal, w.portal / 100, portalDetail, portalCounted),
    factor('support', 'Soporte', support, w.support / 100, supportDetail),
  ];
}

function activationFactors(
  s: HealthSignalsInput,
  now: number,
  w: HealthTrialWeights,
): AdminTenantHealthFactorDto[] {
  const act = activityFactor(s.lastActivityAt, now);
  const team = act.daysSince <= 3 ? 100 : act.daysSince <= 7 ? 70 : act.daysSince <= 14 ? 40 : 0;
  const units = s.units >= 5 ? 100 : s.units >= 1 ? 60 : 0;
  return [
    factor(
      'facility',
      'Local creado',
      s.facilities > 0 ? 100 : 0,
      w.facility / 100,
      s.facilities > 0 ? count(s.facilities, 'local', 'locales') : 'Aún sin locales',
    ),
    factor(
      'units',
      'Trasteros dados de alta',
      units,
      w.units / 100,
      s.units > 0 ? count(s.units, 'trastero', 'trasteros') : 'Aún sin trasteros',
    ),
    factor(
      'customer',
      'Primer inquilino',
      s.customersTotal > 0 ? 100 : 0,
      w.customer / 100,
      s.customersTotal > 0
        ? count(s.customersTotal, 'inquilino', 'inquilinos')
        : 'Aún sin inquilinos',
    ),
    factor(
      'contract',
      'Primer contrato firmado',
      s.signedContracts > 0 ? 100 : 0,
      w.contract / 100,
      s.signedContracts > 0
        ? count(s.signedContracts, 'contrato firmado', 'contratos firmados')
        : 'Aún sin contratos firmados',
    ),
    factor(
      'invoice',
      'Primera factura emitida',
      s.issuedInvoices > 0 ? 100 : 0,
      w.invoice / 100,
      s.issuedInvoices > 0
        ? count(s.issuedInvoices, 'factura emitida', 'facturas emitidas')
        : 'Aún sin facturas',
    ),
    factor('team', 'Equipo entrando', team, w.team / 100, act.text),
  ];
}
