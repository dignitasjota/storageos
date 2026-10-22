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
  externalUrl: z.string().trim().max(2000).url().optional().or(z.literal('')),
  monthlyCost: z.number().min(0).finite().optional(),
  renewsOn: dateOnly.optional().or(z.literal('')),
  /**
   * Valor de `leads.source`/`leads.utmSource` que se atribuye a este canal
   * (sugerido: la versión normalizada del nombre — se rellena sola si se deja
   * vacío). Vacío = el canal no se cruza con leads (solo tracking de coste).
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
  monthlyCost: number | null;
  renewsOn: string | null;
  utmSourceMatch: string | null;
  externalCampaignId: string | null;
  /** `<slug>` de `/g/<shortCode>` — null si el canal no tiene enlace corto (solo canales físicos lo usan). */
  shortCode: string | null;
  /** URL completa lista para imprimir en un QR/cartel, o null. */
  shortUrl: string | null;
  clickCount: number;
  notes: string | null;
  createdAt: string;
}

// --- Rendimiento: coste ↔ leads ↔ conversión ↔ MRR ---

export interface MarketingPerformanceRowDto {
  channelId: string;
  channelName: string;
  type: MarketingChannelType;
  status: MarketingChannelStatus;
  /** Coste total en el periodo (suma de expenses vinculados). */
  cost: number;
  leadsCount: number;
  wonCount: number;
  /** `cost / leadsCount`; null si no hay leads. */
  costPerLead: number | null;
  /** Coste de adquisición: `cost / wonCount`; null si no hay conversiones. */
  cac: number | null;
  /** MRR vivo (contratos active/ending) de los clientes convertidos por este canal. */
  mrrGenerated: number;
  /** Meses de cuota para recuperar el CAC (`cac / (mrrGenerated / wonCount)`); null si no aplica. */
  paybackMonths: number | null;
}

export interface MarketingPerformanceDto {
  from: string;
  to: string;
  rows: MarketingPerformanceRowDto[];
  totals: { cost: number; leadsCount: number; wonCount: number; mrrGenerated: number };
}

/** Lo que da la plataforma de anuncios + lo que pasa después en TrasterOS. */
export interface AdPerformanceFigures {
  impressions: number;
  clicks: number;
  cost: number;
  /** Conversiones que cuenta Google Ads o Meta Ads. */
  platformConversions: number;
  /** Contactos con el origen del canal (`utmSourceMatch`). */
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

export * from './ad-platforms';
export * from './ad-campaign-draft';
export * from './summary';
