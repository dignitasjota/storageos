import { z } from 'zod';

/**
 * Comunicación del panel admin con los tenants: anuncios con historial,
 * segmentos, banners, plantillas de los correos automáticos y encuestas NPS.
 */

// ── Segmento de tenants ─────────────────────────────────────────────────────

export const TenantHealthLevelEnum = z.enum(['healthy', 'warm', 'at_risk', 'dormant']);

/** A quién va un anuncio o una encuesta. Todos los filtros se combinan (AND). */
export const AnnouncementSegmentSchema = z.object({
  audience: z.enum(['active', 'trial', 'all']).default('active'),
  /** Tenants concretos: manda sobre el resto de filtros (nunca los dados de baja). */
  tenantIds: z.array(z.string().uuid()).max(500).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  /** Slugs de plan. */
  plans: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  /** Tienen contratado (y activo) alguno de estos extras (slug). */
  addons: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  /** No tienen contratado ninguno de estos extras (slug). */
  missingAddons: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  /** Nivel de salud. */
  health: z.array(TenantHealthLevelEnum).max(4).optional(),
  /** Nadie del equipo ha entrado en estos días o más. */
  inactiveDays: z.number().int().min(1).max(365).optional(),
  minFacilities: z.number().int().min(0).max(1000).optional(),
  maxFacilities: z.number().int().min(0).max(1000).optional(),
});
export type AnnouncementSegment = z.infer<typeof AnnouncementSegmentSchema>;

// ── Anuncios ────────────────────────────────────────────────────────────────

export const PlatformAnnouncementStatusEnum = z.enum([
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
]);
export type PlatformAnnouncementStatus = z.infer<typeof PlatformAnnouncementStatusEnum>;

export const PLATFORM_ANNOUNCEMENT_STATUS_LABELS: Record<PlatformAnnouncementStatus, string> = {
  draft: 'Borrador',
  scheduled: 'Programado',
  sending: 'Enviando',
  sent: 'Enviado',
  cancelled: 'Cancelado',
};

export const SavePlatformAnnouncementSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  segment: AnnouncementSegmentSchema,
  commercial: z.boolean().default(false),
});
export type SavePlatformAnnouncementInput = z.infer<typeof SavePlatformAnnouncementSchema>;

/** Enviar ya (sin fecha) o programar. */
export const SendPlatformAnnouncementSchema = z.object({
  scheduledFor: z.string().datetime({ offset: true }).nullable().default(null),
});
export type SendPlatformAnnouncementInput = z.infer<typeof SendPlatformAnnouncementSchema>;

export const AnnouncementPreviewSchema = z.object({
  segment: AnnouncementSegmentSchema,
  commercial: z.boolean().default(false),
});
export type AnnouncementPreviewInput = z.infer<typeof AnnouncementPreviewSchema>;

export interface AnnouncementPreviewDto {
  tenants: number;
  recipients: number;
  optedOut: number;
  /** Hasta 10 nombres de ejemplo. */
  sample: string[];
}

export interface PlatformAnnouncementDto {
  id: string;
  subject: string;
  body: string;
  segment: AnnouncementSegment;
  commercial: boolean;
  status: PlatformAnnouncementStatus;
  scheduledFor: string | null;
  sentAt: string | null;
  tenantsCount: number;
  recipientsCount: number;
  optedOutCount: number;
  /** Cuántos correos del anuncio han llegado, rebotado o fallado (del historial). */
  delivered: number;
  bounced: number;
  failed: number;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Variables de los anuncios y los correos directos. */
export const ADMIN_MESSAGE_VARIABLES = [
  { key: '{empresa}', label: 'Nombre del tenant' },
  { key: '{nombre}', label: 'Nombre del destinatario' },
] as const;

/** Sustituye `{empresa}` y `{nombre}` (sin nombre, «hola»). */
export function fillAdminMessageVariables(
  text: string,
  vars: { empresa: string; nombre?: string | null },
): string {
  const nombre = vars.nombre?.trim().split(/\s+/)[0] ?? '';
  return text.replace(/\{empresa\}/g, vars.empresa).replace(/\{nombre\}/g, nombre);
}

// ── Banners ─────────────────────────────────────────────────────────────────

export const PlatformBannerLevelEnum = z.enum(['info', 'warning', 'critical']);

export const UpsertPlatformBannerSchema = z
  .object({
    message: z.string().trim().min(3).max(500),
    level: PlatformBannerLevelEnum.default('info'),
    enabled: z.boolean().default(true),
    startsAt: z.string().datetime({ offset: true }).nullable().default(null),
    endsAt: z.string().datetime({ offset: true }).nullable().default(null),
    dismissible: z.boolean().default(true),
    /** Ruta del panel (/…) o dirección https. */
    linkUrl: z
      .string()
      .trim()
      .max(300)
      .regex(/^(\/(?!\/)[A-Za-z0-9/_?=&.#-]*|https:\/\/\S+)$/, 'Ruta del panel o dirección https')
      .nullable()
      .default(null),
    linkLabel: z.string().trim().max(40).nullable().default(null),
    plans: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    statuses: z
      .array(z.enum(['active', 'trial', 'suspended']))
      .max(3)
      .default([]),
    priority: z.number().int().min(0).max(100).default(0),
  })
  .refine((b) => !b.startsAt || !b.endsAt || b.startsAt < b.endsAt, {
    message: 'La fecha de fin debe ser posterior a la de inicio',
    path: ['endsAt'],
  });
export type UpsertPlatformBannerInput = z.infer<typeof UpsertPlatformBannerSchema>;

export interface AdminPlatformBannerDto {
  id: string;
  message: string;
  level: 'info' | 'warning' | 'critical';
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  dismissible: boolean;
  linkUrl: string | null;
  linkLabel: string | null;
  plans: string[];
  statuses: string[];
  priority: number;
  /** Se ve ahora (activo y dentro de sus fechas). */
  live: boolean;
  updatedAt: string;
}

// ── Correos enviados ────────────────────────────────────────────────────────

export interface PlatformEmailStatsWeekDto {
  /** Lunes de la semana (YYYY-MM-DD). */
  week: string;
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
}

export interface PlatformEmailStatsKindDto {
  kind: string | null;
  total: number;
  delivered: number;
  bounced: number;
  failed: number;
  suppressed: number;
}

export interface PlatformEmailStatsDto {
  weeks: PlatformEmailStatsWeekDto[];
  byKind: PlatformEmailStatsKindDto[];
}

/** Dirección con rebotes o fallos repetidos (90 días). */
export interface PlatformEmailProblemDto {
  recipient: string;
  tenantId: string | null;
  tenantName: string | null;
  /** Es la de un propietario del tenant. */
  isOwner: boolean;
  bounced: number;
  failed: number;
  lastError: string | null;
  lastAt: string;
}

export interface PlatformEmailBodyDto {
  html: string | null;
  text: string | null;
}

// ── Mensajes directos ───────────────────────────────────────────────────────

export const MessageFileSchema = z.object({
  key: z.string().min(1).max(500),
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  size: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
});
export type MessageFile = z.infer<typeof MessageFileSchema>;

export interface MessageFileDto {
  name: string;
  mimeType: string;
  size: number;
}

export const AdminDirectFileUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
  size: z
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024),
});
export type AdminDirectFileUploadInput = z.infer<typeof AdminDirectFileUploadSchema>;

// ── Correos automáticos editables ───────────────────────────────────────────

export const LIFECYCLE_EMAIL_CODES = [
  'welcome',
  'trial_ending',
  'trial_ended',
  'past_due',
] as const;
export type LifecycleEmailCode = (typeof LIFECYCLE_EMAIL_CODES)[number];

export interface LifecycleEmailDefault {
  label: string;
  description: string;
  subject: string;
  body: string;
  variables: { key: string; label: string }[];
}

const SIGN = '\n\nUn saludo,\nEl equipo de TrasterOS';

/** Textos de serie (Markdown sencillo con variables). */
export const LIFECYCLE_EMAIL_DEFAULTS: Record<LifecycleEmailCode, LifecycleEmailDefault> = {
  welcome: {
    label: 'Bienvenida',
    description: 'Al darse de alta un tenant.',
    subject: '¡Bienvenido a TrasterOS!',
    body:
      '¡Bienvenido a TrasterOS, {empresa}!\n\n' +
      'Gracias por darte de alta. Para entrar al panel te pediremos el identificador de tu empresa: **{identificador}**\n\n' +
      'En el Resumen del panel tienes los primeros pasos para empezar a operar: tu local, los tipos de trastero con sus precios, los trasteros (o impórtalos desde un Excel), los datos de tu empresa y cómo te pagan tus inquilinos.\n\n' +
      'Empezar: {enlace_panel}\n\n' +
      'Tu web pública ya está activa: {enlace_web}\n\n' +
      'Si necesitas ayuda, abre un ticket desde Soporte en tu panel.' +
      SIGN,
    variables: [
      { key: '{empresa}', label: 'Nombre del tenant' },
      { key: '{identificador}', label: 'Identificador para entrar' },
      { key: '{enlace_panel}', label: 'Enlace al panel' },
      { key: '{enlace_web}', label: 'Enlace a su web' },
    ],
  },
  trial_ending: {
    label: 'La prueba termina pronto',
    description: '7, 3 y 1 día antes del fin de la prueba.',
    subject: 'Tu prueba de TrasterOS termina en {dias}',
    body:
      'Hola, {empresa}:\n\n' +
      'Tu periodo de prueba termina en {dias}. Para no perder el acceso a tu cuenta ni a tus datos, suscríbete a un plan antes de que finalice:\n\n' +
      '{enlace_pago}\n\n' +
      'Elige el plan que mejor se ajuste a tu operativa; puedes cambiarlo en cualquier momento.\n\n' +
      '{limites}\n\n' +
      '¿Dudas sobre qué plan te conviene? Escríbenos desde Soporte en tu panel.' +
      SIGN,
    variables: [
      { key: '{empresa}', label: 'Nombre del tenant' },
      { key: '{dias}', label: 'Días que quedan («3 días»)' },
      { key: '{enlace_pago}', label: 'Enlace a la suscripción' },
      { key: '{limites}', label: 'Lo que supera del plan gratuito (si algo)' },
    ],
  },
  trial_ended: {
    label: 'La prueba ha terminado',
    description: 'Al pasar al plan gratuito por fin de la prueba.',
    subject: 'Tu prueba de TrasterOS ha terminado',
    body:
      'Hola, {empresa}:\n\n' +
      'Tu periodo de prueba de TrasterOS ha terminado y tu cuenta ha pasado al plan gratuito. Tus datos siguen ahí y puedes seguir entrando, pero las funciones de pago quedan desactivadas hasta que contrates un plan.\n\n' +
      '{limites}\n\n' +
      '{enlace_pago}\n\n' +
      '¿Necesitas más tiempo para probar? Escríbenos desde Soporte en tu panel.' +
      SIGN,
    variables: [
      { key: '{empresa}', label: 'Nombre del tenant' },
      { key: '{enlace_pago}', label: 'Enlace a la suscripción' },
      { key: '{limites}', label: 'Lo que supera del plan gratuito (si algo)' },
    ],
  },
  past_due: {
    label: 'Pago de la cuota pendiente',
    description: 'Cuando no se puede cobrar la suscripción.',
    subject: 'No hemos podido cobrar tu suscripción a TrasterOS',
    body:
      'Hola, {empresa}:\n\n' +
      'No hemos podido cobrar la cuota de tu suscripción a TrasterOS. Para mantener tu cuenta activa y evitar la suspensión del servicio, por favor regulariza el pago:\n\n' +
      '{enlace_pago}\n\n' +
      'Desde ahí puedes actualizar tu método de pago o completar el pago pendiente.\n\n' +
      'Si crees que se trata de un error o necesitas ayuda, escríbenos desde Soporte en tu panel.' +
      SIGN,
    variables: [
      { key: '{empresa}', label: 'Nombre del tenant' },
      { key: '{enlace_pago}', label: 'Enlace a la suscripción' },
    ],
  },
};

/** Rellena las variables de un correo automático; quita las líneas que quedan vacías. */
export function fillLifecycleTemplate(text: string, vars: Record<string, string>): string {
  const filled = text.replace(/\{([a-z_]+)\}/g, (m, k: string) => vars[k] ?? m);
  return filled.replace(/\n{3,}/g, '\n\n').trim();
}

export const UpdateLifecycleEmailSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(10_000),
});
export type UpdateLifecycleEmailInput = z.infer<typeof UpdateLifecycleEmailSchema>;

export interface LifecycleEmailTemplateDto {
  code: LifecycleEmailCode;
  label: string;
  description: string;
  subject: string;
  body: string;
  /** El super admin lo ha cambiado (si no, es el de serie). */
  custom: boolean;
  variables: { key: string; label: string }[];
  defaultSubject: string;
  defaultBody: string;
  updatedAt: string | null;
}

// ── Encuestas NPS ───────────────────────────────────────────────────────────

export const CreateNpsSurveySchema = z.object({
  name: z.string().trim().min(3).max(120),
  question: z
    .string()
    .trim()
    .min(10)
    .max(300)
    .default('¿Qué probabilidad hay de que recomiendes TrasterOS a otro operador de trasteros?'),
  segment: AnnouncementSegmentSchema,
});
export type CreateNpsSurveyInput = z.infer<typeof CreateNpsSurveySchema>;

export const SubmitNpsResponseSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().trim().max(2000).optional(),
});
export type SubmitNpsResponseInput = z.infer<typeof SubmitNpsResponseSchema>;

export interface NpsSurveyDto {
  id: string;
  name: string;
  question: string;
  segment: AnnouncementSegment;
  status: 'draft' | 'sent' | 'closed';
  sentAt: string | null;
  sent: number;
  responses: number;
  /** % promotores − % detractores (null sin respuestas). */
  nps: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  createdAt: string;
}

export interface NpsResponseDto {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  score: number;
  comment: string | null;
  respondedAt: string;
}

export interface NpsSurveyDetailDto extends NpsSurveyDto {
  answers: NpsResponseDto[];
}

/** Lo que ve quien abre el enlace de la encuesta. */
export interface PublicNpsSurveyDto {
  question: string;
  tenantName: string;
  answered: boolean;
  score: number | null;
  closed: boolean;
}

/** % promotores − % detractores, redondeado. */
export function npsScore(scores: number[]): number | null {
  if (scores.length === 0) return null;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return Math.round(((promoters - detractors) / scores.length) * 100);
}
