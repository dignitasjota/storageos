import { z } from 'zod';

/**
 * Desistimiento de los contratos que un particular firma a distancia (art. 102
 * y siguientes del texto refundido de la Ley General para la Defensa de los
 * Consumidores y Usuarios, TRLGDCU).
 */

/** Días naturales para desistir sin dar explicaciones (art. 104). */
export const WITHDRAWAL_DAYS = 14;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

function parseYmd(ymd: string): Date {
  return new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Días naturales entre dos fechas, contando las dos. */
function daysInclusive(from: string, to: string): number {
  return Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86_400_000) + 1;
}

/**
 * Último día para desistir: el plazo empieza el día siguiente a la firma y
 * dura 14 días naturales (firmado el 11 → hasta el 25, incluido).
 */
export function withdrawalDeadline(signedOn: string): string {
  const d = parseYmd(signedOn);
  d.setUTCDate(d.getUTCDate() + WITHDRAWAL_DAYS);
  return toYmd(d);
}

/**
 * El alquiler empieza antes de que acabe el plazo: para empezar ya hay que
 * pedirlo expresamente (art. 98.8). Sin esa petición, quien desiste no paga
 * los días que haya tenido el trastero (art. 108.4).
 */
export function needsImmediateStartRequest(args: { startDate: string; signedOn: string }): boolean {
  return args.startDate.slice(0, 10) <= withdrawalDeadline(args.signedOn);
}

/** Días que ha tenido el trastero hasta que comunicó el desistimiento (ese día incluido). */
export function withdrawalUsedDays(args: { startDate: string; communicatedOn: string }): number {
  if (args.communicatedOn < args.startDate) return 0;
  return daysInclusive(args.startDate, args.communicatedOn);
}

/**
 * Céntimos que se queda el arrendador de un pago que cubre `[periodStart,
 * periodEnd]`: la parte proporcional a los días usados dentro de ese periodo,
 * solo si pidió empezar antes de que acabara el plazo (art. 108.3). Nunca más
 * de lo pagado.
 */
export function withdrawalKeptCents(args: {
  paidCents: number;
  periodStart: string;
  periodEnd: string;
  startDate: string;
  communicatedOn: string;
  immediateStartRequested: boolean;
}): number {
  if (!args.immediateStartRequested || args.paidCents <= 0) return 0;
  const from = args.startDate > args.periodStart ? args.startDate : args.periodStart;
  if (args.communicatedOn < from) return 0;
  const to = args.communicatedOn < args.periodEnd ? args.communicatedOn : args.periodEnd;
  const periodDays = daysInclusive(args.periodStart, args.periodEnd);
  if (periodDays <= 0) return 0;
  const used = daysInclusive(from, to);
  return Math.min(args.paidCents, Math.round((args.paidCents * used) / periodDays));
}

/** Por qué no se puede desistir (o null si se puede). */
export const WithdrawalBlockReasonEnum = z.enum([
  /** El contrato no se firmó a distancia por un particular. */
  'not_applicable',
  /** Han pasado los 14 días. */
  'deadline_passed',
  /** Aún no está firmado (un borrador se cancela sin más). */
  'not_signed',
  /** Reserva antes de la apertura: se cancela como reserva. */
  'pre_opening',
  /** Ya terminado, cancelado o desistido. */
  'closed',
]);
export type WithdrawalBlockReason = z.infer<typeof WithdrawalBlockReasonEnum>;

/** Lo que pasaría al desistir (vista previa para el inquilino y para el equipo). */
export interface ContractWithdrawalDto {
  allowed: boolean;
  reason: WithdrawalBlockReason | null;
  /** Último día para desistir (YYYY-MM-DD), si el contrato lo tiene. */
  deadline: string | null;
  /** Día en que se comunica el desistimiento. */
  communicatedOn: string;
  /** Pidió empezar antes de que acabara el plazo: paga los días usados. */
  immediateStartRequested: boolean;
  /** Días que ha tenido el trastero hasta ese día. */
  usedDays: number;
  /** Lo pagado de las cuotas (con IVA), lo que se queda el arrendador y lo que se devuelve. */
  rentPaid: number;
  rentKept: number;
  rentRefund: number;
  /** Fianza cobrada, que se devuelve entera. */
  depositRefund: number;
}

export const WithdrawContractSchema = z.object({
  /** Día en que el inquilino comunicó el desistimiento (por defecto, hoy). */
  communicatedOn: dateOnly.optional(),
  /** Cómo lo comunicó o cualquier otra nota (constancia). */
  note: z.string().trim().max(500).optional(),
});
export type WithdrawContractInput = z.infer<typeof WithdrawContractSchema>;
