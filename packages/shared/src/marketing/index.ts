import { z } from 'zod';

/**
 * Control de marketing: catálogo de canales/campañas de captación (portales
 * inmobiliarios, Google/Meta Ads, publicidad física...). El coste real se
 * imputa vinculando un `Expense` (categoría `marketing`) al canal; los leads
 * se atribuyen comparando `leads.source`/`leads.utmSource` contra
 * `utmSourceMatch`. Ver `apps/api/src/modules/marketing/`.
 */

export const MarketingChannelTypeEnum = z.enum([
  'real_estate_portal',
  'google_ads',
  'meta_ads',
  'physical',
  'referral_program',
  'other',
]);
export type MarketingChannelType = z.infer<typeof MarketingChannelTypeEnum>;

export const MARKETING_CHANNEL_TYPE_LABELS: Record<MarketingChannelType, string> = {
  real_estate_portal: 'Portal inmobiliario',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads (Facebook/Instagram)',
  physical: 'Publicidad física',
  referral_program: 'Programa de referidos',
  other: 'Otro',
};

export const MarketingChannelStatusEnum = z.enum(['active', 'paused', 'ended']);
export type MarketingChannelStatus = z.infer<typeof MarketingChannelStatusEnum>;

export const MARKETING_CHANNEL_STATUS_LABELS: Record<MarketingChannelStatus, string> = {
  active: 'Activo',
  paused: 'Pausado',
  ended: 'Finalizado',
};

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

export const CreateMarketingChannelSchema = z.object({
  facilityId: z.string().uuid().nullish(),
  /** Promoción vinculada (código de descuento) para atribución offline (carteles, flyers…). */
  promotionId: z.string().uuid().nullish(),
  /** Landing de promoción a la que lleva el enlace corto / QR (si no, la reserva). */
  promoLandingId: z.string().uuid().nullish(),
  type: MarketingChannelTypeEnum.default('other'),
  name: z.string().trim().min(1).max(160),
  status: MarketingChannelStatusEnum.default('active'),
  /** Solo direcciones web (http o https). */
  externalUrl: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'Pon una dirección que empiece por http:// o https://')
    .optional()
    .or(z.literal('')),
  /** null o vacío: sin coste mensual estimado. */
  monthlyCost: z.number().min(0).max(1_000_000).finite().nullable().optional(),
  renewsOn: dateOnly.optional().or(z.literal('')),
  /**
   * Cada cuántos meses se renueva (1 = mensual, 12 = anual): pasada la fecha,
   * avanza sola. null o vacío: no se renueva.
   */
  renewalMonths: z.number().int().min(1).max(36).nullable().optional(),
  /**
   * Orígenes (`utm_source`) que se atribuyen a este canal, separados por comas.
   * Vacío: se propone según el tipo (Google Ads → `google`, Meta Ads →
   * `facebook, instagram`, un portal conocido por su nombre) o el nombre.
   */
  utmSourceMatch: z.string().trim().max(120).optional().or(z.literal('')),
  /**
   * ID de campaña en Google Ads / Meta Ads (según `type`) para sincronizar
   * su gasto automáticamente — requiere haber configurado las credenciales
   * de esa plataforma. Vacío = coste manual (vinculando un gasto), como hoy.
   */
  externalCampaignId: z.string().trim().max(120).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type CreateMarketingChannelInput = z.infer<typeof CreateMarketingChannelSchema>;

export const UpdateMarketingChannelSchema = CreateMarketingChannelSchema.partial();
export type UpdateMarketingChannelInput = z.infer<typeof UpdateMarketingChannelSchema>;

export interface MarketingChannelDto {
  id: string;
  facilityId: string | null;
  facilityName: string | null;
  promotionId: string | null;
  promotionCode: string | null;
  promoLandingId: string | null;
  promoLandingName: string | null;
  /**
   * Dirección de la landing con las variables de seguimiento de este canal
   * (para pegar en un anuncio o en la bio de Instagram), o null sin landing.
   */
  landingUrl: string | null;
  type: MarketingChannelType;
  name: string;
  status: MarketingChannelStatus;
  externalUrl: string | null;
  /** null sin coste estimado o sin permiso para ver los gastos. */
  monthlyCost: number | null;
  renewsOn: string | null;
  renewalMonths: number | null;
  utmSourceMatch: string | null;
  /**
   * Otro canal con el mismo origen: los contactos de ese origen van al activo
   * más antiguo, salvo que el enlace lleve la campaña del canal. null si no hay.
   */
  sourceConflictWith: string | null;
  externalCampaignId: string | null;
  /** `<slug>` de `/g/<shortCode>` — null si el canal no tiene enlace corto (solo canales físicos lo usan). */
  shortCode: string | null;
  /** URL completa lista para imprimir en un QR/cartel, o null. */
  shortUrl: string | null;
  clickCount: number;
  /** Última sincronización del gasto con la plataforma de anuncios (null si nunca). */
  lastSyncAt: string | null;
  /** Error de la última sincronización (null si fue bien). */
  lastSyncError: string | null;
  /** Desde cuándo falla sin parar (null si va bien). */
  syncFailingSince: string | null;
  notes: string | null;
  createdAt: string;
}

/** Qué importes puede ver quien consulta (según sus permisos). */
export interface MarketingMoneyAccess {
  /** Cobrado e ingresos (facturas y cobros). */
  revenue: boolean;
  /** Gasto y costes (gastos). */
  cost: boolean;
}

// --- Rendimiento: coste ↔ leads ↔ conversión ↔ MRR ---

export interface MarketingPerformanceRowDto {
  channelId: string;
  channelName: string;
  type: MarketingChannelType;
  status: MarketingChannelStatus;
  /** Canal borrado que tuvo gasto o resultados en el periodo. */
  deleted: boolean;
  /** Coste en el periodo (gastos vinculados); 0 sin permiso para ver los gastos. */
  cost: number;
  /** Contactos creados en el periodo y atribuidos al canal. */
  leadsCount: number;
  /**
   * Clientes: contratos firmados en el periodo (sin cancelar) de contactos del
   * canal o con su promoción.
   */
  wonCount: number;
  /** `cost / leadsCount`; null si no hay contactos o sin permiso. */
  costPerLead: number | null;
  /** Coste por cliente: `cost / wonCount`; null si no hay clientes o sin permiso. */
  cac: number | null;
  /** Cuota mensual de esos clientes que siguen; 0 sin permiso para ver los ingresos. */
  mrrGenerated: number;
  /** Clientes que siguen (contrato en vigor). */
  liveCount: number;
  /** Meses de cuota para recuperar el coste por cliente (con la cuota media de los que siguen). */
  paybackMonths: number | null;
}

export interface MarketingPerformanceDto {
  from: string;
  to: string;
  rows: MarketingPerformanceRowDto[];
  totals: { cost: number; leadsCount: number; wonCount: number; mrrGenerated: number };
  /** Gasto de marketing del periodo sin canal vinculado (0 sin permiso). */
  unassignedCost: number;
  money: MarketingMoneyAccess;
}

/** Lo que da la plataforma de anuncios + lo que pasa después en TrasterOS. */
export interface AdPerformanceFigures {
  impressions: number;
  clicks: number;
  cost: number;
  /** Conversiones que cuenta Google Ads o Meta Ads. */
  platformConversions: number;
  /** Contactos atribuidos al canal (su campaña o su origen de pago). */
  contacts: number;
  /** Reservas / contratos de esos contactos. */
  bookings: number;
  signed: number;
}

export interface AdPerformanceRatios {
  /** Clics / impresiones (0-1); null sin impresiones. */
  ctr: number | null;
  /** Coste por clic; null sin clics. */
  cpc: number | null;
  costPerContact: number | null;
  costPerBooking: number | null;
}

export interface AdPerformanceRowDto extends AdPerformanceFigures, AdPerformanceRatios {
  channelId: string;
  channelName: string;
  platform: 'google_ads' | 'meta_ads';
  externalCampaignId: string | null;
  /** Último día con datos de la plataforma (null si aún no se ha sincronizado). */
  lastDataDate: string | null;
}

export interface AdPerformanceDto {
  from: string;
  to: string;
  rows: AdPerformanceRowDto[];
  totals: AdPerformanceFigures & AdPerformanceRatios;
  /** Sin permiso para ver los gastos, el gasto y los costes salen a 0 / null. */
  money: MarketingMoneyAccess;
}

const ratio = (a: number, b: number, digits: number) =>
  b > 0 ? Math.round((a / b) * 10 ** digits) / 10 ** digits : null;

/** CTR, coste por clic, por contacto y por reserva. */
export function adPerformanceRatios(f: AdPerformanceFigures): AdPerformanceRatios {
  return {
    ctr: ratio(f.clicks, f.impressions, 4),
    cpc: ratio(f.cost, f.clicks, 2),
    costPerContact: f.cost > 0 ? ratio(f.cost, f.contacts, 2) : null,
    costPerBooking: f.cost > 0 ? ratio(f.cost, f.bookings, 2) : null,
  };
}

/** Generar y consultar el enlace corto de un canal (`/g/<code>` → redirige con UTM). */
export interface MarketingShortLinkResolveDto {
  /** URL destino a la que redirigir (booking del tenant con UTM ya incluidos). */
  targetUrl: string;
}

export * from './attribution';
export * from './ad-platforms';
export * from './ad-campaign-draft';
export * from './summary';
export * from './social';
