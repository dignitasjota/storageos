/**
 * Pagos de los tenants a TrasterOS vistos por el super admin: estado de cuenta
 * de un tenant, cobros pendientes de todos y calendario de cobros.
 */

export type AdminChargeMethod = 'stripe' | 'sepa' | 'redsys' | 'manual';

export interface AdminChargeLineDto {
  label: string;
  /** Importe a cobrar (con IVA si los precios van +IVA). */
  amount: number;
}

/** Un cargo previsto: la cuota del plan (con lo que lleva) o un extra aparte. */
export interface AdminScheduledChargeDto {
  date: string;
  method: AdminChargeMethod;
  lines: AdminChargeLineDto[];
  total: number;
}

export interface AdminDunningStepDto {
  step: 'reminder_1' | 'reminder_2' | 'suspend';
  label: string;
  /** Día en que toca (o tocó). */
  date: string;
  /** Fecha en que se hizo, o null si aún no. */
  doneAt: string | null;
}

/** Deuda de la suscripción: desde cuándo, cuánto y por dónde va el escalado. */
export interface AdminOverdueDto {
  since: string;
  days: number;
  /** Lo que debe: la cuota por cada periodo vencido sin pagar. */
  amount: number;
  /** Cuotas vencidas sin pagar (1 si solo debe la última). */
  periods: number;
  /** Importe de una cuota. */
  periodAmount: number;
  /** Pasos del escalado automático (vacío si está apagado). */
  steps: AdminDunningStepDto[];
  /** El último adeudo SEPA se devolvió. */
  sepaBounced: boolean;
  /** Hay un adeudo SEPA en el banco: no se recuerda ni se suspende mientras tanto. */
  sepaInProgress: boolean;
}

export type AdminAccountEventKind =
  | 'payment'
  | 'failed'
  | 'refund'
  | 'invoice'
  | 'credit_note'
  | 'bounce';

export interface AdminAccountEventDto {
  date: string;
  kind: AdminAccountEventKind;
  label: string;
  amount: number;
  /** Detalle (método, periodo, motivo). */
  detail: string | null;
}

/** Estado de cuenta de un tenant (`GET /admin/tenants/:id/account`). */
export interface AdminTenantAccountDto {
  tenantStatus: string;
  subscriptionStatus: string | null;
  billingMode: AdminChargeMethod | null;
  billingExempt: boolean;
  /** Precios con IVA incluido o +IVA (los importes ya llevan el IVA si toca). */
  pricesIncludeVat: boolean;
  cycle: 'monthly' | 'yearly' | null;
  periodEnd: string | null;
  /** Próximo cargo de la cuota (null si es exenta, en prueba o cancelada). */
  nextCharge: AdminScheduledChargeDto | null;
  /** Extras que se cobran aparte, con su fecha. */
  addonCharges: AdminScheduledChargeDto[];
  overdue: AdminOverdueDto | null;
  /** Pagado en los últimos 12 meses (neto de devoluciones). */
  paid12m: number;
  history: AdminAccountEventDto[];
}

export type AdminReceivableKind = 'subscription' | 'addon';

/** Un cobro pendiente de un tenant (`GET /admin/billing/receivables`). */
export interface AdminReceivableDto {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  kind: AdminReceivableKind;
  concept: string;
  amount: number;
  method: AdminChargeMethod;
  since: string;
  days: number;
  /** Solo los de la cuota. */
  overdue: AdminOverdueDto | null;
  /** Extra cobrado aparte (para «Cobrar»). */
  tenantAddonId: string | null;
}

export interface AdminReceivablesDto {
  total: number;
  items: AdminReceivableDto[];
}

/** Un cargo del calendario (`GET /admin/billing/calendar`). */
export interface AdminCalendarChargeDto {
  date: string;
  tenantId: string;
  tenantName: string;
  method: AdminChargeMethod;
  concept: string;
  amount: number;
  /** Futuro: previsto. Pasado: cobrado, fallido o devuelto. */
  state: 'scheduled' | 'paid' | 'failed' | 'bounced';
}

export interface AdminBillingCalendarDto {
  from: string;
  to: string;
  pricesIncludeVat: boolean;
  charges: AdminCalendarChargeDto[];
  /** Totales previstos por método en el periodo futuro. */
  scheduledByMethod: Record<AdminChargeMethod, number>;
}
