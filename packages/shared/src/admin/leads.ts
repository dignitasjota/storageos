import { z } from 'zod';

import type { PlatformQuoteOfferDto } from './catalog';

/**
 * Leads del panel admin: quien se interesa por TrasterOS, desde el primer
 * contacto hasta que paga (o se pierde). «En prueba» y «Cliente» los marca la
 * cuenta del tenant (al registrarse y con el primer pago); el resto, el equipo.
 */
export const PLATFORM_LEAD_STAGES = [
  'new',
  'contacted',
  'interested',
  'trial',
  'customer',
  'lost',
] as const;
export const PlatformLeadStageEnum = z.enum(PLATFORM_LEAD_STAGES);
export type PlatformLeadStage = z.infer<typeof PlatformLeadStageEnum>;

export const PLATFORM_LEAD_STAGE_LABELS: Record<PlatformLeadStage, string> = {
  new: 'Nuevo',
  contacted: 'Contactado',
  interested: 'Interesado',
  trial: 'En prueba',
  customer: 'Cliente',
  lost: 'Perdido',
};

/** Fases que el equipo mueve a mano (las otras las marca su cuenta). */
export const PLATFORM_LEAD_MANUAL_STAGES = ['new', 'contacted', 'interested'] as const;
export const PlatformLeadManualStageEnum = z.enum(PLATFORM_LEAD_MANUAL_STAGES);

/** Fases abiertas: aún se está trabajando el lead. */
export const PLATFORM_LEAD_OPEN_STAGES: readonly PlatformLeadStage[] = [
  'new',
  'contacted',
  'interested',
  'trial',
];

export const PLATFORM_LEAD_SOURCES = [
  'web_contact',
  'demo',
  'calculator',
  'signup',
  'admin',
  'phone',
  'email',
  'event',
  'referral',
  'social',
  'ads',
  'partner',
  'other',
] as const;
export const PlatformLeadSourceEnum = z.enum(PLATFORM_LEAD_SOURCES);
export type PlatformLeadSource = z.infer<typeof PlatformLeadSourceEnum>;

export const PLATFORM_LEAD_SOURCE_LABELS: Record<PlatformLeadSource, string> = {
  web_contact: 'Formulario de la web',
  demo: 'Petición de demo',
  calculator: 'Calculadora de rentabilidad',
  signup: 'Registro en la web',
  admin: 'Alta desde el panel',
  phone: 'Llamada',
  email: 'Correo',
  event: 'Feria o evento',
  referral: 'Recomendación',
  social: 'Redes sociales',
  ads: 'Anuncios',
  partner: 'Colaborador',
  other: 'Otro',
};

/** Orígenes que se eligen al dar de alta un lead a mano. */
export const PLATFORM_LEAD_MANUAL_SOURCES: readonly PlatformLeadSource[] = [
  'phone',
  'email',
  'event',
  'referral',
  'social',
  'ads',
  'partner',
  'other',
];

export const PLATFORM_LEAD_LOST_REASONS = [
  'price',
  'own_software',
  'competitor',
  'missing_feature',
  'not_now',
  'no_response',
  'no_conversion',
  'other',
] as const;
export const PlatformLeadLostReasonEnum = z.enum(PLATFORM_LEAD_LOST_REASONS);
export type PlatformLeadLostReason = z.infer<typeof PlatformLeadLostReasonEnum>;

export const PLATFORM_LEAD_LOST_REASON_LABELS: Record<PlatformLeadLostReason, string> = {
  price: 'Le parece caro',
  own_software: 'Se queda con su programa',
  competitor: 'Elige otro programa',
  missing_feature: 'Le falta una función',
  not_now: 'No es el momento',
  no_response: 'No responde',
  no_conversion: 'No contrató tras la prueba',
  other: 'Otro',
};

export const PLATFORM_LEAD_ACTIVITY_TYPES = [
  'note',
  'call',
  'demo',
  'meeting',
  'whatsapp',
  'email_out',
  'web_form',
  'signup',
  'quote',
  'system',
] as const;
export type PlatformLeadActivityType = (typeof PLATFORM_LEAD_ACTIVITY_TYPES)[number];

export const PLATFORM_LEAD_ACTIVITY_LABELS: Record<PlatformLeadActivityType, string> = {
  note: 'Nota',
  call: 'Llamada',
  demo: 'Demo',
  meeting: 'Reunión',
  whatsapp: 'WhatsApp',
  email_out: 'Correo enviado',
  web_form: 'Mensaje desde la web',
  signup: 'Se registró',
  quote: 'Propuesta enviada',
  system: 'Automático',
};

/** Lo que el equipo anota a mano. */
export const PlatformLeadManualActivityEnum = z.enum([
  'note',
  'call',
  'demo',
  'meeting',
  'whatsapp',
]);

/** Lo que forma la conversación (lo escrito y lo enviado); el resto es actividad. */
export const PLATFORM_LEAD_CONVERSATION_TYPES: readonly PlatformLeadActivityType[] = [
  'web_form',
  'email_out',
  'quote',
];

/** Horas sin atender a partir de las que un lead nuevo avisa. */
export const PLATFORM_LEAD_UNATTENDED_HOURS = 4;

/** Días tras los que se propone volver a contactar a quien acabó la prueba sin contratar. */
export const PLATFORM_LEAD_TRIAL_RECONTACT_DAYS = 14;

/** Origen de la visita en trasteros.pro (lo guarda el navegador). */
export const PLATFORM_ATTRIBUTION_KEY = '_platform';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida');

const leadFields = {
  companyName: optionalText(160),
  contactName: optionalText(160),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Email no válido')
    .max(200)
    .optional()
    .or(z.literal('')),
  phone: optionalText(40),
  units: optionalText(40),
  facilities: optionalText(40),
  profile: optionalText(160),
  currentSoftware: optionalText(120),
  city: optionalText(120),
  planSlug: optionalText(60),
  assignedToId: z.string().uuid().nullable().optional(),
};

/** Alta a mano (llamadas, ferias, recomendaciones…). */
export const CreatePlatformLeadSchema = z
  .object({
    ...leadFields,
    source: PlatformLeadSourceEnum.default('phone'),
    /** Lo que contó, como primera nota. */
    message: z.string().trim().max(4000).optional().or(z.literal('')),
  })
  .refine((v) => !!(v.companyName || v.contactName), {
    message: 'Indica la empresa o la persona',
    path: ['companyName'],
  })
  .refine((v) => !!(v.email || v.phone), {
    message: 'Indica un email o un teléfono',
    path: ['email'],
  });
export type CreatePlatformLeadInput = z.infer<typeof CreatePlatformLeadSchema>;

export const UpdatePlatformLeadSchema = z.object({
  ...leadFields,
  source: PlatformLeadSourceEnum.optional(),
});
export type UpdatePlatformLeadInput = z.infer<typeof UpdatePlatformLeadSchema>;

export const MovePlatformLeadSchema = z.object({ status: PlatformLeadManualStageEnum });
export type MovePlatformLeadInput = z.infer<typeof MovePlatformLeadSchema>;

export const LosePlatformLeadSchema = z.object({
  reasonCode: PlatformLeadLostReasonEnum,
  reason: z.string().trim().max(1000).optional().or(z.literal('')),
  /** Volver a contactar ese día (crea un seguimiento). */
  recontactOn: dateString.optional().or(z.literal('')),
});
export type LosePlatformLeadInput = z.infer<typeof LosePlatformLeadSchema>;

export const CreatePlatformLeadActivitySchema = z.object({
  type: PlatformLeadManualActivityEnum,
  content: z.string().trim().min(1).max(4000),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type CreatePlatformLeadActivityInput = z.infer<typeof CreatePlatformLeadActivitySchema>;

export const CreatePlatformLeadFollowupSchema = z.object({
  title: z.string().trim().min(2).max(200),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
  dueDate: dateString,
  assignedToId: z.string().uuid().nullable().optional(),
});
export type CreatePlatformLeadFollowupInput = z.infer<typeof CreatePlatformLeadFollowupSchema>;

export const UpdatePlatformLeadFollowupSchema = z
  .object({
    status: z.enum(['pending', 'done']).optional(),
    dueDate: dateString.optional(),
    assignedToId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nada que cambiar' });
export type UpdatePlatformLeadFollowupInput = z.infer<typeof UpdatePlatformLeadFollowupSchema>;

export const SendPlatformLeadEmailSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
});
export type SendPlatformLeadEmailInput = z.infer<typeof SendPlatformLeadEmailSchema>;

export const LinkPlatformLeadTenantSchema = z.object({ tenantId: z.string().uuid() });
export type LinkPlatformLeadTenantInput = z.infer<typeof LinkPlatformLeadTenantSchema>;

export const PlatformLeadsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  source: PlatformLeadSourceEnum.optional(),
  /** `me` = los míos; un id = los de ese super admin; `none` = sin responsable. */
  assignedTo: z.string().trim().max(60).optional(),
});
export type PlatformLeadsQuery = z.infer<typeof PlatformLeadsQuerySchema>;

/** Origen de la visita que se manda con el formulario y el registro. */
export const platformAttributionFields = {
  utmSource: z.string().trim().max(120).optional(),
  utmMedium: z.string().trim().max(120).optional(),
  utmCampaign: z.string().trim().max(120).optional(),
};

// ---------------------------------------------------------------------- DTO

export interface PlatformLeadTenantRefDto {
  id: string;
  name: string;
  slug: string;
}

export interface PlatformLeadDto {
  id: string;
  status: PlatformLeadStage;
  source: PlatformLeadSource;
  /** La empresa o, sin ella, la persona. */
  displayName: string;
  companyName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  units: string | null;
  facilities: string | null;
  profile: string | null;
  currentSoftware: string | null;
  city: string | null;
  planSlug: string | null;
  planName: string | null;
  message: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  /** Su cuenta, si ya la tiene. */
  tenant: PlatformLeadTenantRefDto | null;
  /** Una cuenta con su email, si aún no está vinculado. */
  existingTenant: PlatformLeadTenantRefDto | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  contactedAt: string | null;
  interestedAt: string | null;
  trialAt: string | null;
  customerAt: string | null;
  lostAt: string | null;
  lostReasonCode: PlatformLeadLostReason | null;
  lostReason: string | null;
  firstResponseAt: string | null;
  lastActivityAt: string | null;
  nextFollowup: { id: string; title: string; dueDate: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformLeadBoardDto {
  items: PlatformLeadDto[];
  /** Total por fase (Cliente y Perdido solo traen los últimos). */
  counts: Record<PlatformLeadStage, number>;
}

export interface PlatformLeadActivityDto {
  id: string;
  type: PlatformLeadActivityType;
  subject: string | null;
  content: string;
  occurredAt: string;
  superAdminName: string | null;
}

export interface PlatformLeadFollowupDto {
  id: string;
  leadId: string;
  leadName: string;
  title: string;
  note: string | null;
  dueDate: string;
  status: 'pending' | 'done';
  completedAt: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  createdAt: string;
}

export interface PlatformLeadDetailDto extends PlatformLeadDto {
  activities: PlatformLeadActivityDto[];
  followups: PlatformLeadFollowupDto[];
  quoteOffers: PlatformQuoteOfferDto[];
}

export interface PlatformLeadStatsSourceDto {
  source: PlatformLeadSource;
  leads: number;
  trials: number;
  customers: number;
  /** Lo que pagan al mes los que son clientes (plan + extras). */
  mrr: number;
  /** % de leads que acabaron pagando. */
  conversionPct: number | null;
}

export interface PlatformLeadStatsDto {
  months: number;
  from: string;
  leads: number;
  /** Cuántos llegaron a cada fase (o más allá). */
  funnel: { stage: Exclude<PlatformLeadStage, 'lost'>; reached: number }[];
  lost: number;
  bySource: PlatformLeadStatsSourceDto[];
  lostReasons: { code: PlatformLeadLostReason; count: number }[];
  /** Mediana de horas hasta la primera respuesta (null sin datos). */
  medianFirstResponseHours: number | null;
  /** Media de días del alta del lead al primer pago. */
  avgDaysToCustomer: number | null;
  mrr: number;
}

/** Nombre a mostrar: la empresa o la persona. */
export function platformLeadName(l: {
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
}): string {
  return l.companyName?.trim() || l.contactName?.trim() || l.email || 'Sin nombre';
}

/** Rellena `{empresa}` y `{nombre}` de una respuesta guardada para un lead. */
export function fillPlatformLeadTemplate(
  text: string,
  lead: { companyName?: string | null; contactName?: string | null },
): string {
  const company = lead.companyName?.trim() || lead.contactName?.trim() || '';
  const name = lead.contactName?.trim().split(/\s+/)[0] || company;
  return text.replace(/\{empresa\}/g, company).replace(/\{nombre\}/g, name);
}
