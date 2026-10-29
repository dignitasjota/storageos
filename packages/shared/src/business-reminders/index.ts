import { z } from 'zod';

import type { ExpenseCategory } from '../expenses';

/**
 * Vencimientos del negocio: plazos que el tenant apunta (renovar el dominio,
 * pagar el alquiler del local, presentar un modelo a Hacienda…) y que el
 * sistema le recuerda antes de la fecha. Función `business_reminders`.
 */

export const BusinessReminderCategoryEnum = z.enum([
  'domain', // dominio de la web
  'hosting', // hosting, SSL, correo
  'rent', // alquiler del local
  'taxes', // impuestos y modelos de Hacienda
  'insurance', // seguros
  'license', // licencias y permisos
  'inspection', // revisiones (extintores, puertas, cámaras)
  'utilities', // luz, agua, internet
  'supplier', // proveedores
  'subscription', // suscripciones y programas
  'other',
]);
export type BusinessReminderCategory = z.infer<typeof BusinessReminderCategoryEnum>;

export const BUSINESS_REMINDER_CATEGORY_LABELS: Record<BusinessReminderCategory, string> = {
  domain: 'Dominio',
  hosting: 'Hosting y web',
  rent: 'Alquiler del local',
  taxes: 'Impuestos',
  insurance: 'Seguros',
  license: 'Licencias y permisos',
  inspection: 'Revisiones',
  utilities: 'Suministros',
  supplier: 'Proveedores',
  subscription: 'Suscripciones',
  other: 'Otros',
};

/** Días de aviso que se proponen al elegir el tipo. */
export const BUSINESS_REMINDER_DEFAULT_DAYS: Record<BusinessReminderCategory, number[]> = {
  domain: [30, 7, 1],
  hosting: [30, 7, 1],
  rent: [3, 1, 0],
  taxes: [15, 5, 1, 0],
  insurance: [30, 7, 1],
  license: [60, 30, 7],
  inspection: [30, 7],
  utilities: [3, 0],
  supplier: [7, 1],
  subscription: [7, 1],
  other: [30, 7, 1, 0],
};

/** En qué categoría de gasto se apunta el pago al marcarlo hecho. */
export const BUSINESS_REMINDER_EXPENSE_CATEGORY: Record<BusinessReminderCategory, ExpenseCategory> =
  {
    domain: 'other',
    hosting: 'other',
    rent: 'rent',
    taxes: 'taxes',
    insurance: 'insurance',
    license: 'taxes',
    inspection: 'maintenance',
    utilities: 'utilities',
    supplier: 'supplies',
    subscription: 'other',
    other: 'other',
  };

export const BusinessReminderRecurrenceEnum = z.enum([
  'none',
  'monthly',
  'quarterly',
  'semiannual',
  'yearly',
  'custom',
]);
export type BusinessReminderRecurrence = z.infer<typeof BusinessReminderRecurrenceEnum>;

export const BUSINESS_REMINDER_RECURRENCE_LABELS: Record<BusinessReminderRecurrence, string> = {
  none: 'Una sola vez',
  monthly: 'Cada mes',
  quarterly: 'Cada trimestre',
  semiannual: 'Cada seis meses',
  yearly: 'Cada año',
  custom: 'Cada N meses',
};

export const BusinessReminderRecipientModeEnum = z.enum(['managers', 'users']);
export type BusinessReminderRecipientMode = z.infer<typeof BusinessReminderRecipientModeEnum>;

/** Opciones de «días antes» que se ofrecen en el formulario. */
export const BUSINESS_REMINDER_DAY_OPTIONS = [90, 60, 30, 15, 7, 3, 1, 0] as const;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const reminderFields = {
  title: z.string().trim().min(2).max(200),
  category: BusinessReminderCategoryEnum,
  dueDate: dateOnly,
  recurrence: BusinessReminderRecurrenceEnum,
  intervalMonths: z.number().int().min(1).max(60).nullish(),
  notifyDaysBefore: z
    .array(z.number().int().min(0).max(365))
    .max(8)
    .transform((days) => [...new Set(days)].sort((a, b) => b - a)),
  notifyEmail: z.boolean(),
  notifyInApp: z.boolean(),
  notifyPush: z.boolean(),
  recipientMode: BusinessReminderRecipientModeEnum,
  recipientUserIds: z.array(z.string().uuid()).max(20),
  extraEmails: z.array(z.string().trim().toLowerCase().email().max(200)).max(5),
  overdueReminders: z.boolean(),
  overdueMaxDays: z.number().int().min(1).max(60),
  amount: z.number().nonnegative().finite().max(10_000_000).nullish(),
  vendor: optionalText(200),
  link: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\/[^\s]+$/i, 'El enlace debe empezar por https://')
    .optional()
    .or(z.literal('')),
  notes: optionalText(2000),
  facilityId: z.string().uuid().nullish(),
};

type ReminderShape = {
  recurrence?: BusinessReminderRecurrence | undefined;
  intervalMonths?: number | null | undefined;
  notifyEmail?: boolean | undefined;
  notifyInApp?: boolean | undefined;
  notifyPush?: boolean | undefined;
  recipientMode?: BusinessReminderRecipientMode | undefined;
  recipientUserIds?: string[] | undefined;
};

function checkReminder(v: ReminderShape, ctx: z.RefinementCtx, partial: boolean): void {
  if (v.recurrence === 'custom' && !v.intervalMonths && !partial) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intervalMonths'],
      message: 'Indica cada cuántos meses se repite',
    });
  }
  if (!partial && v.notifyEmail === false && v.notifyInApp === false && v.notifyPush === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['notifyEmail'],
      message: 'Elige al menos una forma de aviso',
    });
  }
  if (!partial && v.recipientMode === 'users' && (v.recipientUserIds ?? []).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recipientUserIds'],
      message: 'Elige al menos una persona',
    });
  }
}

export const CreateBusinessReminderSchema = z
  .object({
    ...reminderFields,
    recurrence: reminderFields.recurrence.default('none'),
    notifyDaysBefore: reminderFields.notifyDaysBefore.default([30, 7, 1, 0]),
    notifyEmail: reminderFields.notifyEmail.default(true),
    notifyInApp: reminderFields.notifyInApp.default(true),
    notifyPush: reminderFields.notifyPush.default(true),
    recipientMode: reminderFields.recipientMode.default('managers'),
    recipientUserIds: reminderFields.recipientUserIds.default([]),
    extraEmails: reminderFields.extraEmails.default([]),
    overdueReminders: reminderFields.overdueReminders.default(true),
    overdueMaxDays: reminderFields.overdueMaxDays.default(7),
  })
  .superRefine((v, ctx) => checkReminder(v, ctx, false));
export type CreateBusinessReminderInput = z.infer<typeof CreateBusinessReminderSchema>;

export const UpdateBusinessReminderSchema = z
  .object(reminderFields)
  .partial()
  .extend({ status: z.enum(['active', 'paused']).optional() })
  .superRefine((v, ctx) => checkReminder(v, ctx, true));
export type UpdateBusinessReminderInput = z.infer<typeof UpdateBusinessReminderSchema>;

export const ReminderReceiptMimeEnum = z.enum(['application/pdf', 'image/png', 'image/jpeg']);

export const RequestReminderReceiptUploadSchema = z.object({
  mimeType: ReminderReceiptMimeEnum,
});

export const CompleteBusinessReminderSchema = z.object({
  note: optionalText(1000),
  amount: z.number().nonnegative().finite().max(10_000_000).nullish(),
  /** Apuntar el pago en Gastos. */
  registerExpense: z.boolean().default(false),
  receiptKey: z.string().max(500).optional(),
  receiptName: z.string().trim().max(200).optional(),
  receiptMime: ReminderReceiptMimeEnum.optional(),
});
export type CompleteBusinessReminderInput = z.infer<typeof CompleteBusinessReminderSchema>;

export const SnoozeBusinessReminderSchema = z.object({
  days: z.number().int().min(1).max(60),
});

export const ApplyReminderTemplateSchema = z.object({
  /** Fecha del primer vencimiento (las plantillas fiscales la calculan solas). */
  dueDate: dateOnly.optional(),
  facilityId: z.string().uuid().nullish(),
});

export const UpdateBusinessReminderSettingsSchema = z.object({
  weeklyDigest: z.boolean(),
});

/** En qué punto está: vencido, en los próximos 7 días, más adelante… */
export type BusinessReminderState = 'overdue' | 'soon' | 'upcoming' | 'paused' | 'done';

export interface BusinessReminderDto {
  id: string;
  title: string;
  category: BusinessReminderCategory;
  dueDate: string;
  /** Días hasta el vencimiento en la hora del negocio (negativo = vencido). */
  daysLeft: number;
  state: BusinessReminderState;
  recurrence: BusinessReminderRecurrence;
  intervalMonths: number | null;
  notifyDaysBefore: number[];
  notifyEmail: boolean;
  notifyInApp: boolean;
  notifyPush: boolean;
  recipientMode: BusinessReminderRecipientMode;
  recipientUserIds: string[];
  extraEmails: string[];
  overdueReminders: boolean;
  overdueMaxDays: number;
  amount: number | null;
  vendor: string | null;
  link: string | null;
  notes: string | null;
  facilityId: string | null;
  facilityName: string | null;
  status: 'active' | 'paused' | 'done';
  snoozedUntil: string | null;
  templateKey: string | null;
  lastCompletedAt: string | null;
  createdAt: string;
}

export interface BusinessReminderCompletionDto {
  id: string;
  dueDate: string;
  completedAt: string;
  completedByName: string | null;
  note: string | null;
  amount: number | null;
  expenseId: string | null;
  hasReceipt: boolean;
  receiptName: string | null;
}

/** Plazos que el sistema ya conoce (certificado, documentos, suscripción…). */
export interface SystemDeadlineDto {
  key: string;
  title: string;
  detail: string | null;
  date: string;
  daysLeft: number;
  href: string;
}

export interface BusinessRemindersListDto {
  items: BusinessReminderDto[];
  system: SystemDeadlineDto[];
}

export interface BusinessReminderSettingsDto {
  weeklyDigest: boolean;
  /** Enlace para suscribirse desde Google o Apple Calendar; null si no se ha creado. */
  icsUrl: string | null;
}

export interface ReminderReceiptUploadDto {
  uploadUrl: string;
  key: string;
  expiresIn: number;
}

export interface ReminderTemplateDto {
  key: string;
  group: 'fiscal' | 'business';
  title: string;
  description: string;
  category: BusinessReminderCategory;
  recurrence: BusinessReminderRecurrence;
  /** Hay que indicar la fecha del primer vencimiento. */
  needsDate: boolean;
  /** Cuántos vencimientos crea (las fiscales trimestrales, cuatro). */
  count: number;
  /** Ya añadida por este negocio. */
  applied?: boolean;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

function parse(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Suma meses a una fecha YYYY-MM-DD ajustando al último día del mes. */
export function addMonthsToDate(date: string, months: number): string {
  const { y, m, d } = parse(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addDaysToDate(date: string, days: number): string {
  const { y, m, d } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Días de `from` a `to` (fechas YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** Meses entre repeticiones; null si no se repite. */
export function recurrenceMonths(
  recurrence: BusinessReminderRecurrence,
  intervalMonths: number | null | undefined,
): number | null {
  switch (recurrence) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'semiannual':
      return 6;
    case 'yearly':
      return 12;
    case 'custom':
      return intervalMonths && intervalMonths > 0 ? intervalMonths : null;
    default:
      return null;
  }
}

/** Siguiente vencimiento al marcar hecho; null si no se repite. */
export function nextReminderDueDate(
  dueDate: string,
  recurrence: BusinessReminderRecurrence,
  intervalMonths: number | null | undefined,
): string | null {
  const months = recurrenceMonths(recurrence, intervalMonths);
  return months ? addMonthsToDate(dueDate, months) : null;
}

export function recurrenceLabel(
  recurrence: BusinessReminderRecurrence,
  intervalMonths: number | null | undefined,
): string {
  if (recurrence === 'custom' && intervalMonths) {
    return intervalMonths === 1 ? 'Cada mes' : `Cada ${intervalMonths} meses`;
  }
  return BUSINESS_REMINDER_RECURRENCE_LABELS[recurrence];
}

export function reminderState(
  status: 'active' | 'paused' | 'done',
  daysLeft: number,
): BusinessReminderState {
  if (status === 'done') return 'done';
  if (status === 'paused') return 'paused';
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 7) return 'soon';
  return 'upcoming';
}

/**
 * Qué aviso toca hoy (o null). Antes del vencimiento, el hito más cercano de
 * los «días antes» que ya se ha alcanzado (`d30`, `d7`…): así quien apunta un
 * plazo tarde recibe un aviso, no tres. Vencido, uno al día (`overdue:<hoy>`)
 * durante `overdueMaxDays`. Pospuesto, nada hasta el día elegido
 * (`snooze:<día>`). El que ya se envió se descarta al guardarlo (único).
 */
export function reminderNoticeKind(args: {
  dueDate: string;
  today: string;
  notifyDaysBefore: number[];
  overdueReminders: boolean;
  overdueMaxDays: number;
  snoozedUntil?: string | null;
}): string | null {
  const { today } = args;
  if (args.snoozedUntil) {
    if (today < args.snoozedUntil) return null;
    if (today === args.snoozedUntil) return `snooze:${args.snoozedUntil}`;
  }
  const daysLeft = daysBetween(today, args.dueDate);
  if (daysLeft >= 0) {
    const reached = args.notifyDaysBefore.filter((d) => d >= daysLeft);
    if (reached.length === 0) return null;
    return `d${Math.min(...reached)}`;
  }
  if (args.overdueReminders && -daysLeft <= args.overdueMaxDays) return `overdue:${today}`;
  return null;
}

/** Texto corto: «Vence hoy», «Vence mañana», «Vence en 12 días», «Venció hace 2 días». */
export function reminderWhenLabel(daysLeft: number): string {
  if (daysLeft === 0) return 'Vence hoy';
  if (daysLeft === 1) return 'Vence mañana';
  if (daysLeft > 1) return `Vence en ${daysLeft} días`;
  if (daysLeft === -1) return 'Venció ayer';
  return `Venció hace ${-daysLeft} días`;
}

// ---------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------

interface FiscalOccurrence {
  month: number;
  day: number;
  suffix: string;
}

export interface ReminderTemplate {
  key: string;
  group: 'fiscal' | 'business';
  title: string;
  description: string;
  category: BusinessReminderCategory;
  recurrence: BusinessReminderRecurrence;
  intervalMonths?: number;
  notifyDaysBefore: number[];
  /** Fechas fijas del calendario fiscal (una repetición anual por fecha). */
  occurrences?: FiscalOccurrence[];
}

const QUARTERLY_20_JAN: FiscalOccurrence[] = [
  { month: 4, day: 20, suffix: '1.er trimestre' },
  { month: 7, day: 20, suffix: '2.º trimestre' },
  { month: 10, day: 20, suffix: '3.er trimestre' },
  { month: 1, day: 20, suffix: '4.º trimestre' },
];

const FISCAL_NOTE =
  'Fechas orientativas del calendario de la AEAT; si caen en fin de semana se pasan al lunes. Revísalas con tu asesoría.';

export const REMINDER_TEMPLATES: ReminderTemplate[] = [
  {
    key: 'fiscal_303',
    group: 'fiscal',
    title: 'IVA trimestral (modelo 303)',
    description: `Autoliquidación del IVA de cada trimestre. ${FISCAL_NOTE}`,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: [
      { month: 4, day: 20, suffix: '1.er trimestre' },
      { month: 7, day: 20, suffix: '2.º trimestre' },
      { month: 10, day: 20, suffix: '3.er trimestre' },
      { month: 1, day: 30, suffix: '4.º trimestre' },
    ],
  },
  {
    key: 'fiscal_111',
    group: 'fiscal',
    title: 'Retenciones de trabajadores y profesionales (modelo 111)',
    description: `Retenciones de IRPF de nóminas y facturas de profesionales. ${FISCAL_NOTE}`,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: QUARTERLY_20_JAN,
  },
  {
    key: 'fiscal_115',
    group: 'fiscal',
    title: 'Retenciones del alquiler del local (modelo 115)',
    description: `Si pagas alquiler por tu nave o local, la retención de cada trimestre. ${FISCAL_NOTE}`,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: QUARTERLY_20_JAN,
  },
  {
    key: 'fiscal_130',
    group: 'fiscal',
    title: 'Pago fraccionado del IRPF (modelo 130, autónomos)',
    description: `Solo si eres autónomo en estimación directa. ${FISCAL_NOTE}`,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: QUARTERLY_20_JAN,
  },
  {
    key: 'fiscal_202',
    group: 'fiscal',
    title: 'Pagos fraccionados del Impuesto de Sociedades (modelo 202)',
    description: `Para sociedades obligadas a los pagos a cuenta. ${FISCAL_NOTE}`,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: [
      { month: 4, day: 20, suffix: '1.er pago' },
      { month: 10, day: 20, suffix: '2.º pago' },
      { month: 12, day: 20, suffix: '3.er pago' },
    ],
  },
  {
    key: 'fiscal_390',
    group: 'fiscal',
    title: 'Resumen anual del IVA (modelo 390)',
    description: FISCAL_NOTE,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: [{ month: 1, day: 30, suffix: '' }],
  },
  {
    key: 'fiscal_180_190',
    group: 'fiscal',
    title: 'Resúmenes anuales de retenciones (modelos 180 y 190)',
    description: FISCAL_NOTE,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: [{ month: 1, day: 31, suffix: '' }],
  },
  {
    key: 'fiscal_347',
    group: 'fiscal',
    title: 'Operaciones con terceros (modelo 347)',
    description: `Clientes y proveedores con más de 3.005,06 € al año. ${FISCAL_NOTE}`,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [15, 5, 1, 0],
    occurrences: [{ month: 2, day: 28, suffix: '' }],
  },
  {
    key: 'fiscal_200',
    group: 'fiscal',
    title: 'Impuesto de Sociedades (modelo 200)',
    description: FISCAL_NOTE,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [30, 15, 5, 1],
    occurrences: [{ month: 7, day: 25, suffix: '' }],
  },
  {
    key: 'fiscal_accounts',
    group: 'fiscal',
    title: 'Depósito de las cuentas anuales en el Registro Mercantil',
    description: `Un mes después de aprobarlas (normalmente antes del 30 de julio). ${FISCAL_NOTE}`,
    category: 'taxes',
    recurrence: 'yearly',
    notifyDaysBefore: [30, 15, 5, 1],
    occurrences: [{ month: 7, day: 30, suffix: '' }],
  },
  {
    key: 'business_domain',
    group: 'business',
    title: 'Renovación del dominio',
    description: 'Que no caduque la dirección de tu web ni tu correo.',
    category: 'domain',
    recurrence: 'yearly',
    notifyDaysBefore: [30, 7, 1],
  },
  {
    key: 'business_hosting',
    group: 'business',
    title: 'Hosting y certificado SSL de la web',
    description: 'Renovación del alojamiento y del certificado de la web.',
    category: 'hosting',
    recurrence: 'yearly',
    notifyDaysBefore: [30, 7, 1],
  },
  {
    key: 'business_rent',
    group: 'business',
    title: 'Alquiler del local',
    description: 'El pago mensual de la nave o el local.',
    category: 'rent',
    recurrence: 'monthly',
    notifyDaysBefore: [3, 1, 0],
  },
  {
    key: 'business_insurance',
    group: 'business',
    title: 'Seguro del local',
    description: 'Renovación de la póliza del local y su contenido.',
    category: 'insurance',
    recurrence: 'yearly',
    notifyDaysBefore: [30, 7, 1],
  },
  {
    key: 'business_fire',
    group: 'business',
    title: 'Revisión de extintores y protección contra incendios',
    description: 'Revisión anual obligatoria por una empresa autorizada.',
    category: 'inspection',
    recurrence: 'yearly',
    notifyDaysBefore: [30, 7],
  },
  {
    key: 'business_doors',
    group: 'business',
    title: 'Mantenimiento de puertas, cámaras y alarma',
    description: 'Revisión del control de accesos y la videovigilancia.',
    category: 'inspection',
    recurrence: 'semiannual',
    notifyDaysBefore: [15, 3],
  },
  {
    key: 'business_certificate',
    group: 'business',
    title: 'Certificado digital de la empresa',
    description: 'El certificado de la FNMT o de representante caduca cada dos años.',
    category: 'license',
    recurrence: 'custom',
    intervalMonths: 24,
    notifyDaysBefore: [60, 30, 7],
  },
  {
    key: 'business_license',
    group: 'business',
    title: 'Licencia de actividad o revisión municipal',
    description: 'Renovaciones o revisiones que pida el ayuntamiento.',
    category: 'license',
    recurrence: 'yearly',
    notifyDaysBefore: [60, 30, 7],
  },
  {
    key: 'business_utilities',
    group: 'business',
    title: 'Suministros (luz, agua, internet)',
    description: 'Revisar y pagar las facturas de suministros.',
    category: 'utilities',
    recurrence: 'monthly',
    notifyDaysBefore: [3, 0],
  },
];

export function findReminderTemplate(key: string): ReminderTemplate | undefined {
  return REMINDER_TEMPLATES.find((t) => t.key === key);
}

/** Pasa al lunes una fecha que cae en sábado o domingo. */
export function shiftWeekend(date: string): string {
  const { y, m, d } = parse(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 6) return addDaysToDate(date, 2);
  if (dow === 0) return addDaysToDate(date, 1);
  return date;
}

/** Próximo vencimiento (hoy o después) de cada fecha de una plantilla fiscal. */
export function fiscalTemplateOccurrences(
  template: ReminderTemplate,
  today: string,
): { title: string; dueDate: string; templateKey: string }[] {
  return (template.occurrences ?? []).map((o) => ({
    title: o.suffix ? `${template.title} — ${o.suffix}` : template.title,
    dueDate: fiscalDateOnOrAfter(o.month, o.day, today),
    templateKey: `${template.key}:${o.month}-${o.day}`,
  }));
}

function fiscalDateOnOrAfter(month: number, day: number, from: string): string {
  let year = parse(from).y;
  const at = (yy: number) => shiftWeekend(fmt(yy, month, Math.min(day, daysInMonth(yy, month))));
  let date = at(year);
  while (date < from) {
    year += 1;
    date = at(year);
  }
  return date;
}

/**
 * Siguiente vencimiento de una fecha fiscal (`fiscal_303:4-20`) tras `after`:
 * vuelve al día oficial del año siguiente aunque el anterior se pasara al
 * lunes. Null si la clave no es de una plantilla fiscal.
 */
export function fiscalNextDueDate(templateKey: string | null, after: string): string | null {
  const m = /^(fiscal_[a-z0-9_]+):(\d{1,2})-(\d{1,2})$/.exec(templateKey ?? '');
  if (!m) return null;
  return fiscalDateOnOrAfter(Number(m[2]), Number(m[3]), addDaysToDate(after, 1));
}

/** Plantilla de la que salió un vencimiento (`fiscal_303:4-20` → `fiscal_303`). */
export function reminderTemplateBaseKey(templateKey: string | null): string | null {
  return templateKey ? (templateKey.split(':')[0] ?? null) : null;
}

export function reminderTemplateDto(t: ReminderTemplate, applied = false): ReminderTemplateDto {
  return {
    key: t.key,
    group: t.group,
    title: t.title,
    description: t.description,
    category: t.category,
    recurrence: t.recurrence,
    needsDate: !t.occurrences,
    count: t.occurrences?.length ?? 1,
    applied,
  };
}
