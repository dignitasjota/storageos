import { z } from 'zod';

import { TaskPriorityEnum, TaskTypeEnum } from '../operations/schemas';

// ============================================================================
// Mantenimiento recurrente (plantillas que generan tareas)
// ============================================================================

export const MaintenanceFreqEnum = z.enum(['daily', 'weekly', 'monthly']);
export type MaintenanceFreqValue = z.infer<typeof MaintenanceFreqEnum>;

/** Punto del checklist de una plantilla (ronda). */
export const ChecklistTemplateItemSchema = z.object({
  label: z.string().trim().min(1).max(200),
});
export type ChecklistTemplateItem = z.infer<typeof ChecklistTemplateItemSchema>;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

export const CreateMaintenancePlanSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional().or(z.literal('')),
    type: TaskTypeEnum.default('maintenance'),
    priority: TaskPriorityEnum.default('normal'),
    facilityId: z.string().uuid().optional(),
    assignedToUserId: z.string().uuid().optional(),
    freq: MaintenanceFreqEnum,
    /** Cada N (días si daily, meses si monthly). Para weekly se ignora (siempre semanal). */
    interval: z.number().int().min(1).max(60).default(1),
    /** Solo weekly: días de la semana (0=domingo .. 6=sábado). */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    /** Solo monthly: día del mes (1-28, acotado para evitar meses cortos). */
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    /** Fecha desde la que empieza a generar (default: hoy). */
    startDate: dateOnly.optional(),
    /** Puntos del checklist (ronda). Vacío = tarea simple sin checklist. */
    checklistTemplate: z.array(ChecklistTemplateItemSchema).max(50).default([]),
  })
  .refine((v) => v.freq !== 'weekly' || v.weekdays.length > 0, {
    message: 'Indica al menos un día de la semana',
    path: ['weekdays'],
  })
  .refine((v) => v.freq !== 'monthly' || v.dayOfMonth !== undefined, {
    message: 'Indica el día del mes',
    path: ['dayOfMonth'],
  });
export type CreateMaintenancePlanInput = z.infer<typeof CreateMaintenancePlanSchema>;

export const UpdateMaintenancePlanSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  type: TaskTypeEnum.optional(),
  priority: TaskPriorityEnum.optional(),
  facilityId: z.string().uuid().nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  checklistTemplate: z.array(ChecklistTemplateItemSchema).max(50).optional(),
});
export type UpdateMaintenancePlanInput = z.infer<typeof UpdateMaintenancePlanSchema>;

export interface MaintenancePlanDto {
  id: string;
  title: string;
  description: string | null;
  type: z.infer<typeof TaskTypeEnum>;
  priority: z.infer<typeof TaskPriorityEnum>;
  facilityId: string | null;
  facilityName: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  freq: MaintenanceFreqValue;
  interval: number;
  weekdays: number[];
  dayOfMonth: number | null;
  checklistTemplate: ChecklistTemplateItem[];
  startDate: string;
  nextRunDate: string;
  lastGeneratedAt: string | null;
  isActive: boolean;
  /** Resumen legible de la frecuencia (p. ej. "Cada 3 meses, día 1"). */
  scheduleLabel: string;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Lógica de recurrencia (pura, compartida backend ↔ posibles previews)
// ----------------------------------------------------------------------------

export interface RecurrenceSpec {
  freq: MaintenanceFreqValue;
  interval: number;
  weekdays: number[];
  dayOfMonth: number | null;
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function dateOnlyUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Próxima fecha de ejecución estrictamente posterior a `after` según la
 * recurrencia. Devuelve una fecha a medianoche UTC (solo día).
 */
export function nextOccurrence(spec: RecurrenceSpec, after: Date): Date {
  const base = dateOnlyUtc(after);

  if (spec.freq === 'daily') {
    return addDaysUtc(base, Math.max(1, spec.interval));
  }

  if (spec.freq === 'weekly') {
    const days = spec.weekdays.length > 0 ? spec.weekdays : [base.getUTCDay()];
    // Busca el primer día (1..7 adelante) cuyo día de semana esté en la lista.
    for (let i = 1; i <= 7; i++) {
      const candidate = addDaysUtc(base, i);
      if (days.includes(candidate.getUTCDay())) return candidate;
    }
    return addDaysUtc(base, 7);
  }

  // monthly: mismo día del mes, +interval meses.
  const dom = spec.dayOfMonth ?? base.getUTCDate();
  const next = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + Math.max(1, spec.interval), dom),
  );
  return dateOnlyUtc(next);
}

/**
 * Primera ejecución a partir de `startDate` (inclusive si encaja con la regla).
 * Se calcula buscando la siguiente ocurrencia desde el día anterior a start.
 */
export function firstOccurrence(spec: RecurrenceSpec, startDate: Date): Date {
  const start = dateOnlyUtc(startDate);
  if (spec.freq === 'daily') return start;
  if (spec.freq === 'weekly') {
    const days = spec.weekdays.length > 0 ? spec.weekdays : [start.getUTCDay()];
    if (days.includes(start.getUTCDay())) return start;
    return nextOccurrence(spec, start);
  }
  // monthly: el día indicado en el mes de start, o el día del mes siguiente si
  // ya pasó (la primera ocurrencia no salta el intervalo completo).
  const dom = spec.dayOfMonth ?? start.getUTCDate();
  const candidate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), dom));
  if (candidate.getTime() >= start.getTime()) return candidate;
  return dateOnlyUtc(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, dom)));
}

const WEEKDAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** Resumen legible de la frecuencia para mostrar en la UI. */
export function scheduleLabel(spec: RecurrenceSpec): string {
  if (spec.freq === 'daily') {
    return spec.interval === 1 ? 'Cada día' : `Cada ${spec.interval} días`;
  }
  if (spec.freq === 'weekly') {
    const days = spec.weekdays
      .slice()
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_LABELS[d])
      .join(', ');
    return `Semanal (${days})`;
  }
  const every = spec.interval === 1 ? 'Cada mes' : `Cada ${spec.interval} meses`;
  return `${every}, día ${spec.dayOfMonth ?? 1}`;
}
