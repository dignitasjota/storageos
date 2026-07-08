import { z } from 'zod';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

/** Cierre de caja del día: el operador introduce el efectivo contado + notas. */
export const CloseCashSchema = z.object({
  date: dateOnly,
  countedCash: z.number().nonnegative().finite(),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  /** Local del arqueo; ausente = caja global del tenant. */
  facilityId: z.string().uuid().optional(),
});
export type CloseCashInput = z.infer<typeof CloseCashSchema>;
