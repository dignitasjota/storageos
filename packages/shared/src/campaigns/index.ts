import { z } from 'zod';

import { LeadStatusEnum } from '../communications/schemas';

/** `scheduled` = correos ya encolados para la fecha programada (aún se puede cancelar). */
export const CampaignStatusEnum = z.enum(['draft', 'sending', 'scheduled', 'sent', 'cancelled']);
export type CampaignStatusValue = z.infer<typeof CampaignStatusEnum>;

/**
 * Criterios de segmentación de una campaña (discriminados por audiencia).
 * - `customers`: por contrato activo, morosidad y tag.
 * - `leads`: por estado y origen.
 */
export const CustomerSegmentSchema = z.object({
  audience: z.literal('customers'),
  /**
   * active = con contrato active/ending; none = sin él; any = todos;
   * former = ex-clientes (tuvieron un contrato ended/cancelled y ninguno
   * activo) → segmento de win-back.
   */
  contractStatus: z.enum(['active', 'none', 'any', 'former']).default('any'),
  /** Solo clientes con facturas vencidas (morosos). */
  overdueOnly: z.boolean().default(false),
  /** Selección hecha en la lista de inquilinos. */
  customerIds: z.array(z.string().uuid()).min(1).max(5000).optional(),
  /** Solo clientes con este tag. */
  tag: z.string().trim().max(60).optional().or(z.literal('')),
  /** Solo clientes de este local (por sus contratos). */
  facilityId: z.string().uuid().optional(),
  /** Antigüedad como cliente (desde su primer contrato firmado), en meses. */
  minMonths: z.number().int().min(0).max(600).optional(),
  maxMonths: z.number().int().min(0).max(600).optional(),
  /** Con un contrato en vigor de este tamaño de trastero. */
  unitTypeId: z.string().uuid().optional(),
  /** Con algún contrato en vigor sin protección de contenido. */
  withoutInsurance: z.boolean().optional(),
  /** Con un contrato que vence en los próximos N días. */
  endingWithinDays: z.number().int().min(1).max(365).optional(),
  /** Idioma del inquilino. */
  locale: z.enum(['es', 'en']).optional(),
  /** Sin facturas vencidas ni expedientes de impago. */
  excludeDebtors: z.boolean().optional(),
  /** Sin quien recibió otra comunicación comercial en los últimos N días. */
  excludeRecentDays: z.number().int().min(1).max(90).optional(),
});

export const LeadSegmentSchema = z.object({
  audience: z.literal('leads'),
  leadStatus: LeadStatusEnum.optional(),
  leadSource: z.string().trim().min(1).max(60).optional(),
  /** Solo contactos que prefieren este local. */
  facilityId: z.string().uuid().optional(),
  /** Contactos que llegaron en los últimos N días. */
  createdWithinDays: z.number().int().min(1).max(730).optional(),
  /** Sin quien recibió otra comunicación comercial en los últimos N días. */
  excludeRecentDays: z.number().int().min(1).max(90).optional(),
});

export const CampaignSegmentSchema = z.discriminatedUnion('audience', [
  CustomerSegmentSchema,
  LeadSegmentSchema,
]);
export type CampaignSegmentInput = z.infer<typeof CampaignSegmentSchema>;

export const CampaignChannelEnum = z.enum(['email', 'whatsapp']);
export type CampaignChannel = z.infer<typeof CampaignChannelEnum>;

/** Plantilla aprobada de WhatsApp: los parámetros admiten variables. */
export const CampaignWhatsappTemplateSchema = z.object({
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(15),
  params: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
});
export type CampaignWhatsappTemplate = z.infer<typeof CampaignWhatsappTemplateSchema>;

export const CreateCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** `email` por defecto; `whatsapp` con una plantilla aprobada del número del negocio. */
  channel: CampaignChannelEnum.default('email'),
  subject: z.string().trim().min(2).max(200),
  /**
   * Cuerpo del email; admite `{{customer.firstName}}` / `{{lead.firstName}}`,
   * `**negrita**`, `[texto](https://…)` y `[[boton: Texto | https://…]]`.
   */
  bodyText: z.string().trim().min(2).max(20_000),
  /** Versión en inglés para los inquilinos con ese idioma (opcional). */
  subjectEn: z.string().trim().max(200).optional().or(z.literal('')),
  bodyTextEn: z.string().trim().max(20_000).optional().or(z.literal('')),
  /** Cupón que se ofrece (`{{coupon.code}}`); sus usos salen en los resultados. */
  couponCode: z.string().trim().max(40).optional().or(z.literal('')),
  whatsappTemplate: CampaignWhatsappTemplateSchema.optional(),
  segment: CampaignSegmentSchema,
  /** Programar el envío (ISO). Si se omite, se envía de inmediato al pulsar Enviar. */
  scheduledFor: z.string().datetime({ offset: true }).optional(),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

/** Cambios en un borrador (todo opcional; `scheduledFor: null` quita la programación). */
export const UpdateCampaignSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    subject: z.string().trim().min(2).max(200).optional(),
    bodyText: z.string().trim().min(2).max(20_000).optional(),
    subjectEn: z.string().trim().max(200).optional().or(z.literal('')),
    bodyTextEn: z.string().trim().max(20_000).optional().or(z.literal('')),
    couponCode: z.string().trim().max(40).optional().or(z.literal('')),
    whatsappTemplate: CampaignWhatsappTemplateSchema.nullable().optional(),
    segment: CampaignSegmentSchema.optional(),
    scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignSchema>;

/** Previsualiza el tamaño de la audiencia antes de crear/enviar. */
export const PreviewCampaignSchema = z.object({
  segment: CampaignSegmentSchema,
  channel: CampaignChannelEnum.default('email'),
});
export type PreviewCampaignInput = z.infer<typeof PreviewCampaignSchema>;

export interface CampaignDto {
  id: string;
  name: string;
  channel: CampaignChannel;
  subject: string;
  bodyText: string;
  subjectEn: string | null;
  bodyTextEn: string | null;
  couponCode: string | null;
  whatsappTemplate: CampaignWhatsappTemplate | null;
  /** Quién la creó. */
  createdByName: string | null;
  segment: CampaignSegmentInput;
  status: CampaignStatusValue;
  audienceCount: number;
  sentCount: number;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface CampaignPreviewDto {
  /** Destinatarios que recibirían la campaña (con email, o con móvil por WhatsApp). */
  audienceCount: number;
  /** De ellos, los que recibieron otra comunicación comercial en los últimos 7 días. */
  recentlyContacted: number;
  /** De ellos, los inquilinos en inglés (reciben la versión en inglés si la hay). */
  english: number;
}

// ============================================================================
// Win-back automático de bajas
// ============================================================================

/** Sugerencias por defecto para la oferta de vuelta (editables por el operador). */
export const DEFAULT_WINBACK_SUBJECT = 'Te echamos de menos 👋';
export const DEFAULT_WINBACK_BODY =
  'Hola {{customer.firstName}},\n\n' +
  'Hace un tiempo confiaste en {{tenant.name}} para guardar tus cosas. ' +
  'Si vuelves a necesitar espacio, nos encantaría verte de nuevo — y esta vez con una oferta especial.\n\n' +
  'Escríbenos o pásate por el local y te lo ponemos fácil.\n\n' +
  'Un saludo,\n{{tenant.name}}';

export const UpdateWinbackSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Días tras la baja para enviar la oferta de vuelta. */
    delayDays: z.number().int().min(1).max(730).optional(),
    subject: z.string().trim().max(200).optional().or(z.literal('')),
    bodyText: z.string().trim().max(20_000).optional().or(z.literal('')),
    /** Segundo aviso a quien no volvió, con un cupón. */
    secondEnabled: z.boolean().optional(),
    /** Días tras el primer aviso. */
    secondDelayDays: z.number().int().min(7).max(365).optional(),
    secondSubject: z.string().trim().max(200).optional().or(z.literal('')),
    secondBodyText: z.string().trim().max(20_000).optional().or(z.literal('')),
    /** Código del cupón que se ofrece (debe existir en Cupones). */
    secondCouponCode: z.string().trim().max(40).optional().or(z.literal('')),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWinbackSettingsInput = z.infer<typeof UpdateWinbackSettingsSchema>;

export interface WinbackSettingsResponse {
  enabled: boolean;
  delayDays: number;
  /** null = se usa el texto por defecto (`DEFAULT_WINBACK_*`). */
  subject: string | null;
  bodyText: string | null;
  secondEnabled: boolean;
  secondDelayDays: number;
  secondSubject: string | null;
  secondBodyText: string | null;
  secondCouponCode: string | null;
}

/** A cuántos ex-clientes escribiría «Enviar ahora». */
export interface WinbackPreviewDto {
  firstStep: number;
  secondStep: number;
}

export interface WinbackRunResultDto {
  /** Ex-clientes a los que se les encoló la oferta en esta ejecución. */
  sent: number;
  /** Segundos avisos encolados. */
  secondSent: number;
}

/** Ex-clientes que recibieron el win-back y volvieron a firmar. */
export interface WinbackStatsDto {
  firstSent: number;
  secondSent: number;
  recovered: number;
  /** % de recuperados sobre los que recibieron el primer aviso. */
  recoveryRate: number | null;
}

export const DEFAULT_WINBACK_SECOND_SUBJECT = 'Última oportunidad: vuelve con descuento';
export const DEFAULT_WINBACK_SECOND_BODY =
  'Hola {{customer.firstName}},\n\nTe guardamos un descuento para que vuelvas a {{tenant.name}}. Usa el cupón {{coupon.code}} al reservar tu trastero.\n\nUn saludo,\n{{tenant.name}}';

// ============================================================================
// Resultados de una campaña
// ============================================================================

export interface CampaignLinkResultDto {
  url: string;
  clicks: number;
}

/** Lo que pasó después: contratos, contactos ganados y usos del cupón. */
export interface CampaignConversionsDto {
  /** Días tras el envío que se cuentan. */
  windowDays: number;
  /** Destinatarios que firmaron un contrato después. */
  contracts: number;
  /** Cuota mensual de esos contratos (sin IVA). */
  monthlyRevenue: number;
  /** Contactos que pasaron a ganados. */
  leadsWon: number;
  /** Usos del cupón de la campaña por sus destinatarios. */
  couponUses: number;
}

export interface CampaignResultsDto {
  campaignId: string;
  conversions?: CampaignConversionsDto;
  recipients: number;
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  skipped: number;
  /** Destinatarios que se dieron de baja de las comunicaciones comerciales tras recibirla. */
  unsubscribed: number;
  /** Destinatarios distintos que pulsaron algún enlace. */
  clickers: number;
  /** % de destinatarios enviados que pulsaron algún enlace. */
  clickRate: number | null;
  links: CampaignLinkResultDto[];
}

// ============================================================================
// Plantillas de campaña y vista previa
// ============================================================================

export const CreateCampaignTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20_000),
});
export type CreateCampaignTemplateInput = z.infer<typeof CreateCampaignTemplateSchema>;

export const UpdateCampaignTemplateSchema = CreateCampaignTemplateSchema.partial();
export type UpdateCampaignTemplateInput = z.infer<typeof UpdateCampaignTemplateSchema>;

export interface CampaignTemplateDto {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  updatedAt: string;
}

export const CampaignEmailPreviewSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20_000),
  audience: z.enum(['customers', 'leads']).default('customers'),
  couponCode: z.string().trim().max(40).optional().or(z.literal('')),
});
export type CampaignEmailPreviewInput = z.infer<typeof CampaignEmailPreviewSchema>;

export interface CampaignEmailPreviewDto {
  subject: string;
  html: string;
}

// ============================================================================
// Variables de los textos (asunto y mensaje)
// ============================================================================

/** Variables que se pueden usar en una campaña, según a quién va. */
export const CAMPAIGN_TEMPLATE_VARIABLES = {
  customers: ['customer.firstName', 'customer.lastName', 'customer.displayName', 'tenant.name'],
  leads: ['lead.firstName', 'lead.displayName', 'tenant.name'],
} as const;

/** Las del win-back (siempre a ex-clientes); el segundo aviso añade el cupón. */
export const WINBACK_TEMPLATE_VARIABLES = CAMPAIGN_TEMPLATE_VARIABLES.customers;
export const WINBACK_SECOND_TEMPLATE_VARIABLES = [
  ...CAMPAIGN_TEMPLATE_VARIABLES.customers,
  'coupon.code',
] as const;

/** Las de una plantilla guardada (vale para inquilinos y contactos). */
export const CAMPAIGN_SAVED_TEMPLATE_VARIABLES = [
  ...new Set([
    ...CAMPAIGN_TEMPLATE_VARIABLES.customers,
    ...CAMPAIGN_TEMPLATE_VARIABLES.leads,
    'coupon.code',
  ]),
];

/** Variables de una campaña: las de su audiencia y, si ofrece un cupón, su código. */
export function campaignTemplateVariables(
  audience: 'customers' | 'leads',
  withCoupon: boolean,
): readonly string[] {
  const base = CAMPAIGN_TEMPLATE_VARIABLES[audience];
  return withCoupon ? [...base, 'coupon.code'] : base;
}

const VARIABLE_NAME = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

/**
 * Problemas de un texto con variables `{{…}}`: una sin cerrar, una que no
 * existe o algo que no es una variable simple. Vacío = está bien.
 */
export function templateTextProblems(text: string, allowed: readonly string[]): string[] {
  const problems: string[] = [];
  const unknown = new Set<string>();
  let unsupported = false;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open === -1) break;
    const close = text.indexOf('}}', open + 2);
    const nextOpen = text.indexOf('{{', open + 2);
    if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
      const sample = text.slice(open, open + 25).split('\n')[0];
      problems.push(`Hay una variable sin cerrar: falta «}}» en «${sample}».`);
      return problems;
    }
    let inner = text.slice(open + 2, close).trim();
    // {{{x}}}: igual que {{x}} sin escapar.
    if (inner.startsWith('{')) inner = inner.slice(1).trim();
    if (inner.endsWith('}')) inner = inner.slice(0, -1).trim();
    if (!VARIABLE_NAME.test(inner)) unsupported = true;
    else if (!allowed.includes(inner)) unknown.add(inner);
    i = close + 2;
  }
  if (unknown.size > 0) {
    problems.push(
      `${unknown.size === 1 ? 'Esta variable no existe' : 'Estas variables no existen'}: ${[
        ...unknown,
      ]
        .map((v) => `{{${v}}}`)
        .join(', ')}. Puedes usar ${allowed.map((v) => `{{${v}}}`).join(', ')}.`,
    );
  }
  if (unsupported) {
    problems.push(
      `Solo se pueden usar variables simples, como {{${allowed[0] ?? 'tenant.name'}}}.`,
    );
  }
  return problems;
}
export * from './markup';

// ============================================================================
// Quién la recibió (para los resultados)
// ============================================================================

export const CampaignRecipientFilterEnum = z.enum([
  'clicked',
  'bounced',
  'unsubscribed',
  'converted',
  'failed',
]);
export type CampaignRecipientFilter = z.infer<typeof CampaignRecipientFilterEnum>;

export interface CampaignRecipientDto {
  recipient: string;
  name: string | null;
  customerId: string | null;
  leadId: string | null;
  /** Motivo (rebote, fallo) o detalle (contrato firmado). */
  detail: string | null;
}

// ============================================================================
// Segmentos guardados
// ============================================================================

export const SaveCampaignSegmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  segment: CampaignSegmentSchema,
});
export type SaveCampaignSegmentInput = z.infer<typeof SaveCampaignSegmentSchema>;

export interface CampaignSavedSegmentDto {
  id: string;
  name: string;
  segment: CampaignSegmentInput;
  createdAt: string;
}

// ============================================================================
// Prueba a uno mismo
// ============================================================================

export const CampaignTestSendSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20_000),
  audience: z.enum(['customers', 'leads']).default('customers'),
  /** Enviar la versión en inglés. */
  english: z.boolean().default(false),
  couponCode: z.string().trim().max(40).optional().or(z.literal('')),
});
export type CampaignTestSendInput = z.infer<typeof CampaignTestSendSchema>;

export interface CampaignTestSendResultDto {
  sentTo: string;
}

// ============================================================================
// Campañas automáticas
// ============================================================================

/**
 * - `anniversary`: a los inquilinos con contrato en vigor el día que cumplen
 *   años con el negocio (una vez al año);
 * - `cold_leads`: a los contactos con consentimiento que llevan N días sin
 *   avanzar (una vez).
 */
export const CampaignAutomationKindEnum = z.enum(['anniversary', 'cold_leads']);
export type CampaignAutomationKind = z.infer<typeof CampaignAutomationKindEnum>;

export const CAMPAIGN_AUTOMATION_DEFAULTS: Record<
  CampaignAutomationKind,
  { label: string; subject: string; bodyText: string; days: number }
> = {
  anniversary: {
    label: 'Aniversario del contrato',
    subject: '¡Gracias por este año con nosotros, {{customer.firstName}}!',
    bodyText:
      'Hola {{customer.firstName}},\n\nHoy hace un año más que guardas tus cosas en {{tenant.name}}. Gracias por confiar en nosotros.\n\nSi necesitas más espacio o cualquier cosa, escríbenos.\n\nUn saludo,\n{{tenant.name}}',
    days: 0,
  },
  cold_leads: {
    label: 'Contactos que no avanzan',
    subject: '¿Sigues buscando trastero, {{lead.firstName}}?',
    bodyText:
      'Hola {{lead.firstName}},\n\nHace un tiempo nos preguntaste por un trastero. Si sigues buscando, cuéntanos qué necesitas y te ayudamos a encontrar el tamaño adecuado.\n\nUn saludo,\n{{tenant.name}}',
    days: 30,
  },
};

export const UpdateCampaignAutomationSchema = z
  .object({
    enabled: z.boolean().optional(),
    subject: z.string().trim().max(200).optional().or(z.literal('')),
    bodyText: z.string().trim().max(20_000).optional().or(z.literal('')),
    /** Contactos que no avanzan: días sin moverse. */
    days: z.number().int().min(7).max(365).optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateCampaignAutomationInput = z.infer<typeof UpdateCampaignAutomationSchema>;

export interface CampaignAutomationDto {
  kind: CampaignAutomationKind;
  enabled: boolean;
  /** null = el texto por defecto. */
  subject: string | null;
  bodyText: string | null;
  days: number;
  /** Enviados en los últimos 30 días. */
  sentLast30Days: number;
}
