import { z } from 'zod';

/** `YYYY-MM-DD` que existe en el calendario (no admite el 31 de febrero). */
const realDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Fecha no válida');

/** Billetes y monedas en euros, en céntimos (de mayor a menor). */
export const CASH_DENOMINATIONS = [
  50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1,
] as const;

/** «50 €», «2 €», «0,50 €», «0,01 €». */
export function denominationLabel(cents: number): string {
  return cents >= 100 ? `${cents / 100} €` : `0,${String(cents).padStart(2, '0')} €`;
}

/** Recuento por billetes y monedas: { "<céntimos>": unidades }. */
export const CashDenominationsSchema = z
  .record(z.string(), z.number().int().min(0).max(100_000))
  .refine(
    (d) =>
      Object.keys(d).every((k) => (CASH_DENOMINATIONS as readonly number[]).includes(Number(k))),
    'Billete o moneda no válido',
  );
export type CashDenominations = z.infer<typeof CashDenominationsSchema>;

/** Total del recuento, en céntimos. */
export function denominationsTotalCents(d: CashDenominations): number {
  return Object.entries(d).reduce((sum, [k, n]) => sum + Number(k) * n, 0);
}

/** Cierre de caja del día: el operador introduce el efectivo contado + notas. */
export const CloseCashSchema = z.object({
  date: realDate,
  countedCash: z.number().nonnegative().finite().max(10_000_000),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  /** Local del arqueo; ausente = caja global del tenant. */
  facilityId: z.string().uuid().optional(),
  /** Recuento por billetes y monedas; si viene, tiene que sumar lo contado. */
  denominations: CashDenominationsSchema.optional(),
});
export type CloseCashInput = z.infer<typeof CloseCashSchema>;

/** Reabrir un cierre para registrar un movimiento de ese día. */
export const ReopenCashClosureSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});
export type ReopenCashClosureInput = z.infer<typeof ReopenCashClosureSchema>;

/**
 * Lo que entra o sale del cajón sin ser un cobro: el fondo con el que se abre,
 * el cambio que se trae y lo que se lleva al banco.
 */
export const CashMovementKindEnum = z.enum(['opening_float', 'change_in', 'bank_withdrawal']);
/** Los que se apuntan a mano en la caja. */
export type CashManualMovementKind = z.infer<typeof CashMovementKindEnum>;
/** Además, el pago en efectivo de un gasto (se apunta y se quita desde Gastos). */
export type CashMovementKind = CashManualMovementKind | 'expense_payment';

export const CASH_MOVEMENT_LABELS: Record<CashMovementKind, string> = {
  opening_float: 'Fondo de apertura',
  change_in: 'Entrada de cambio',
  bank_withdrawal: 'Retirada al banco',
  expense_payment: 'Pago de un gasto',
};

/** +1 si entra en el cajón, −1 si sale. */
export const CASH_MOVEMENT_SIGN: Record<CashMovementKind, 1 | -1> = {
  opening_float: 1,
  change_in: 1,
  bank_withdrawal: -1,
  expense_payment: -1,
};

export const CreateCashMovementSchema = z.object({
  date: realDate,
  /** Local de la caja; ausente = caja de toda la empresa. */
  facilityId: z.string().uuid().optional(),
  kind: CashMovementKindEnum,
  amount: z.number().positive().finite().max(1_000_000),
  notes: z.string().trim().max(300).optional(),
});
export type CreateCashMovementInput = z.infer<typeof CreateCashMovementSchema>;
