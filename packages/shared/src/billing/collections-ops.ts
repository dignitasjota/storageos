import { z } from 'zod';

/**
 * Cobros del mes, impagos y planes de pago del operador.
 */

/** Cómo se cobra una factura: sola (tarjeta/adeudo), remesa SEPA o a mano. */
export type ExpectedVia = 'auto' | 'remittance' | 'manual';

export interface MonthCollectionsBucketDto {
  count: number;
  amount: number;
}

export interface MonthCollectionsItemDto {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string | null;
  customerName: string;
  amount: number;
  date: string;
  reason: string | null;
}

/** `GET /collections-month?month=YYYY-MM`. */
export interface MonthCollectionsDto {
  month: string;
  /** Facturas que vencen en el mes, por vía de cobro. */
  expected: Record<ExpectedVia, MonthCollectionsBucketDto> & { total: MonthCollectionsBucketDto };
  /** De lo que vence en el mes, lo que sigue sin cobrar. */
  outstanding: MonthCollectionsBucketDto;
  /** Cobros recibidos en el mes (de cualquier factura), por forma de pago. */
  collected: MonthCollectionsBucketDto & { byMethod: Record<string, number> };
  failed: MonthCollectionsBucketDto & { items: MonthCollectionsItemDto[] };
  returned: MonthCollectionsBucketDto & { items: MonthCollectionsItemDto[] };
  /** Lo que se cobra a mano y sigue pendiente (para llamar o recordar). */
  manualPending: MonthCollectionsItemDto[];
  weeks: { label: string; from: string; to: string; expected: number; collected: number }[];
}

export type PaymentPlanStatus = 'active' | 'completed' | 'broken' | 'cancelled';

export interface PaymentPlanInstallmentDto {
  dueDate: string;
  amount: number;
  /** Lo cubierto de esta cuota con lo cobrado hasta hoy. */
  paid: number;
  status: 'paid' | 'partial' | 'pending' | 'late';
}

export interface PaymentPlanDto {
  id: string;
  customerId: string;
  customerName: string;
  status: PaymentPlanStatus;
  invoiceIds: string[];
  invoiceNumbers: string[];
  totalAmount: number;
  /** Cobrado de esas facturas desde que se creó el plan. */
  paidSoFar: number;
  installments: PaymentPlanInstallmentDto[];
  graceDays: number;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  completedAt: string | null;
  brokenAt: string | null;
  cancelledAt: string | null;
}

export const PaymentPlanFrequencyEnum = z.enum(['weekly', 'biweekly', 'monthly']);
export type PaymentPlanFrequency = z.infer<typeof PaymentPlanFrequencyEnum>;

export const CreatePaymentPlanSchema = z.object({
  customerId: z.string().uuid(),
  /** Sin facturas: todas las vencidas o emitidas del inquilino. */
  invoiceIds: z.array(z.string().uuid()).max(50).optional(),
  installmentsCount: z.number().int().min(2).max(24),
  firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  frequency: PaymentPlanFrequencyEnum.default('monthly'),
  graceDays: z.number().int().min(0).max(30).default(7),
  notes: z.string().trim().max(1000).optional(),
  /** Enviar al inquilino el calendario de cuotas por correo. */
  notifyCustomer: z.boolean().default(true),
});
export type CreatePaymentPlanInput = z.infer<typeof CreatePaymentPlanSchema>;

export interface ArrearsStepDto {
  label: string;
  date: string;
}

/** Una fila de `GET /arrears`: un inquilino con deuda vencida. */
export interface ArrearsRowDto {
  customerId: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  amount: number;
  since: string;
  days: number;
  invoiceIds: string[];
  invoiceCount: number;
  /** Hay un cobro automático posible (tarjeta o adeudo guardados). */
  chargeable: boolean;
  /** Va en la remesa SEPA (mandato activo). */
  sepaMandate: boolean;
  lastReminderAt: string | null;
  lateFeeApplied: boolean;
  accessBlocked: boolean;
  nextStep: ArrearsStepDto | null;
  plan: { id: string; status: PaymentPlanStatus; nextDue: string | null } | null;
  collectionsCase: { id: string; status: string } | null;
  /** Contrato vivo (para abrir el expediente). */
  contractId: string | null;
  units: string[];
}

export interface ArrearsDto {
  totalAmount: number;
  customers: number;
  /** Por antigüedad: 0-30, 31-60, 61-90, +90 días. */
  aging: { label: string; amount: number; count: number }[];
  rows: ArrearsRowDto[];
}

/** Lo que se ha pagado de las cuotas, en orden, con lo cobrado hasta hoy. */
export function allocateInstallments(
  installments: { dueDate: string; amount: number }[],
  paid: number,
  today: string,
  graceDays: number,
): PaymentPlanInstallmentDto[] {
  let left = Math.round(paid * 100);
  return installments.map((i) => {
    const cents = Math.round(i.amount * 100);
    const covered = Math.max(0, Math.min(cents, left));
    left -= covered;
    const graceEnd = addDays(i.dueDate, graceDays);
    const status: PaymentPlanInstallmentDto['status'] =
      covered >= cents ? 'paid' : today > graceEnd ? 'late' : covered > 0 ? 'partial' : 'pending';
    return { dueDate: i.dueDate, amount: i.amount, paid: covered / 100, status };
  });
}

/** Reparte `total` en `count` cuotas (la última absorbe los céntimos). */
export function buildInstallments(
  total: number,
  count: number,
  firstDueDate: string,
  frequency: PaymentPlanFrequency,
): { dueDate: string; amount: number }[] {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  return Array.from({ length: count }, (_, k) => ({
    dueDate:
      frequency === 'monthly'
        ? addMonths(firstDueDate, k)
        : addDays(firstDueDate, k * (frequency === 'weekly' ? 7 : 14)),
    amount: (k === count - 1 ? cents - base * (count - 1) : base) / 100,
  }));
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
