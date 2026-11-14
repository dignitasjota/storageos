import { z } from 'zod';

export const RentIncreaseStatusEnum = z.enum(['scheduled', 'applied', 'cancelled']);
export type RentIncreaseStatusValue = z.infer<typeof RentIncreaseStatusEnum>;

/**
 * `percentage` y `fixed` suben a todos lo mismo; `to_list_price` lleva a cada
 * uno hasta el precio de tarifa actual de su trastero, con un máximo de %
 * (`increaseValue`).
 */
export const RentIncreaseTypeEnum = z.enum(['percentage', 'fixed', 'to_list_price']);
export type RentIncreaseTypeValue = z.infer<typeof RentIncreaseTypeEnum>;

/** Preaviso por defecto de una subida (la condición 4 del contrato dice 30 días). */
export const DEFAULT_RENT_INCREASE_NOTICE_DAYS = 30;
/** A partir de este % la pantalla pide confirmar la subida. */
export const RENT_INCREASE_HIGH_PCT = 15;
/** Topes de lo que se puede subir de una vez. */
export const RENT_INCREASE_MAX_PCT = 100;
export const RENT_INCREASE_MAX_FIXED = 1000;

/** Fecha real (YYYY-MM-DD) y día 1: las subidas empiezan siempre a principio de mes. */
export function isFirstOfMonth(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd && d.getUTCDate() === 1;
}

/**
 * Primer día 1 en que puede empezar una subida programada hoy: hoy más el
 * preaviso, llevado al día 1 siguiente (o ese mismo día si ya es 1).
 */
export function earliestRentIncreaseDate(todayYmd: string, noticeDays: number): string {
  const d = new Date(`${todayYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, noticeDays));
  if (d.getUTCDate() !== 1) d.setUTCMonth(d.getUTCMonth() + 1, 1);
  return d.toISOString().slice(0, 10);
}

/** Filtros de los contratos a los que se les sube el precio. */
export const RentIncreaseScopeSchema = z.object({
  /** Antigüedad mínima del contrato (meses desde la firma). 0 = sin filtro. */
  minMonthsSinceSigned: z.number().int().min(0).max(120).default(0),
  /** Limitar a un local. */
  facilityId: z.string().uuid().optional(),
  /** Limitar a un tipo de trastero. */
  unitTypeId: z.string().uuid().optional(),
});
export type RentIncreaseScopeInput = z.infer<typeof RentIncreaseScopeSchema>;

const effectiveDate = z
  .string()
  .refine(isFirstOfMonth, 'Las subidas empiezan siempre un día 1 (fecha AAAA-MM-01)');

const baseFields = {
  increaseType: RentIncreaseTypeEnum,
  /** % (p. ej. 8 = +8%) o € fijo según `increaseType`. */
  increaseValue: z.number().positive(),
  scope: RentIncreaseScopeSchema,
};

function checkValue(
  v: { increaseType: RentIncreaseTypeValue; increaseValue: number },
  ctx: z.RefinementCtx,
): void {
  const pct = v.increaseType !== 'fixed';
  const max = pct ? RENT_INCREASE_MAX_PCT : RENT_INCREASE_MAX_FIXED;
  if (v.increaseValue > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['increaseValue'],
      message: pct
        ? `La subida no puede pasar del ${max} %`
        : `La subida no puede pasar de ${max} € al mes`,
    });
  }
}

/** Previsualiza los contratos afectados y el delta de MRR sin persistir. */
export const PreviewRentIncreaseSchema = z
  .object({
    ...baseFields,
    /** Día en que empieza (para la fecha de los que pagan por adelantado). */
    effectiveDate: effectiveDate.optional(),
  })
  .superRefine(checkValue);
export type PreviewRentIncreaseInput = z.infer<typeof PreviewRentIncreaseSchema>;

export const CreateRentIncreaseSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    ...baseFields,
    /** Día 1 en que cambia la cuota. El preaviso sale al programarla. */
    effectiveDate,
    /** Contratos que se quitan a mano de la lista al repasarla. */
    excludeContractIds: z.array(z.string().uuid()).max(5000).optional(),
  })
  .superRefine(checkValue);
export type CreateRentIncreaseInput = z.infer<typeof CreateRentIncreaseSchema>;

/** Por qué un contrato del alcance se queda fuera de la tanda. */
export const RENT_INCREASE_EXCLUSIONS = [
  'exempt',
  'ending',
  'leaving_before',
  'housing',
  'already_scheduled',
  'recently_raised',
  'cap_reached',
  'at_list_price',
] as const;
export type RentIncreaseExclusion = (typeof RENT_INCREASE_EXCLUSIONS)[number];

export const RENT_INCREASE_EXCLUSION_LABELS: Record<RentIncreaseExclusion, string> = {
  ending: 'Han pedido la baja',
  leaving_before: 'Su contrato termina antes de esa fecha',
  housing: 'Son viviendas (se actualizan en su aniversario)',
  already_scheduled: 'Ya tienen un cambio de cuota programado',
  recently_raised: 'Les subiste la cuota hace poco (política de subidas)',
  cap_reached: 'Ya llegaron al tope anual de la política',
  exempt: 'Tienen marcado «no subir» hasta una fecha posterior',
  at_list_price: 'Ya pagan el precio de tarifa o más',
};

/** Por qué un contrato de la tanda no se subió al llegar su fecha. */
export const RENT_INCREASE_SKIP_LABELS: Record<string, string> = {
  contract_not_active: 'El contrato ya no está en vigor',
  contract_ending: 'Pidió la baja',
  price_changed: 'Su cuota cambió después del aviso',
  cancelled: 'Subida cancelada',
  removed: 'Quitado de la subida',
};

export interface RentIncreaseAffectedContract {
  contractId: string;
  contractNumber: string;
  customerName: string;
  unitCode: string;
  oldPrice: number;
  newPrice: number;
  /** Día en que le cambia la cuota (el siguiente periodo si paga por adelantado). */
  effectiveDate: string | null;
  /** Ya tuvo una subida en los últimos 12 meses. */
  raisedThisYear: boolean;
  /** Sin email: no le llegará el preaviso. */
  noEmail: boolean;
}

export interface RentIncreasePreviewDto {
  affectedCount: number;
  /** Suma mensual de (nuevo − antiguo). */
  mrrDelta: number;
  contracts: RentIncreaseAffectedContract[];
  /** Contratos del alcance que se quedan fuera, por motivo. */
  excluded: { reason: RentIncreaseExclusion; count: number }[];
  /** Cuántos de los afectados ya tuvieron una subida en los últimos 12 meses. */
  raisedThisYear: number;
  /** Cuántos no tienen email. */
  noEmail: number;
  /** Primer día 1 posible con el preaviso del negocio. */
  earliestDate: string;
  noticeDays: number;
}

export type RentIncreaseNoticeStatus = 'sent' | 'no_email' | 'failed';

export interface RentIncreaseItemDto {
  id: string;
  contractId: string;
  contractNumber: string;
  customerName: string;
  unitCode: string;
  oldPrice: number;
  newPrice: number;
  status: 'pending' | 'applied' | 'skipped';
  skipReason: string | null;
  appliedAt: string | null;
  effectiveDate: string;
  noticeStatus: RentIncreaseNoticeStatus | null;
  /** Qué pasó con el correo del aviso (null = no se envió). */
  noticeDelivery: 'pending' | 'sent' | 'delivered' | 'bounced' | 'failed' | null;
}

export interface RentIncreaseDto {
  id: string;
  name: string;
  scope: RentIncreaseScopeInput;
  increaseType: RentIncreaseTypeValue;
  increaseValue: number;
  effectiveDate: string;
  status: RentIncreaseStatusValue;
  affectedCount: number;
  appliedCount: number;
  mrrDelta: number;
  noticeSent: boolean;
  createdAt: string;
  appliedAt: string | null;
  cancelledAt: string | null;
  /** Solo en el detalle. */
  items?: RentIncreaseItemDto[];
}

/** Política de subidas: tope de % anual, meses mínimos entre subidas y preaviso. */
export const RentIncreasePolicySchema = z.object({
  maxAnnualPct: z.number().min(0).max(100).optional(),
  minMonthsBetween: z.number().int().min(0).max(60).optional(),
  noticeDays: z.number().int().min(1).max(180).optional(),
});
export type RentIncreasePolicyInput = z.infer<typeof RentIncreasePolicySchema>;

export interface RentIncreasePolicyDto {
  /** % máximo que puede subir una cuota en 12 meses (0 = sin tope). */
  maxAnnualPct: number;
  minMonthsBetween: number;
  noticeDays: number;
}

/** Variables del texto del aviso de subida (se sustituyen por los datos de cada contrato). */
export const RENT_INCREASE_NOTICE_VARIABLES = [
  'nombre',
  'trastero',
  'local',
  'contrato',
  'cuota_actual',
  'cuota_nueva',
  'fecha',
  'negocio',
] as const;

/** Texto de serie del aviso (con variables entre llaves). */
export const RENT_INCREASE_NOTICE_DEFAULTS = {
  es: {
    subject: 'Revisión de la cuota de tu trastero {trastero}',
    body: 'Desde el {fecha}, la cuota mensual de tu trastero {trastero} en {local} (contrato {contrato}) pasará de {cuota_actual} a {cuota_nueva} (IVA incluido).\n\nSi tienes cualquier duda, contacta con nosotros.',
  },
  en: {
    subject: 'New monthly fee for your storage unit {trastero}',
    body: 'From {fecha}, the monthly fee for storage unit {trastero} at {local} (contract {contrato}) will go from {cuota_actual} to {cuota_nueva} (VAT included).\n\nIf you have any questions, get in touch with us.',
  },
} as const;

/** Sustituye `{variable}` por su valor (las que no conoce quedan tal cual). */
export function fillRentIncreaseNotice(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z_]+)\}/g, (all, key: string) => values[key] ?? all);
}

const noticeText = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(10).max(5000),
});

/**
 * Texto propio del aviso de subida, en español y (opcional) en inglés. La
 * frase de que puede darse de baja antes sin preaviso se añade siempre.
 */
export const RentIncreaseNoticeTemplateSchema = z.object({
  es: noticeText,
  en: noticeText.optional(),
});
export type RentIncreaseNoticeTemplate = z.infer<typeof RentIncreaseNoticeTemplateSchema>;

export const UpdateRentIncreaseNoticeTemplateSchema = z.object({
  template: RentIncreaseNoticeTemplateSchema.nullable(),
});

export interface RentIncreaseNoticeTemplateDto {
  /** El del negocio (null = el de serie). */
  template: RentIncreaseNoticeTemplate | null;
  /** El de serie, para partir de él. */
  defaults: { es: { subject: string; body: string }; en: { subject: string; body: string } };
}

/** Vista previa del aviso con los datos de un contrato (o de ejemplo). */
export const PreviewRentIncreaseNoticeSchema = z.object({
  template: RentIncreaseNoticeTemplateSchema.nullable().optional(),
  locale: z.enum(['es', 'en']).default('es'),
  contractId: z.string().uuid().optional(),
  newPrice: z.number().positive().optional(),
  effectiveDate: z.string().optional(),
});
export type PreviewRentIncreaseNoticeInput = z.infer<typeof PreviewRentIncreaseNoticeSchema>;

export interface RentIncreaseNoticePreviewDto {
  subject: string;
  text: string;
  html: string;
}

/** Qué ha pasado con una subida: ingreso de verdad y bajas desde el aviso. */
export interface RentIncreaseResultsDto {
  applied: number;
  skipped: number;
  pending: number;
  /** Más al mes previsto al programarla. */
  plannedMonthly: number;
  /** Más al mes que se cobra ahora (subidos que siguen en vigor). */
  realMonthly: number;
  /** Lo que ya se ha facturado de más desde la subida. */
  extraInvoiced: number;
  /** Cuota mensual de los que se fueron o pidieron la baja tras el aviso. */
  lostMonthly: number;
  left: {
    contractId: string;
    contractNumber: string;
    customerName: string;
    unitCode: string;
    endDate: string | null;
    requestedAt: string | null;
  }[];
}

/** «No subir a este contrato hasta…». `until: null` quita la excepción. */
export const SetRentIncreaseExemptionSchema = z.object({
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  reason: z.string().trim().max(300).optional(),
});
export type SetRentIncreaseExemptionInput = z.infer<typeof SetRentIncreaseExemptionSchema>;
