import { z } from 'zod';

/** `YYYY-MM-DD` que existe en el calendario (no admite el 31 de febrero). */
const realDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Fecha no válida');

/** Cierre de caja del día: el operador introduce el efectivo contado + notas. */
export const CloseCashSchema = z.object({
  date: realDate,
  countedCash: z.number().nonnegative().finite().max(10_000_000),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  /** Local del arqueo; ausente = caja global del tenant. */
  facilityId: z.string().uuid().optional(),
});
export type CloseCashInput = z.infer<typeof CloseCashSchema>;

/** Reabrir un cierre para registrar un movimiento de ese día. */
export const ReopenCashClosureSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});
export type ReopenCashClosureInput = z.infer<typeof ReopenCashClosureSchema>;
