import { z } from 'zod';

import type { AdminAddonOpportunityDto, PlatformLeadDetailDto, PlatformLeadDto } from '../admin';
import type { SalesAppointmentDto } from './appointments';
import type { PlatformQuoteOfferDto } from '../admin/catalog';

export * from './appointments';

/**
 * Comerciales del panel de administración (rol `sales`): su código y enlace,
 * su cartera, la ficha de llamada, lo que pueden vender y sus comisiones.
 */

// ---------------------------------------------------------------- código

/** Parámetro de la URL con el código del comercial (`?team=ANA7K2`). */
export const SALES_CODE_PARAM = 'team';
/** Lo que guarda el navegador del código del enlace (días). */
export const SALES_CODE_TTL_DAYS = 90;

const SALES_CODE_RE = /^[A-Z0-9]{4,12}$/;

/** Código en mayúsculas y sin separadores, o null si no tiene la forma. */
export function normalizeSalesCode(raw: string | null | undefined): string | null {
  const v = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return SALES_CODE_RE.test(v) ? v : null;
}

/** Enlace de registro con el código del comercial. */
export function salesSignupUrl(siteUrl: string, code: string): string {
  return `${siteUrl.replace(/\/$/, '')}/register?${SALES_CODE_PARAM}=${encodeURIComponent(code)}`;
}

/** Enlace a la web con el código (el registro posterior lo lleva puesto). */
export function salesLandingUrl(siteUrl: string, code: string): string {
  return `${siteUrl.replace(/\/$/, '')}/?${SALES_CODE_PARAM}=${encodeURIComponent(code)}`;
}

/** Comprobación pública de un código (registro y formularios). */
export interface SalesCodeCheckDto {
  valid: boolean;
  /** Nombre del comercial, para «Te atiende…». */
  repName: string | null;
  /** Días de prueba de más por venir con el código (0 = ninguno). */
  extraTrialDays: number;
}

// ---------------------------------------------------------- ficha de llamada

export const SALES_TEMPERATURES = ['cold', 'warm', 'hot'] as const;
export const SalesTemperatureEnum = z.enum(SALES_TEMPERATURES);
export type SalesTemperature = z.infer<typeof SalesTemperatureEnum>;
export const SALES_TEMPERATURE_LABELS: Record<SalesTemperature, string> = {
  cold: 'Frío',
  warm: 'Templado',
  hot: 'Caliente',
};

export const SALES_CALL_OUTCOMES = [
  'no_answer',
  'call_later',
  'interested',
  'demo_booked',
  'not_interested',
  'won',
] as const;
export const SalesCallOutcomeEnum = z.enum(SALES_CALL_OUTCOMES);
export type SalesCallOutcome = z.infer<typeof SalesCallOutcomeEnum>;
export const SALES_CALL_OUTCOME_LABELS: Record<SalesCallOutcome, string> = {
  no_answer: 'No contesta',
  call_later: 'Volver a llamar',
  interested: 'Interesado',
  demo_booked: 'Demo agendada',
  not_interested: 'No interesado',
  won: 'Ha contratado',
};
/**
 * Seguimiento que se crea solo tras cada resultado: días desde hoy (null =
 * ninguno). «Volver a llamar» y «Demo agendada» piden la fecha.
 */
export const SALES_OUTCOME_FOLLOWUP_DAYS: Record<SalesCallOutcome, number | null> = {
  no_answer: 1,
  call_later: 3,
  interested: 3,
  demo_booked: 2,
  not_interested: null,
  won: null,
};
export const SALES_OUTCOME_FOLLOWUP_TITLES: Record<SalesCallOutcome, string> = {
  no_answer: 'Volver a llamar (no contestó)',
  call_later: 'Volver a llamar',
  interested: 'Seguir con el interesado',
  demo_booked: 'Demo',
  not_interested: '',
  won: '',
};

export const SALES_CONTACT_CHANNELS = ['call', 'whatsapp', 'email', 'meeting'] as const;
export const SalesContactChannelEnum = z.enum(SALES_CONTACT_CHANNELS);
export type SalesContactChannel = z.infer<typeof SalesContactChannelEnum>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const UpdateSalesProfileSchema = z.object({
  pinnedNote: nullableText(1000),
  status: nullableText(120),
  temperature: SalesTemperatureEnum.nullable().optional(),
  decisionMaker: nullableText(160),
  bestTime: nullableText(120),
  nextAction: nullableText(200),
});
export type UpdateSalesProfileInput = z.infer<typeof UpdateSalesProfileSchema>;

export const SalesCallOutcomeSchema = z.object({
  outcome: SalesCallOutcomeEnum,
  channel: SalesContactChannelEnum.default('call'),
  note: z.string().trim().max(2000).optional(),
  /** Fecha del siguiente seguimiento (si no, la que toca por el resultado). */
  /** null = sin seguimiento; sin enviar = el de por defecto del resultado. */
  followupDate: isoDate.nullable().optional(),
});
export type SalesCallOutcomeInput = z.infer<typeof SalesCallOutcomeSchema>;

export interface SalesAccountProfileDto {
  pinnedNote: string | null;
  status: string | null;
  temperature: SalesTemperature | null;
  decisionMaker: string | null;
  bestTime: string | null;
  nextAction: string | null;
  lastOutcome: SalesCallOutcome | null;
  lastContactAt: string | null;
  trialExtensionDays: number;
  addonTrials: number;
  updatedAt: string | null;
}

// --------------------------------------------------------------- prospectos

const optText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

export const CreateSalesProspectSchema = z
  .object({
    companyName: optText(160),
    contactName: optText(120),
    email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal('')),
    phone: optText(30),
    city: optText(80),
    units: optText(40),
    facilities: optText(40),
    currentSoftware: optText(120),
    profile: optText(120),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((v) => !!(v.email || v.phone), {
    message: 'Pon al menos un email o un teléfono',
    path: ['email'],
  })
  .refine((v) => !!(v.companyName || v.contactName), {
    message: 'Pon el nombre de la empresa o de la persona',
    path: ['companyName'],
  });
export type CreateSalesProspectInput = z.infer<typeof CreateSalesProspectSchema>;

export const UpdateSalesLeadSchema = z.object({
  companyName: optText(160),
  contactName: optText(120),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal('')),
  phone: optText(30),
  city: optText(80),
  units: optText(40),
  facilities: optText(40),
  currentSoftware: optText(120),
  profile: optText(120),
});
export type UpdateSalesLeadInput = z.infer<typeof UpdateSalesLeadSchema>;

/** El comercial crea la cuenta de su prospecto (prueba estándar). */
export const SalesCreateTenantSchema = z.object({
  tenantName: z.string().trim().min(2).max(100),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().toLowerCase().email().max(320),
});
export type SalesCreateTenantInput = z.infer<typeof SalesCreateTenantSchema>;

/** Simulador de cuota del comercial (con el cliente si ya lo es). */
export const SalesSimulateQuoteSchema = z.object({
  planId: z.string().uuid(),
  cycle: z.enum(['monthly', 'yearly']).default('monthly'),
  addons: z
    .array(
      z.object({
        addonId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50).default(1),
      }),
    )
    .max(30)
    .default([]),
  couponCode: z.string().trim().max(60).optional(),
  tenantId: z.string().uuid().optional(),
});
export type SalesSimulateQuoteInput = z.infer<typeof SalesSimulateQuoteSchema>;

/** Un lead del comercial con su ficha de llamada. */
export interface SalesLeadDto extends PlatformLeadDto {
  salesProfile: SalesAccountProfileDto | null;
  /** Estado de su cuenta si ya la tiene (trial, active, past_due…). */
  tenantStatus: string | null;
}

export interface SalesLeadListDto {
  items: SalesLeadDto[];
  counts: Record<string, number>;
}

// ----------------------------------------------------------------- clientes

export interface SalesClientRowDto {
  leadId: string;
  tenantId: string;
  name: string;
  slug: string;
  /** trial · active · past_due · suspended · cancelled */
  status: string;
  pastDue: boolean;
  planName: string | null;
  /** Lo que aporta al mes (plan + extras). */
  monthly: number;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  healthScore: number | null;
  healthLevel: string | null;
  lastLoginAt: string | null;
  units: number;
  unitsLimit: number | null;
  contracts: number;
  addons: string[];
  firstPaidAt: string | null;
  salesSource: string | null;
  assignedAt: string | null;
  nextFollowup: { id: string; title: string; dueDate: string } | null;
  profile: SalesAccountProfileDto | null;
}

/** Lo que ve el comercial de la cuenta de un cliente (nunca sus inquilinos ni su facturación). */
export interface SalesClientSheetDto {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  pastDue: boolean;
  createdAt: string;
  planName: string | null;
  planSlug: string | null;
  billingMode: string | null;
  monthly: number;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  nextChargeAt: string | null;
  firstPaidAt: string | null;
  owner: { name: string; email: string; phone: string | null } | null;
  addons: {
    id: string;
    addonId: string;
    name: string;
    quantity: number;
    monthly: number;
    suspended: boolean;
  }[];
  usage: {
    units: number;
    unitsLimit: number | null;
    facilities: number;
    facilitiesLimit: number | null;
    users: number;
    usersLimit: number | null;
    contracts: number;
  };
  onboarding: { completed: number; total: number; pending: string[] };
  health: { score: number; level: string } | null;
  lastLoginAt: string | null;
  /** Funciones de pago que ha intentado usar (últimos 90 días). */
  featureInterest: { feature: string; label: string; count: number; lastAt: string }[];
  /** Lo que le podría vender (de Oportunidades). */
  opportunities: AdminAddonOpportunityDto[];
}

export interface SalesCadenceEnrollmentDto {
  id: string;
  cadenceId: string;
  cadenceName: string;
  status: 'active' | 'done' | 'stopped';
  startedAt: string;
  steps: { followupId: string; title: string; dueDate: string; done: boolean }[];
}

/** Ficha completa de una cuenta del comercial. */
export interface SalesAccountDto {
  lead: PlatformLeadDetailDto;
  profile: SalesAccountProfileDto | null;
  client: SalesClientSheetDto | null;
  cadence: SalesCadenceEnrollmentDto | null;
  /** Se registró sin el código y la dirección decide si es suya. */
  pendingAssignment: boolean;
}

/** Resumen para preparar la llamada. */
export interface SalesAccountSummaryDto {
  lines: string[];
  /** Resumen redactado con IA (null si no hay IA o no se ha pedido). */
  aiText: string | null;
  aiAvailable: boolean;
}

// ----------------------------------------------------------------- «Hoy»

export interface SalesTodayRowDto {
  leadId: string;
  tenantId: string | null;
  name: string;
  detail: string;
  /** Fecha relevante (fin de la prueba, alta, envío…). */
  date: string | null;
}

export interface SalesTodayDto {
  date: string;
  followups: {
    id: string;
    leadId: string;
    leadName: string;
    title: string;
    note: string | null;
    dueDate: string;
    overdue: boolean;
  }[];
  trialsEnding: SalesTodayRowDto[];
  pastDue: SalesTodayRowDto[];
  newSignups: SalesTodayRowDto[];
  stuckOnboarding: SalesTodayRowDto[];
  offersPending: SalesTodayRowDto[];
  noContact: SalesTodayRowDto[];
  /** Sus citas de hoy (pendientes), por hora. */
  appointments: SalesAppointmentDto[];
  kpis: {
    prospects: number;
    trials: number;
    customers: number;
    mrr: number;
    newClientsMonth: number;
    newMrrMonth: number;
    commissionMonth: number;
    target: { newClients: number; newMrr: number } | null;
  };
}

// -------------------------------------------------------------------- vender

export const SalesExtendTrialSchema = z.object({
  days: z.number().int().min(1).max(60),
  reason: z.string().trim().min(3).max(500),
});
export type SalesExtendTrialInput = z.infer<typeof SalesExtendTrialSchema>;

export const SalesAddonOfferSchema = z.object({
  addonId: z.string().uuid(),
  message: z.string().trim().max(2000).optional(),
  /** Dejarlo en prueba (uno por cliente, los días que marque la dirección). */
  trial: z.boolean().default(false),
  followupDays: z.number().int().min(0).max(60).default(3),
});
export type SalesAddonOfferInput = z.infer<typeof SalesAddonOfferSchema>;

/** Lo que un comercial puede pedir a la dirección para un cliente suyo. */
export const SalesApprovalRequestSchema = z.object({
  tenantId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  request: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('extend_trial'),
      payload: z.object({
        days: z.number().int().min(1).max(90),
        reason: z.string().trim().min(3).max(500),
      }),
    }),
    z.object({
      action: z.literal('change_plan'),
      payload: z.object({
        planSlug: z.string().trim().min(1).max(60),
        reason: z.string().trim().min(3).max(500),
      }),
    }),
    z.object({
      action: z.literal('assign_addon'),
      payload: z.object({
        addonId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50).default(1),
        priceMonthly: z.number().min(0).max(100_000).optional(),
        notes: z.string().trim().max(500).optional(),
      }),
    }),
  ]),
});
export type SalesApprovalRequestInput = z.infer<typeof SalesApprovalRequestSchema>;

export type SalesOfferDto = PlatformQuoteOfferDto;

// --------------------------------------------------------------- comisiones

export const SALES_COMMISSION_KINDS = [
  'revenue',
  'sale',
  'addon_sale',
  'concept',
  'adjustment',
  'tier',
  'bonus',
] as const;
export type SalesCommissionKind = (typeof SALES_COMMISSION_KINDS)[number];
export const SALES_COMMISSION_KIND_LABELS: Record<SalesCommissionKind, string> = {
  revenue: '% de lo cobrado',
  sale: 'Venta',
  addon_sale: 'Extra vendido',
  concept: 'Concepto',
  adjustment: 'Ajuste',
  tier: 'Tramo del mes',
  bonus: 'Bonus por objetivo',
};
export const SALES_COMMISSION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type SalesCommissionStatus = (typeof SALES_COMMISSION_STATUSES)[number];
export const SALES_COMMISSION_STATUS_LABELS: Record<SalesCommissionStatus, string> = {
  pending: 'Por aprobar',
  approved: 'Aprobada',
  rejected: 'Rechazada',
};

const money = z.number().min(0).max(100_000);

export const SalesSaleTierSchema = z.object({
  /** Ventas en el mes a partir de las que vale este fijo. */
  fromSales: z.number().int().min(2).max(500),
  /** Fijo por cada venta del mes al llegar al tramo. */
  amount: money,
});
export type SalesSaleTier = z.infer<typeof SalesSaleTierSchema>;

/** Fijo por venta del mes según los tramos (el más alto alcanzado o el normal). */
export function saleTierAmount(tiers: SalesSaleTier[], base: number, sales: number): number {
  let out = base;
  for (const t of tiers) if (sales >= t.fromSales && t.amount > out) out = t.amount;
  return out;
}

/** Lo que suma el tramo sobre el fijo normal: (fijo del tramo − normal) × ventas. */
export function saleTierExtra(tiers: SalesSaleTier[], base: number, sales: number): number {
  const amount = saleTierAmount(tiers, base, sales);
  return Math.round((amount - base) * sales * 100) / 100;
}

export const UpdateSalesCommissionPlanSchema = z.object({
  /** % de lo que pagan sus clientes (sin IVA). */
  revenuePct: z.number().min(0).max(100),
  /** Meses desde el primer pago del cliente en que cuenta el % (null = siempre). */
  revenueMonths: z.number().int().min(1).max(120).nullable(),
  /** Fijo por cada cliente que paga por primera vez. */
  perSaleAmount: money,
  /** Fijo por cada extra aprobado tras la venta. */
  perAddonAmount: money,
  notes: z.string().trim().max(2000).nullable().optional(),
  /** Meses que el cliente tiene que seguir para que cuente el fijo de la venta (null = sin garantía). */
  guaranteeMonths: z.number().int().min(1).max(24).nullable().optional(),
  /** Tramos: a partir de N ventas en el mes, cada venta de ese mes paga este fijo. */
  saleTiers: z.array(SalesSaleTierSchema).max(5).optional(),
  /** Bonus por cumplir el objetivo del mes (clientes y cuotas). */
  targetBonus: money.optional(),
});
export type UpdateSalesCommissionPlanInput = z.infer<typeof UpdateSalesCommissionPlanSchema>;

export const UpsertSalesCommissionConceptSchema = z.object({
  name: z.string().trim().min(2).max(120),
  amount: z.number().min(0.01).max(100_000),
  isActive: z.boolean().default(true),
});
export type UpsertSalesCommissionConceptInput = z.infer<typeof UpsertSalesCommissionConceptSchema>;

export interface SalesCommissionConceptDto {
  id: string;
  name: string;
  amount: number;
  isActive: boolean;
}

export interface SalesCommissionPlanDto {
  revenuePct: number;
  revenueMonths: number | null;
  perSaleAmount: number;
  perAddonAmount: number;
  notes: string | null;
  guaranteeMonths: number | null;
  saleTiers: SalesSaleTier[];
  targetBonus: number;
  concepts: SalesCommissionConceptDto[];
  updatedAt: string | null;
}

export interface SalesCommissionItemDto {
  id: string;
  repId: string;
  repName: string;
  /** null = del mes (tramo o bonus), no de un cliente. */
  tenantId: string | null;
  tenantName: string | null;
  kind: SalesCommissionKind;
  description: string;
  month: string;
  baseAmount: number | null;
  rate: number | null;
  amount: number;
  status: SalesCommissionStatus;
  settlementId: string | null;
  requestedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface SalesCommissionsDto {
  plan: SalesCommissionPlanDto;
  items: SalesCommissionItemDto[];
  totals: {
    /** Aprobadas y sin liquidar. */
    approvedUnsettled: number;
    /** Por aprobar. */
    pending: number;
    /** De este mes (aprobadas). */
    month: number;
    /** Ya liquidadas (total histórico). */
    settled: number;
  };
}

/** El comercial pide cobrar un concepto (p. ej. migración de datos) por un cliente. */
export const RequestSalesConceptSchema = z.object({
  tenantId: z.string().uuid(),
  conceptId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});
export type RequestSalesConceptInput = z.infer<typeof RequestSalesConceptSchema>;

/** La dirección añade un concepto o un ajuste a mano. */
export const CreateSalesCommissionItemSchema = z
  .object({
    repId: z.string().uuid(),
    tenantId: z.string().uuid(),
    kind: z.enum(['concept', 'adjustment']),
    conceptId: z.string().uuid().optional(),
    description: z.string().trim().max(200).optional(),
    /** Ajuste: importe con signo. Concepto: si no, el del concepto. */
    amount: z.number().min(-100_000).max(100_000).optional(),
  })
  .refine((v) => v.kind !== 'concept' || !!v.conceptId, {
    message: 'Elige el concepto',
    path: ['conceptId'],
  })
  .refine((v) => v.kind !== 'adjustment' || (v.amount != null && v.amount !== 0), {
    message: 'Pon el importe del ajuste',
    path: ['amount'],
  })
  .refine((v) => v.kind !== 'adjustment' || !!v.description, {
    message: 'Explica el ajuste',
    path: ['description'],
  });
export type CreateSalesCommissionItemInput = z.infer<typeof CreateSalesCommissionItemSchema>;

export const DecideSalesSchema = z.object({ note: z.string().trim().max(500).optional() });
export type DecideSalesInput = z.infer<typeof DecideSalesSchema>;

export const SALES_CLAIM_STATUS_LABELS: Record<SalesCommissionStatus, string> = {
  pending: 'Por aprobar',
  approved: 'Cuenta para su comisión',
  rejected: 'No cuenta',
};

export interface SalesAddonClaimDto {
  id: string;
  tenantId: string;
  tenantName: string;
  addonId: string;
  addonName: string;
  monthly: number;
  repId: string;
  repName: string;
  status: SalesCommissionStatus;
  partOfSale: boolean;
  repNote: string | null;
  /** Propuesta del comercial que incluía el extra. */
  fromOffer: boolean;
  decidedAt: string | null;
  decisionNote: string | null;
  assignedAt: string | null;
  createdAt: string;
}

export const SalesClaimNoteSchema = z.object({ repNote: z.string().trim().max(500) });
export type SalesClaimNoteInput = z.infer<typeof SalesClaimNoteSchema>;

export interface SalesSettlementDto {
  id: string;
  repId: string;
  repName: string;
  month: string;
  total: number;
  itemsCount: number;
  status: 'pending_payment' | 'paid';
  paidAt: string | null;
  note: string | null;
  /** Cuándo confirmó el comercial que lo ha recibido. */
  receivedAt: string | null;
  receivedNote: string | null;
  createdAt: string;
}

/** El comercial confirma que ha recibido la liquidación (en efectivo). */
export const AcknowledgeSalesSettlementSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type AcknowledgeSalesSettlementInput = z.infer<typeof AcknowledgeSalesSettlementSchema>;

// --------------------------------------------------------------- previsión

export interface SalesForecastMonthDto {
  month: string;
  amount: number;
}

/** Lo que cobrará el comercial por el % de sus clientes de pago los próximos meses. */
export interface SalesForecastDto {
  months: SalesForecastMonthDto[];
  total: number;
  /** Clientes de pago que cuentan. */
  clients: number;
  revenuePct: number;
}

export interface SalesTeamForecastDto {
  months: string[];
  reps: { repId: string; repName: string; amounts: number[]; total: number }[];
  totals: number[];
  total: number;
}

/**
 * Previsión del % de un comercial: por cada cliente, lo que paga al mes (sin
 * IVA) por el % mientras dure su plazo desde el primer pago.
 */
export function forecastRevenueCommission(args: {
  clients: { monthlyNet: number; firstPaidMonth: string }[];
  revenuePct: number;
  /** Meses que cuenta el % desde el primer pago (null = siempre). */
  revenueMonths: number | null;
  months: string[];
}): number[] {
  const index = (m: string) => {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    return y * 12 + (mo - 1);
  };
  return args.months.map((m) => {
    let sum = 0;
    for (const c of args.clients) {
      const since = index(m) - index(c.firstPaidMonth);
      if (since < 0) continue;
      if (args.revenueMonths != null && since >= args.revenueMonths) continue;
      sum += revenueCommission(c.monthlyNet, args.revenuePct);
    }
    return Math.round(sum * 100) / 100;
  });
}

// -------------------------------------------------------------- comparativa

export interface SalesTeamComparisonRowDto {
  repId: string;
  repName: string;
  isActive: boolean;
  /** Prospectos que se le asignaron en el periodo. */
  leads: number;
  /** Cuentas suyas que empezaron la prueba en el periodo. */
  trials: number;
  /** Clientes que pagaron por primera vez en el periodo. */
  wins: number;
  /** Ventas sobre pruebas del periodo (%). */
  conversionPct: number | null;
  /** Días de media desde el alta hasta el primer pago. */
  avgDaysToClose: number | null;
  /** Clientes suyos que se dieron de baja en el periodo. */
  churned: number;
  /** Lo que aportan al mes sus clientes de pago hoy. */
  mrr: number;
  /** Comisiones aprobadas del periodo. */
  commission: number;
}

export interface SalesTeamComparisonDto {
  months: number;
  from: string;
  to: string;
  rows: SalesTeamComparisonRowDto[];
}

export const CreateSalesSettlementSchema = z.object({
  repId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Mes AAAA-MM'),
  note: z.string().trim().max(500).optional(),
});
export type CreateSalesSettlementInput = z.infer<typeof CreateSalesSettlementSchema>;

/**
 * Comisión de un cobro: % sobre la parte del plan y de los extras que cuentan
 * (sin IVA y sin lo devuelto). Redondeo a céntimos.
 */
export function revenueCommission(base: number, pct: number): number {
  if (!(base > 0) || !(pct > 0)) return 0;
  return Math.round(base * pct) / 100;
}

// ---------------------------------------------------------------- objetivos

export const UpsertSalesTargetSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Mes AAAA-MM'),
  newClients: z.number().int().min(0).max(1000),
  newMrr: z.number().min(0).max(1_000_000),
});
export type UpsertSalesTargetInput = z.infer<typeof UpsertSalesTargetSchema>;

export interface SalesTargetDto {
  month: string;
  newClients: number;
  newMrr: number;
  /** Lo conseguido en ese mes. */
  achieved: { newClients: number; newMrr: number };
}

// ---------------------------------------------------------------- equipo

export interface SalesRepSummaryDto {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
  twoFactorEnabled: boolean;
  /** false = la dirección le ha quitado la verificación en dos pasos obligatoria. */
  twoFactorRequired: boolean;
  lastLoginAt: string | null;
  salesCode: string | null;
  phone: string | null;
  whatsapp: string | null;
  bookingUrl: string | null;
  prospects: number;
  trials: number;
  customers: number;
  /** Lo que pagan al mes sus clientes de pago. */
  mrr: number;
  newClientsMonth: number;
  newMrrMonth: number;
  /** Llamadas, correos y notas de los últimos 7 días. */
  activities7d: number;
  /** De sus pruebas acabadas en 90 días, las que pagan. */
  conversionPct: number | null;
  commissionMonth: number;
  target: SalesTargetDto | null;
  pendingClaims: number;
}

export interface SalesTeamDto {
  reps: SalesRepSummaryDto[];
  /** Cuentas de comerciales desactivados (pendientes de reasignar). */
  orphanAccounts: number;
  pending: { claims: number; concepts: number };
}

export const CreateSalesRepSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional(),
  whatsapp: z.string().trim().max(30).optional(),
  bookingUrl: z.string().trim().url().max(500).optional().or(z.literal('')),
  salesCode: z.string().trim().max(12).optional(),
});
export type CreateSalesRepInput = z.infer<typeof CreateSalesRepSchema>;

export const UpdateSalesRepSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  whatsapp: z.string().trim().max(30).nullable().optional(),
  bookingUrl: z.string().trim().url().max(500).nullable().optional().or(z.literal('')),
  salesCode: z.string().trim().max(12).optional(),
  /** false = puede entrar sin la verificación en dos pasos. */
  twoFactorRequired: z.boolean().optional(),
});
export type UpdateSalesRepInput = z.infer<typeof UpdateSalesRepSchema>;

/** Lo que el comercial puede cambiar de sí mismo. */
export const UpdateSalesMeSchema = z.object({
  phone: z.string().trim().max(30).nullable().optional(),
  whatsapp: z.string().trim().max(30).nullable().optional(),
  bookingUrl: z.string().trim().url().max(500).nullable().optional().or(z.literal('')),
});
export type UpdateSalesMeInput = z.infer<typeof UpdateSalesMeSchema>;

export interface SalesRepProfileDto {
  id: string;
  fullName: string;
  email: string;
  salesCode: string;
  phone: string | null;
  whatsapp: string | null;
  bookingUrl: string | null;
  signupUrl: string;
  landingUrl: string;
  extraTrialDays: number;
  limits: { trialExtensionDays: number; addonTrialDays: number };
}

export interface SalesRepDetailDto extends SalesRepSummaryDto {
  plan: SalesCommissionPlanDto;
  targets: SalesTargetDto[];
  signupUrl: string | null;
}

/** Cuenta que se ha registrado sin el código de su comercial: la dirección decide. */
export interface SalesPendingAssignmentDto {
  leadId: string;
  tenantId: string;
  tenantName: string;
  /** Comercial que llevaba el prospecto. */
  repId: string;
  repName: string;
  /** Cuándo se registró. */
  registeredAt: string | null;
}

/** La cartera de un comercial (para la dirección). */
export interface SalesRepAccountsDto {
  leads: SalesLeadDto[];
  clients: SalesClientRowDto[];
}

export const AssignSalesAccountSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    tenantId: z.string().uuid().optional(),
    /** null = la cuenta deja de tener comercial. */
    repId: z.string().uuid().nullable(),
  })
  .refine((v) => !!(v.leadId || v.tenantId), {
    message: 'Indica la cuenta',
    path: ['tenantId'],
  });
export type AssignSalesAccountInput = z.infer<typeof AssignSalesAccountSchema>;

export const ReassignSalesPortfolioSchema = z.object({
  toRepId: z.string().uuid().nullable(),
  scope: z.enum(['all', 'prospects', 'clients']).default('all'),
});
export type ReassignSalesPortfolioInput = z.infer<typeof ReassignSalesPortfolioSchema>;

export interface SalesAccountRepDto {
  repId: string | null;
  repName: string | null;
  repActive: boolean;
  source: string | null;
  assignedAt: string | null;
  leadId: string | null;
  profile: SalesAccountProfileDto | null;
  history: {
    repName: string;
    source: string;
    startedAt: string;
    endedAt: string | null;
    endedReason: string | null;
  }[];
}

export const SALES_SOURCE_LABELS: Record<string, string> = {
  link: 'Enlace o QR del comercial',
  code: 'Código escrito al registrarse',
  created: 'Cuenta creada por el comercial',
  lead: 'Prospecto del comercial',
  manual: 'Asignada por la dirección',
  import: 'Importado por el comercial',
};

export interface PlatformSalesSettingsDto {
  signupExtraTrialDays: number;
  leadReleaseDays: number;
  repTrialExtensionDays: number;
  repAddonTrialDays: number;
  lifecycleFromRep: boolean;
  demo: {
    tenantId: string | null;
    tenantName: string | null;
    tenantSlug: string | null;
    resetEnabled: boolean;
    resetAt: string | null;
  };
}

export const UpdatePlatformSalesSettingsSchema = z.object({
  signupExtraTrialDays: z.number().int().min(0).max(90).optional(),
  leadReleaseDays: z.number().int().min(0).max(730).optional(),
  repTrialExtensionDays: z.number().int().min(0).max(90).optional(),
  repAddonTrialDays: z.number().int().min(0).max(90).optional(),
  lifecycleFromRep: z.boolean().optional(),
  demoResetEnabled: z.boolean().optional(),
});
export type UpdatePlatformSalesSettingsInput = z.infer<typeof UpdatePlatformSalesSettingsSchema>;

// --------------------------------------------------------------- materiales

export const SALES_MATERIAL_KINDS = ['file', 'link', 'note'] as const;
export type SalesMaterialKind = (typeof SALES_MATERIAL_KINDS)[number];

export const SALES_MATERIAL_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export const SALES_MATERIAL_MAX_BYTES = 20 * 1024 * 1024;

export const UpsertSalesMaterialSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(500).optional().or(z.literal('')),
    kind: z.enum(SALES_MATERIAL_KINDS),
    url: z.string().trim().url().max(1000).optional().or(z.literal('')),
    fileKey: z.string().trim().max(500).optional(),
    fileName: z.string().trim().max(200).optional(),
    body: z.string().trim().max(20_000).optional().or(z.literal('')),
    position: z.number().int().min(0).max(1000).default(0),
  })
  .refine((v) => v.kind !== 'link' || !!v.url, { message: 'Pon el enlace', path: ['url'] })
  // El fichero se exige al crear; al editar, sin `fileKey` se conserva el que tenía.
  .refine((v) => v.kind !== 'note' || !!v.body, { message: 'Escribe el texto', path: ['body'] });
export type UpsertSalesMaterialInput = z.infer<typeof UpsertSalesMaterialSchema>;

export const SalesMaterialUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(SALES_MATERIAL_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(SALES_MATERIAL_MAX_BYTES),
});
export type SalesMaterialUploadInput = z.infer<typeof SalesMaterialUploadSchema>;

export interface SalesMaterialDto {
  id: string;
  title: string;
  description: string | null;
  kind: SalesMaterialKind;
  url: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  body: string | null;
  position: number;
  updatedAt: string;
}

// ---------------------------------------------------------------- plantillas

export const SALES_TEMPLATE_CHANNELS = ['email', 'whatsapp'] as const;
export type SalesTemplateChannel = (typeof SALES_TEMPLATE_CHANNELS)[number];

export const UpsertSalesTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    channel: z.enum(SALES_TEMPLATE_CHANNELS),
    stage: z.string().trim().max(30).nullable().optional(),
    subject: z.string().trim().max(200).nullable().optional(),
    body: z.string().trim().min(2).max(10_000),
    position: z.number().int().min(0).max(1000).default(0),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.channel !== 'email' || !!v.subject, {
    message: 'Pon el asunto',
    path: ['subject'],
  });
export type UpsertSalesTemplateInput = z.infer<typeof UpsertSalesTemplateSchema>;

export interface SalesTemplateDto {
  id: string;
  name: string;
  channel: SalesTemplateChannel;
  stage: string | null;
  subject: string | null;
  body: string;
  position: number;
  isActive: boolean;
}

/** Variables de las plantillas, con un ejemplo para la vista previa. */
export const SALES_TEMPLATE_VARIABLES: Record<string, string> = {
  nombre: 'Nombre de la persona de contacto',
  empresa: 'Nombre de la empresa',
  comercial: 'Tu nombre',
  telefono_comercial: 'Tu teléfono',
  email_comercial: 'Tu email',
  agenda: 'Tu enlace para reservar una demo',
  enlace_registro: 'Tu enlace de registro (con tu código)',
  codigo: 'Tu código',
};

/** Sustituye `{variable}`; una variable sin valor desaparece. */
export function renderSalesTemplate(
  text: string,
  vars: Record<string, string | null | undefined>,
): string {
  return text.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    if (!(key in SALES_TEMPLATE_VARIABLES)) return match;
    return (vars[key] ?? '').trim();
  });
}

// ---------------------------------------------------------------- cadencias

export const SalesCadenceStepSchema = z.object({
  /** Días desde que se empieza (0 = hoy). */
  day: z.number().int().min(0).max(180),
  channel: z.enum(['call', 'email', 'whatsapp']),
  title: z.string().trim().min(2).max(160),
});
export type SalesCadenceStep = z.infer<typeof SalesCadenceStepSchema>;

export const UpsertSalesCadenceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  steps: z.array(SalesCadenceStepSchema).min(1).max(20),
  isActive: z.boolean().default(true),
});
export type UpsertSalesCadenceInput = z.infer<typeof UpsertSalesCadenceSchema>;

export interface SalesCadenceDto {
  id: string;
  name: string;
  description: string | null;
  steps: SalesCadenceStep[];
  isActive: boolean;
}

export const EnrollSalesCadenceSchema = z.object({ cadenceId: z.string().uuid() });
export type EnrollSalesCadenceInput = z.infer<typeof EnrollSalesCadenceSchema>;

export const SALES_CADENCE_CHANNEL_LABELS: Record<SalesCadenceStep['channel'], string> = {
  call: 'Llamada',
  email: 'Correo',
  whatsapp: 'WhatsApp',
};

/** Fechas (AAAA-MM-DD) de cada paso a partir de `start` (AAAA-MM-DD). */
export function cadenceDueDates(start: string, steps: { day: number }[]): string[] {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  return steps.map((s) => {
    const date = new Date(Date.UTC(y, m - 1, d + s.day));
    return date.toISOString().slice(0, 10);
  });
}

// ----------------------------------------------------------------- importar

export const SalesImportSchema = z.object({
  csv: z.string().min(1).max(500_000),
  /** false = solo revisar. */
  commit: z.boolean().default(false),
});
export type SalesImportInput = z.infer<typeof SalesImportSchema>;

export interface SalesImportRowDto {
  line: number;
  companyName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  /** Ya existe: no se importa. */
  duplicate: boolean;
  error: string | null;
}

export interface SalesImportResultDto {
  rows: SalesImportRowDto[];
  valid: number;
  duplicates: number;
  errors: number;
  /** Creados (solo al confirmar). */
  created: number;
}

// --------------------------------------------------------------------- demo

export interface SalesDemoStatusDto {
  available: boolean;
  tenantName: string | null;
  resetAt: string | null;
}

// --------------------------------------------------- panel del tenant (cliente)

/** «Tu comercial» en el panel del cliente. */
export interface TenantSalesRepDto {
  fullName: string;
  email: string;
  phone: string | null;
  whatsapp: string | null;
  bookingUrl: string | null;
}

/** Mes en curso en hora de España (AAAA-MM). */
export function salesMonth(d: Date = new Date()): string {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7);
}
