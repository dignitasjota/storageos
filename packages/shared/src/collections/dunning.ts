import { z } from 'zod';

/**
 * El escalado de impagos en una pantalla: los días de cada paso (recordatorios,
 * recargo, corte de acceso y aviso legal) y una vista previa de las fechas.
 */
/** Días enteros entre `min` y `max`, con mensajes en español. */
const days = (min: number, max: number) =>
  z
    .number({
      required_error: 'Indica el número de días',
      invalid_type_error: 'Indica el número de días',
    })
    .int('Tiene que ser un número entero de días')
    .min(min, `Como mínimo ${min} ${min === 1 ? 'día' : 'días'}`)
    .max(max, `Como máximo ${max} días`);

export const DunningSettingsSchema = z
  .object({
    /** Días tras el vencimiento hasta el primer recordatorio. */
    firstReminderDays: days(1, 30),
    /** Días hasta el segundo recordatorio (después del primero). */
    secondReminderDays: days(2, 60),
    lateFeeEnabled: z.boolean(),
    lateFeeType: z.enum(['percentage', 'fixed']),
    lateFeeValue: z
      .number({
        required_error: 'Indica el importe del recargo',
        invalid_type_error: 'Indica el importe del recargo',
      })
      .nonnegative('El recargo no puede ser negativo')
      .max(100_000, 'El recargo no puede pasar de 100.000 €'),
    lateFeeGraceDays: days(0, 120),
    /** Qué corta el impago: todo, solo los accesos adicionales o nada. */
    accessCutMode: z.enum(['all', 'extras', 'none']),
    accessCutDays: days(1, 90),
    /** Días hasta el aviso legal (y el expediente, si se usan). */
    legalNoticeDays: days(8, 365),
    /**
     * Los dos recordatorios salen también por WhatsApp (con WhatsApp Business
     * conectado). Sin enviar, no se toca.
     */
    whatsappReminders: z.boolean().optional(),
    /**
     * Plantilla aprobada en Meta para cuando han pasado más de 24 h desde el
     * último mensaje del inquilino ({{1}} nombre, {{2}} importe pendiente,
     * {{3}} enlace para pagar). Vacía = solo texto dentro de las 24 h.
     */
    whatsappTemplateName: z
      .string()
      .trim()
      .max(512)
      .regex(/^[a-z0-9_]*$/, 'El nombre de la plantilla de Meta va en minúsculas, cifras y «_»')
      .nullable()
      .optional(),
    whatsappTemplateLanguage: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Idioma de la plantilla no válido (p. ej. «es» o «en_US»)')
      .optional(),
  })
  .refine((s) => s.secondReminderDays > s.firstReminderDays, {
    message: 'El segundo recordatorio va después del primero',
    path: ['secondReminderDays'],
  })
  .refine((s) => s.accessCutMode === 'none' || s.accessCutDays >= s.secondReminderDays, {
    message: 'El corte del acceso no puede ir antes del segundo recordatorio',
    path: ['accessCutDays'],
  })
  .refine(
    (s) =>
      s.legalNoticeDays >= s.secondReminderDays &&
      (s.accessCutMode === 'none' || s.legalNoticeDays >= s.accessCutDays),
    {
      message: 'El aviso legal va después de los recordatorios y del corte del acceso',
      path: ['legalNoticeDays'],
    },
  )
  .refine((s) => !s.lateFeeEnabled || s.lateFeeValue > 0, {
    message: 'Con el recargo activado, indica un importe mayor que 0',
    path: ['lateFeeValue'],
  })
  .refine((s) => s.lateFeeType !== 'percentage' || s.lateFeeValue <= 100, {
    message: 'Un recargo en porcentaje no pasa del 100 %',
    path: ['lateFeeValue'],
  });
export type DunningSettingsInput = z.infer<typeof DunningSettingsSchema>;

export interface DunningSettingsDto extends Omit<
  DunningSettingsInput,
  'whatsappReminders' | 'whatsappTemplateName' | 'whatsappTemplateLanguage'
> {
  whatsappReminders: boolean;
  /** El negocio tiene WhatsApp Business conectado y activo. */
  whatsappAvailable: boolean;
  whatsappTemplateName: string | null;
  whatsappTemplateLanguage: string;
  /** El negocio usa expedientes de impago (se abren con el aviso legal). */
  collectionsEnabled: boolean;
  /** Plantillas de los dos recordatorios (para editarlas) y la de WhatsApp. */
  templates: {
    firstReminder: string | null;
    secondReminder: string | null;
    whatsapp: string | null;
  };
}

/**
 * Plantilla del recordatorio por WhatsApp (canal WhatsApp, editable en
 * Plantillas de mensajes): su texto sale dentro de las 24 h desde el último
 * mensaje del inquilino y su plantilla de Meta, fuera.
 */
export const DUNNING_WHATSAPP_TEMPLATE_CODE = 'invoice_overdue_whatsapp';

/** Variables de la plantilla de Meta, en orden ({{1}}, {{2}}, {{3}}). */
export const DUNNING_WHATSAPP_TEMPLATE_VARIABLES = [
  'customer.firstName',
  'invoice.amountPending',
  'portal.url',
] as const;

export const DUNNING_WHATSAPP_DEFAULT_TEXT =
  'Hola {{customer.firstName}}, te recordamos que la factura {{invoice.number}} de {{tenant.name}} está pendiente de pago ({{invoice.amountPending}}). Puedes pagarla aquí: {{portal.url}}\n\nSi ya la has pagado, ignora este mensaje.';

export const DUNNING_WHATSAPP_DEFAULT_TEXT_EN =
  'Hi {{customer.firstName}}, this is a reminder that invoice {{invoice.number}} from {{tenant.name}} is still unpaid ({{invoice.amountPending}}). You can pay it here: {{portal.url}}\n\nIf you have already paid it, please ignore this message.';

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
