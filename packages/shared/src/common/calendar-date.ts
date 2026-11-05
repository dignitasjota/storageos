import { z } from 'zod';

/** Día real del calendario (YYYY-MM-DD): rechaza cosas como 2026-13-45 o 2026-02-31. */
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'La fecha no existe');
