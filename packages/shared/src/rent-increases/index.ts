import { z } from 'zod';

export const RentIncreaseStatusEnum = z.enum(['scheduled', 'applied', 'cancelled']);
export type RentIncreaseStatusValue = z.infer<typeof RentIncreaseStatusEnum>;

export const RentIncreaseTypeEnum = z.enum(['percentage', 'fixed']);
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
  const max = v.increaseType === 'percentage' ? RENT_INCREASE_MAX_PCT : RENT_INCREASE_MAX_FIXED;
  if (v.increaseValue > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['increaseValue'],
      message:
        v.increaseType === 'percentage'
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
  })
  .superRefine(checkValue);
export type CreateRentIncreaseInput = z.infer<typeof CreateRentIncreaseSchema>;

/** Por qué un contrato del alcance se queda fuera de la tanda. */
export const RENT_INCREASE_EXCLUSIONS = [
  'ending',
  'leaving_before',
  'housing',
  'already_scheduled',
  'recently_raised',
  'cap_reached',
] as const;
export type RentIncreaseExclusion = (typeof RENT_INCREASE_EXCLUSIONS)[number];

export const RENT_INCREASE_EXCLUSION_LABELS: Record<RentIncreaseExclusion, string> = {
  ending: 'Han pedido la baja',
  leaving_before: 'Su contrato termina antes de esa fecha',
  housing: 'Son viviendas (se actualizan en su aniversario)',
  already_scheduled: 'Ya tienen un cambio de cuota programado',
  recently_raised: 'Les subiste la cuota hace poco (política de subidas)',
  cap_reached: 'Ya llegaron al tope anual de la política',
};

/** Por qué un contrato de la tanda no se subió al llegar su fecha. */
export const RENT_INCREASE_SKIP_LABELS: Record<string, string> = {
  contract_not_active: 'El contrato ya no está en vigor',
  contract_ending: 'Pidió la baja',
  price_changed: 'Su cuota cambió después del aviso',
  cancelled: 'Tanda cancelada',
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
