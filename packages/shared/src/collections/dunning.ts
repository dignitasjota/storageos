import { z } from 'zod';

/**
 * El escalado de impagos en una pantalla: los días de cada paso (recordatorios,
 * recargo, corte de acceso y aviso legal) y una vista previa de las fechas.
 */
export const DunningSettingsSchema = z
  .object({
    /** Días tras el vencimiento hasta el primer recordatorio. */
    firstReminderDays: z.number().int().min(1).max(30),
    /** Días hasta el segundo recordatorio (después del primero). */
    secondReminderDays: z.number().int().min(2).max(60),
    lateFeeEnabled: z.boolean(),
    lateFeeType: z.enum(['percentage', 'fixed']),
    lateFeeValue: z.number().nonnegative().max(100_000),
    lateFeeGraceDays: z.number().int().min(0).max(120),
    /** Qué corta el impago: todo, solo los accesos adicionales o nada. */
    accessCutMode: z.enum(['all', 'extras', 'none']),
    accessCutDays: z.number().int().min(1).max(90),
    /** Días hasta el aviso legal (y el expediente, si se usan). */
    legalNoticeDays: z.number().int().min(8).max(365),
  })
  .refine((s) => s.secondReminderDays > s.firstReminderDays, {
    message: 'El segundo recordatorio va después del primero',
    path: ['secondReminderDays'],
  })
  .refine((s) => s.lateFeeType !== 'percentage' || s.lateFeeValue <= 100, {
    message: 'Un recargo en porcentaje no pasa del 100 %',
    path: ['lateFeeValue'],
  });
export type DunningSettingsInput = z.infer<typeof DunningSettingsSchema>;

export interface DunningSettingsDto extends DunningSettingsInput {
  /** El negocio usa expedientes de impago (se abren con el aviso legal). */
  collectionsEnabled: boolean;
  /** Plantillas de los dos recordatorios (para editarlas). */
  templates: { firstReminder: string | null; secondReminder: string | null };
}

/** Códigos de las plantillas de los dos recordatorios de impago. */
export const DUNNING_TEMPLATE_CODES = {
  firstReminder: 'invoice_overdue_email',
  secondReminder: 'invoice_overdue_final_email',
} as const;

export type DunningPreviewKey =
  | 'due'
  | 'first_reminder'
  | 'second_reminder'
  | 'late_fee'
  | 'access_block'
  | 'legal_notice';

export interface DunningPreviewStep {
  key: DunningPreviewKey;
  label: string;
  /** Días tras el vencimiento. */
  days: number;
  /** `AAAA-MM-DD`. */
  date: string;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Qué pasa y cuándo si una factura vence el día `dueDate` y no se paga, en
 * orden. Un paso apagado (recargo, corte) no sale.
 */
export function dunningPreview(
  dueDate: string,
  s: Pick<
    DunningSettingsDto,
    | 'firstReminderDays'
    | 'secondReminderDays'
    | 'lateFeeEnabled'
    | 'lateFeeType'
    | 'lateFeeValue'
    | 'lateFeeGraceDays'
    | 'accessCutMode'
    | 'accessCutDays'
    | 'legalNoticeDays'
    | 'collectionsEnabled'
  >,
): DunningPreviewStep[] {
  const steps: Omit<DunningPreviewStep, 'date'>[] = [
    { key: 'due', label: 'Vence la factura', days: 0 },
    { key: 'first_reminder', label: 'Primer recordatorio', days: s.firstReminderDays },
    {
      key: 'second_reminder',
      label: 'Segundo recordatorio',
      days: s.secondReminderDays,
    },
  ];
  if (s.lateFeeEnabled) {
    steps.push({
      key: 'late_fee',
      label:
        s.lateFeeType === 'fixed'
          ? `Recargo por mora de ${s.lateFeeValue.toFixed(2).replace('.', ',')} €`
          : `Recargo por mora del ${String(s.lateFeeValue).replace('.', ',')} %`,
      days: s.lateFeeGraceDays,
    });
  }
  if (s.accessCutMode !== 'none') {
    steps.push({
      key: 'access_block',
      label: s.accessCutMode === 'extras' ? 'Corte de los accesos adicionales' : 'Corte del acceso',
      days: s.accessCutDays,
    });
  }
  steps.push({
    key: 'legal_notice',
    label: s.collectionsEnabled
      ? 'Aviso legal y expediente de impago'
      : 'Aviso legal (aviso al equipo)',
    days: s.legalNoticeDays,
  });
  return steps
    .map((step) => ({ ...step, date: addDays(dueDate, step.days) }))
    .sort((a, b) => a.days - b.days || order(a.key) - order(b.key));
}

const ORDER: DunningPreviewKey[] = [
  'due',
  'first_reminder',
  'second_reminder',
  'late_fee',
  'access_block',
  'legal_notice',
];
const order = (k: DunningPreviewKey) => ORDER.indexOf(k);
