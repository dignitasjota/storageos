import { z } from 'zod';

import type { AdminChargeMethod } from './billing-ops';
import type { AdminTenantHealthDto } from './types';

/**
 * Apartado «Negocio» del panel super admin: embudo de pruebas, objetivos,
 * previsión de cobros, avisos de negocio, ficha de negocio del tenant e
 * informe mensual.
 */

/** Periodos que ofrece el selector común de Métricas y Finanzas. */
export const ADMIN_PERIOD_MONTHS = [3, 6, 12, 24] as const;

// --- Embudo de pruebas -----------------------------------------------------

export interface AdminTrialFunnelStepsDto {
  /** Tenants dados de alta (todos empiezan en prueba). */
  signups: number;
  /** Firmaron su primer contrato con un inquilino. */
  activated: number;
  /** Pagan un plan. */
  converted: number;
  /** Pasaron al plan Free. */
  toFree: number;
  /** Cancelados o suspendidos. */
  churned: number;
  /** Siguen en prueba. */
  inTrial: number;
}

export interface AdminTrialFunnelCohortDto extends AdminTrialFunnelStepsDto {
  /** «ene 26». */
  cohort: string;
  /** «2026-01». */
  month: string;
  /** Pagan / pruebas ya terminadas (null si ninguna ha terminado). */
  conversionPct: number | null;
  /** Días medios desde el alta hasta pagar. */
  avgDaysToPay: number | null;
}

export interface AdminTrialFunnelDto {
  months: number;
  totals: AdminTrialFunnelStepsDto;
  conversionPct: number | null;
  activationPct: number | null;
  avgDaysToPay: number | null;
  cohorts: AdminTrialFunnelCohortDto[];
}

// --- Comparación de periodos -----------------------------------------------

export interface AdminPeriodTotalsDto {
  signups: number;
  cancellations: number;
  /** Cobrado neto de suscripciones. */
  collected: number;
}

export interface AdminPeriodComparisonDto {
  months: number;
  current: AdminPeriodTotalsDto;
  /** Los mismos meses justo antes. */
  previous: AdminPeriodTotalsDto;
}

// --- Previsión de cobros ---------------------------------------------------

export interface AdminCollectionsForecastBucketDto {
  /** «Próximos 30 días», «31-60 días»… */
  label: string;
  fromDays: number;
  toDays: number;
  byMethod: Record<AdminChargeMethod, number>;
  total: number;
  /** Nº de cargos previstos. */
  count: number;
}

export interface AdminCollectionsForecastDto {
  pricesIncludeVat: boolean;
  buckets: AdminCollectionsForecastBucketDto[];
  /** Cuotas vencidas sin cobrar (en riesgo). */
  overdue: { total: number; count: number };
  /** Adeudos SEPA ya en una remesa pendiente de confirmar. */
  inSepaRemittance: { total: number; count: number };
  /** Tarjetas guardadas de Redsys con el último cobro rechazado. */
  cardIssues: number;
}

// --- Objetivos -------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD')
  .nullable();

export const UpdateBusinessGoalsSchema = z.object({
  mrrTarget: z.number().min(0).max(100_000_000).nullable().optional(),
  signupsTargetMonthly: z.number().int().min(0).max(100_000).nullable().optional(),
  trialConversionTargetPct: z.number().int().min(0).max(100).nullable().optional(),
  targetDate: isoDate.optional(),
});
export type UpdateBusinessGoalsInput = z.infer<typeof UpdateBusinessGoalsSchema>;

export interface AdminGoalProgressDto {
  current: number;
  target: number;
  /** current / target en % (puede pasar de 100). */
  pct: number;
}

export interface AdminBusinessGoalsDto {
  mrrTarget: number | null;
  signupsTargetMonthly: number | null;
  trialConversionTargetPct: number | null;
  targetDate: string | null;
  progress: {
    mrr: AdminGoalProgressDto | null;
    /** Altas de este mes frente al objetivo mensual. */
    signups: AdminGoalProgressDto | null;
    /** Conversión de las pruebas de los últimos 3 meses. */
    trialConversion: AdminGoalProgressDto | null;
  };
  /** MRR que habría que sumar cada mes para llegar al objetivo en la fecha. */
  mrrNeededPerMonth: number | null;
  updatedAt: string | null;
}

// --- Avisos de negocio -----------------------------------------------------

export const UpdateBusinessAlertSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mrrDropPct: z.number().int().min(1).max(100).optional(),
  churnPct: z.number().int().min(1).max(100).optional(),
  aiCostUsdWeek: z.number().min(0).max(100_000).optional(),
  bigTenantMrr: z.number().min(0).max(1_000_000).optional(),
});
export type UpdateBusinessAlertSettingsInput = z.infer<typeof UpdateBusinessAlertSettingsSchema>;

export interface AdminBusinessAlertSettingsDto {
  enabled: boolean;
  mrrDropPct: number;
  churnPct: number;
  aiCostUsdWeek: number;
  bigTenantMrr: number;
}

export type AdminBusinessAlertKind = 'mrr_drop' | 'churn' | 'big_tenant_at_risk' | 'ai_cost';

export interface AdminBusinessAlertDto {
  kind: AdminBusinessAlertKind;
  title: string;
  detail: string;
  tenantId: string | null;
}

export interface AdminBusinessAlertsDto {
  settings: AdminBusinessAlertSettingsDto;
  alerts: AdminBusinessAlertDto[];
}

// --- Ficha de negocio del tenant -------------------------------------------

export interface AdminTenantBusinessDto {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  planName: string | null;
  /** Suma al MRR (suscripción activa y tenant vivo). */
  paying: boolean;
  mrr: { plan: number; addons: number; total: number };
  payments: {
    /** Cobrado neto (cobrado − devuelto). */
    totalNet: number;
    refunded: number;
    count: number;
    firstPaidAt: string | null;
    lastPaidAt: string | null;
  };
  /** Meses desde el alta (hasta la baja si se fue). */
  lifespanMonths: number;
  health: AdminTenantHealthDto;
  usage30d: {
    emailsSent: number;
    bounceRate: number | null;
    aiCalls: number;
    aiCostUsd: number;
    storageBytes: number;
  };
  adoption: {
    usedFeatures: string[];
    monthlyPaid: number;
    isCandidate: boolean;
    recommendedPlanName: string | null;
  } | null;
  /** MRR de los últimos 12 meses (snapshots). */
  mrrHistory: { label: string; mrr: number }[];
}

// --- Informe mensual -------------------------------------------------------

export const MONTH_PARAM_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface AdminMonthlyReportDto {
  /** «2026-10». */
  month: string;
  /** «octubre de 2026». */
  label: string;
  mrrStart: number;
  mrrEnd: number;
  movements: {
    newMrr: number;
    expansion: number;
    reactivation: number;
    contraction: number;
    churn: number;
    net: number;
  };
  signups: number;
  cancellations: number;
  trialsEnded: number;
  trialsConverted: number;
  collected: number;
  refunded: number;
  invoiced: number;
  payingTenants: number;
  topTenants: { name: string; mrr: number }[];
}
