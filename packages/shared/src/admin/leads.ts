import { z } from 'zod';

import { ImportFormatEnum } from '../imports/schemas';
import { MessageAttachmentSchema, type MessageAttachmentDto } from '../messages';

import type { PlatformQuoteOfferDto } from './catalog';
import type { PlatformLeadScoreFactor } from './leads-insights';

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
  'churned',
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
  churned: 'Cliente que se dio de baja',
  other: 'Otro',
};

/** Motivos que el equipo elige a mano (los otros los pone el sistema). */
export const PLATFORM_LEAD_MANUAL_LOST_REASONS = PLATFORM_LEAD_LOST_REASONS.filter(
  (r) => r !== 'churned',
) as Exclude<PlatformLeadLostReason, 'churned'>[];
export const PlatformLeadManualLostReasonEnum = PlatformLeadLostReasonEnum.exclude(['churned']);

export const PLATFORM_LEAD_ACTIVITY_TYPES = [
  'note',
  'call',
  'demo',
  'meeting',
  'whatsapp',
  'email_out',
  'email_in',
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
  email_in: 'Correo recibido',
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
  'email_in',
  'email_out',
  'quote',
];

/** Lo que escribe el lead (el resto de la conversación es nuestro). */
export const PLATFORM_LEAD_INBOUND_TYPES: readonly PlatformLeadActivityType[] = [
  'web_form',
  'email_in',
];

/**
 * Lo que cuenta como que ha contestado: un correo suyo o una conversación de
 * verdad (llamada, demo, reunión). Para las secuencias y la puntuación.
 */
export const PLATFORM_LEAD_REPLY_TYPES: readonly PlatformLeadActivityType[] = [
  'email_in',
  'web_form',
  'call',
  'demo',
  'meeting',
];

/** Horas sin atender a partir de las que un lead nuevo avisa. */
export const PLATFORM_LEAD_UNATTENDED_HOURS = 4;

/** Días tras los que se propone volver a contactar a quien acabó la prueba sin contratar. */
export const PLATFORM_LEAD_TRIAL_RECONTACT_DAYS = 14;

/**
 * Días de margen tras el fin de la prueba antes de dar el lead por perdido
 * (puede estar a punto de pagar: una remesa, una tarjeta, una transferencia).
 */
export const PLATFORM_LEAD_TRIAL_LOST_GRACE_DAYS = 7;

/** Tope de leads abiertos que trae el tablero (el resto, con la búsqueda o los filtros). */
export const PLATFORM_LEAD_BOARD_OPEN_LIMIT = 500;

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
  reasonCode: PlatformLeadManualLostReasonEnum,
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

/** Adjuntos de un correo a un lead (imagen o PDF ya subidos). */
export const PLATFORM_LEAD_MAX_ATTACHMENTS = 5;

export const SendPlatformLeadEmailSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  attachments: z.array(MessageAttachmentSchema).max(PLATFORM_LEAD_MAX_ATTACHMENTS).optional(),
});
export type SendPlatformLeadEmailInput = z.infer<typeof SendPlatformLeadEmailSchema>;

export const LinkPlatformLeadTenantSchema = z.object({ tenantId: z.string().uuid() });
export type LinkPlatformLeadTenantInput = z.infer<typeof LinkPlatformLeadTenantSchema>;

// ---------------------------------------------------------------- descartes

export const PLATFORM_LEAD_DISCARD_REASONS = [
  'spam',
  'supplier',
  'support',
  'existing_customer',
  'merged',
  'other',
] as const;
export type PlatformLeadDiscardReason = (typeof PLATFORM_LEAD_DISCARD_REASONS)[number];

export const PLATFORM_LEAD_DISCARD_REASON_LABELS: Record<PlatformLeadDiscardReason, string> = {
  spam: 'Spam',
  supplier: 'Proveedor',
  support: 'Consulta de soporte',
  existing_customer: 'Ya es cliente',
  merged: 'Fusionado con otro lead',
  other: 'Otro',
};

/** Los que se eligen a mano («Fusionado» lo pone el sistema). */
export const PLATFORM_LEAD_MANUAL_DISCARD_REASONS = PLATFORM_LEAD_DISCARD_REASONS.filter(
  (r) => r !== 'merged',
) as Exclude<PlatformLeadDiscardReason, 'merged'>[];

export const DiscardPlatformLeadSchema = z.object({
  reasonCode: z
    .enum(['spam', 'supplier', 'support', 'existing_customer', 'other'])
    .default('other'),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});
export type DiscardPlatformLeadInput = z.infer<typeof DiscardPlatformLeadSchema>;

// ------------------------------------------------------------------ fusión

export const MergePlatformLeadSchema = z.object({ sourceId: z.string().uuid() });
export type MergePlatformLeadInput = z.infer<typeof MergePlatformLeadSchema>;

/** Datos con los que buscar posibles duplicados (al dar de alta). */
export const CheckPlatformLeadDuplicatesSchema = z.object({
  companyName: optionalText(160),
  contactName: optionalText(160),
  email: z.string().trim().toLowerCase().max(200).optional().or(z.literal('')),
  phone: optionalText(40),
  excludeId: z.string().uuid().optional(),
});
export type CheckPlatformLeadDuplicatesInput = z.infer<typeof CheckPlatformLeadDuplicatesSchema>;

export interface PlatformLeadDuplicateDto {
  kind: 'lead' | 'tenant';
  id: string;
  name: string;
  /** Por qué parece el mismo: «mismo email», «empresa parecida»… */
  reason: string;
  /** Mismo email o teléfono: es el mismo seguro. */
  exact: boolean;
  status: PlatformLeadStage | null;
  slug: string | null;
}

// ---------------------------------------------------------------- secuencias

export const PlatformLeadSequenceStepSchema = z
  .object({
    /** Días desde que empieza (el primer correo o la propuesta). */
    day: z.number().int().min(0).max(180),
    /** Plantilla de correo (las de «Materiales y plantillas»). */
    templateId: z.string().uuid().nullable().optional(),
    subject: z.string().trim().max(200).optional().or(z.literal('')),
    body: z.string().trim().max(10_000).optional().or(z.literal('')),
  })
  .refine((s) => !!s.templateId || (!!s.subject && !!s.body), {
    message: 'Elige una plantilla o escribe el asunto y el texto',
    path: ['templateId'],
  });
export type PlatformLeadSequenceStep = z.infer<typeof PlatformLeadSequenceStepSchema>;

export const UpsertPlatformLeadSequenceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  steps: z.array(PlatformLeadSequenceStepSchema).min(1).max(10),
  isActive: z.boolean().default(true),
  /** La que empieza sola con el primer correo o la propuesta. */
  isDefault: z.boolean().default(false),
});
export type UpsertPlatformLeadSequenceInput = z.infer<typeof UpsertPlatformLeadSequenceSchema>;

export interface PlatformLeadSequenceDto {
  id: string;
  name: string;
  description: string | null;
  steps: PlatformLeadSequenceStep[];
  isActive: boolean;
  isDefault: boolean;
  /** Leads que la tienen en marcha ahora. */
  activeCount: number;
}

/** Activar o parar la secuencia de un lead desde su ficha. */
export const SetPlatformLeadSequenceSchema = z.object({
  enabled: z.boolean(),
  /** Otra secuencia que la de por defecto. */
  sequenceId: z.string().uuid().optional(),
});
export type SetPlatformLeadSequenceInput = z.infer<typeof SetPlatformLeadSequenceSchema>;

export const PLATFORM_LEAD_SEQUENCE_STOP_LABELS: Record<string, string> = {
  replied: 'Ha contestado',
  stage: 'Ya no está abierto (cuenta, cliente o perdido)',
  discarded: 'Descartado',
  manual: 'Parada a mano',
  no_email: 'Sin email',
  finished: 'Se enviaron todos los pasos',
  merged: 'Fusionado con otro lead',
};

export interface PlatformLeadSequenceStateDto {
  enrollmentId: string;
  sequenceId: string;
  sequenceName: string;
  status: 'active' | 'done' | 'stopped';
  /** Pasos ya enviados. */
  sent: number;
  totalSteps: number;
  nextRunAt: string | null;
  startedAt: string;
  stopReason: string | null;
}

// --------------------------------------------------------- ajustes y reparto

export const PLATFORM_LEAD_ASSIGN_MODES = ['off', 'round_robin', 'zone'] as const;
export type PlatformLeadAssignMode = (typeof PLATFORM_LEAD_ASSIGN_MODES)[number];

export const PLATFORM_LEAD_ASSIGN_MODE_LABELS: Record<PlatformLeadAssignMode, string> = {
  off: 'No repartir: los asigna alguien',
  round_robin: 'Por turnos',
  zone: 'Por zona (ciudad o provincia)',
};

export const PlatformLeadZoneRuleSchema = z.object({
  /** Ciudad o provincia (se busca en la ciudad que dejó). */
  match: z.string().trim().min(2).max(80),
  superAdminId: z.string().uuid(),
});
export type PlatformLeadZoneRule = z.infer<typeof PlatformLeadZoneRuleSchema>;

const staleDay = z.number().int().min(1).max(90);

export const UpdatePlatformLeadSettingsSchema = z
  .object({
    assignMode: z.enum(PLATFORM_LEAD_ASSIGN_MODES),
    roundRobinIds: z.array(z.string().uuid()).max(50),
    zoneRules: z.array(PlatformLeadZoneRuleSchema).max(100),
    zoneFallbackRoundRobin: z.boolean(),
    responseHours: z.number().int().min(1).max(72),
    businessHours: z.boolean(),
    reassignEnabled: z.boolean(),
    staleDays: z.object({
      new: staleDay,
      contacted: staleDay,
      interested: staleDay,
      trial: staleDay,
    }),
    highValueMonthly: z.number().min(0).max(100_000),
    sequenceAutoStart: z.boolean(),
  })
  .partial();
export type UpdatePlatformLeadSettingsInput = z.infer<typeof UpdatePlatformLeadSettingsSchema>;

export interface PlatformLeadSettingsDto {
  assignMode: PlatformLeadAssignMode;
  roundRobinIds: string[];
  zoneRules: PlatformLeadZoneRule[];
  zoneFallbackRoundRobin: boolean;
  responseHours: number;
  businessHours: boolean;
  reassignEnabled: boolean;
  staleDays: { new: number; contacted: number; interested: number; trial: number };
  highValueMonthly: number;
  sequenceAutoStart: boolean;
}

// ------------------------------------------------------------------- lista

export const PLATFORM_LEAD_LIST_SORTS = [
  'score',
  'value',
  'name',
  'company',
  'status',
  'source',
  'city',
  'assignee',
  'lastActivity',
  'nextFollowup',
  'createdAt',
] as const;
export type PlatformLeadListSort = (typeof PLATFORM_LEAD_LIST_SORTS)[number];

export const PlatformLeadListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  source: PlatformLeadSourceEnum.optional(),
  assignedTo: z.string().trim().max(60).optional(),
  status: z.array(PlatformLeadStageEnum).max(6).optional(),
  /** Tamaño (trasteros declarados). */
  sizeMin: z.number().int().min(0).max(1_000_000).optional(),
  sizeMax: z.number().int().min(0).max(1_000_000).optional(),
  city: z.string().trim().max(120).optional(),
  campaign: z.string().trim().max(120).optional(),
  /** Sin actividad en al menos estos días. */
  inactiveDays: z.number().int().min(1).max(365).optional(),
  /** Solo los parados. */
  stale: z.boolean().optional(),
  discarded: z.boolean().optional(),
  sort: z.enum(PLATFORM_LEAD_LIST_SORTS).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type PlatformLeadListQuery = z.infer<typeof PlatformLeadListQuerySchema>;

export interface PlatformLeadListDto {
  items: PlatformLeadDto[];
  nextCursor: string | null;
  total: number;
  /** Cuota prevista sumada de todos los que casan con el filtro. */
  totalValue: number;
}

// ------------------------------------------------------------------- lote

const bulkIds = z.array(z.string().uuid()).min(1).max(200);

export const PlatformLeadBulkSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign'),
    ids: bulkIds,
    assignedToId: z.string().uuid().nullable(),
  }),
  z.object({ action: z.literal('move'), ids: bulkIds, status: PlatformLeadManualStageEnum }),
  z.object({
    action: z.literal('lose'),
    ids: bulkIds,
    reasonCode: PlatformLeadManualLostReasonEnum,
    reason: z.string().trim().max(1000).optional().or(z.literal('')),
  }),
  z.object({
    action: z.literal('discard'),
    ids: bulkIds,
    reasonCode: z.enum(['spam', 'supplier', 'support', 'existing_customer', 'other']),
    reason: z.string().trim().max(500).optional().or(z.literal('')),
  }),
  z.object({
    action: z.literal('followup'),
    ids: bulkIds,
    title: z.string().trim().min(2).max(200),
    dueDate: dateString,
    note: z.string().trim().max(2000).optional().or(z.literal('')),
  }),
]);
export type PlatformLeadBulkInput = z.infer<typeof PlatformLeadBulkSchema>;

export interface PlatformLeadBulkResultDto {
  done: number;
  failed: { id: string; name: string; message: string }[];
}

// ----------------------------------------------------------------- importar

export const PlatformLeadImportSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  format: ImportFormatEnum.default('csv'),
  /** Un lead que ya existe (mismo email o teléfono): se omite o se le suman los datos. */
  onDuplicate: z.enum(['skip', 'merge']).default('skip'),
  /** Origen de los que no traen columna «origen». */
  source: PlatformLeadSourceEnum.default('other'),
  assignedToId: z.string().uuid().nullable().optional(),
});
export type PlatformLeadImportInput = z.infer<typeof PlatformLeadImportSchema>;

// ------------------------------------------------------------ captura rápida

export const PLATFORM_LEAD_CAPTURE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const PlatformLeadCapturePhotoSchema = z.object({
  mimeType: z.enum(PLATFORM_LEAD_CAPTURE_PHOTO_TYPES),
});

export const PlatformLeadCaptureSchema = z
  .object({
    contactName: optionalText(160),
    companyName: optionalText(160),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('Email no válido')
      .max(200)
      .optional()
      .or(z.literal('')),
    phone: optionalText(40),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
    source: PlatformLeadSourceEnum.default('event'),
    /** Foto de su tarjeta (ya subida). */
    photoKey: z.string().max(300).optional(),
  })
  .refine((v) => !!(v.companyName || v.contactName), {
    message: 'Indica la empresa o la persona',
    path: ['contactName'],
  })
  .refine((v) => !!(v.email || v.phone), {
    message: 'Indica un email o un teléfono',
    path: ['phone'],
  });
export type PlatformLeadCaptureInput = z.infer<typeof PlatformLeadCaptureSchema>;

export const PlatformLeadsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  source: PlatformLeadSourceEnum.optional(),
  /** `me` = los míos; un id = los de ese super admin; `none` = sin responsable. */
  assignedTo: z.string().trim().max(60).optional(),
  /** Los marcados «No es un lead» (en vez de los del tablero). */
  discarded: z.boolean().optional(),
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
  /**
   * Desde cuándo espera respuesta (volvió a escribir tras perderse, o aún nadie
   * le ha respondido); null si no espera nada.
   */
  awaitingReplySince: string | null;
  /** «No es un lead»: la ficha se abre en solo lectura. */
  discardedAt: string | null;
  /** Comercial que lleva la cuenta (cartera y comisiones). */
  salesRepName: string | null;
  /**
   * Comercial de su cuenta de cliente si no es quien lo lleva en el tablero:
   * la cuenta (y sus comisiones) sigue siendo suya.
   */
  accountKeptBy: { id: string; name: string } | null;
  lastActivityAt: string | null;
  nextFollowup: { id: string; title: string; dueDate: string } | null;
  /** Puntuación (0-100) de lo probable que es que pague, con sus motivos. */
  score: number;
  scoreFactors: PlatformLeadScoreFactor[];
  /** Cuota prevista al mes sin IVA (null: sin trasteros ni plan). */
  estimatedMonthly: number | null;
  estimatedPlanName: string | null;
  /** De alto valor (cuota prevista a partir del umbral de los ajustes). */
  highValue: boolean;
  /** Días sin actividad si está parado (pasado el umbral de su fase). */
  staleDays: number | null;
  /** Hasta cuándo tiene su responsable para responder (reparto automático). */
  responseDueAt: string | null;
  /** Veces que ha abierto sus propuestas. */
  proposalOpens: number;
  discardReasonCode: PlatformLeadDiscardReason | null;
  discardReason: string | null;
  mergedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformLeadBoardDto {
  items: PlatformLeadDto[];
  /** Total por fase (Cliente y Perdido solo traen los últimos). */
  counts: Record<PlatformLeadStage, number>;
  /** Cuota prevista sumada por fase («€ en juego»), sin IVA. */
  valueByStage: Record<PlatformLeadStage, number>;
  /** Hay más leads abiertos de los que trae el tablero. */
  truncated: boolean;
  /** Cuántos leads abiertos no se ven (0 si cabe todo). */
  hiddenOpen: number;
}

export interface PlatformLeadActivityDto {
  id: string;
  type: PlatformLeadActivityType;
  subject: string | null;
  content: string;
  occurredAt: string;
  superAdminName: string | null;
  attachments: MessageAttachmentDto[];
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
  /** Secuencia de correos (la última que tuvo). */
  sequence: PlatformLeadSequenceStateDto | null;
  /** Sin correos automáticos de secuencia. */
  sequenceOptOut: boolean;
  /** Posibles duplicados (otros leads o cuentas que ya existen). */
  duplicates: PlatformLeadDuplicateDto[];
  /** Sus respuestas vuelven a esta ficha (hay dominio de correo entrante). */
  repliesToThread: boolean;
}

export interface PlatformLeadStatsSourceDto {
  source: PlatformLeadSource;
  leads: number;
  trials: number;
  customers: number;
  /** Lo que pagan al mes los que son clientes (plan + extras, sin IVA). */
  mrr: number;
  /** % de leads que acabaron pagando. */
  conversionPct: number | null;
}

export interface PlatformLeadStatsDto {
  months: number;
  from: string;
  leads: number;
  /**
   * Leads que se trabajan (sin los que entraron directamente en prueba): cuántos
   * pasaron de verdad por cada fase (con su fecha). El de «Nuevo» son todos.
   */
  funnel: { stage: Exclude<PlatformLeadStage, 'lost'>; reached: number }[];
  /** Se registraron por su cuenta (o se les creó la cuenta) sin pasar por el equipo. */
  direct: { leads: number; customers: number };
  /** Perdidos antes de ser clientes. */
  lost: number;
  /** Clientes que se dieron de baja. */
  churned: number;
  bySource: PlatformLeadStatsSourceDto[];
  lostReasons: { code: PlatformLeadLostReason; count: number }[];
  /**
   * Mediana de horas hasta la primera respuesta de los que escribieron solos
   * (formulario, demo, calculadora…); null sin datos.
   */
  medianFirstResponseHours: number | null;
  /** Media de días del alta del lead al primer pago. */
  avgDaysToCustomer: number | null;
  mrr: number;
  /** Filtro por origen aplicado (null: todos). */
  source: PlatformLeadSource | null;
  /** Días de media en cada fase hasta pasar a la siguiente. */
  stageDays: {
    stage: 'new' | 'contacted' | 'interested' | 'trial';
    avgDays: number | null;
    count: number;
  }[];
  /** Por quien lo lleva. */
  byAssignee: PlatformLeadStatsGroupDto[];
  /** Por campaña (`utm_campaign`). */
  byCampaign: PlatformLeadStatsGroupDto[];
  /** Descartados en el periodo, por motivo. */
  discardReasons: { code: PlatformLeadDiscardReason; count: number }[];
  /** Lo mismo del periodo anterior, de la misma duración. */
  previous: {
    from: string;
    leads: number;
    customers: number;
    conversionPct: number | null;
    mrr: number;
    medianFirstResponseHours: number | null;
  };
  /** «€ en juego» hoy: cuota prevista (sin IVA) de los abiertos, por fase. */
  valueByStage: { stage: PlatformLeadStage; leads: number; value: number }[];
}

export interface PlatformLeadStatsGroupDto {
  /** Id del responsable o nombre de la campaña (null: sin él). */
  key: string | null;
  label: string;
  leads: number;
  customers: number;
  conversionPct: number | null;
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

/** Rellena `{empresa}`, `{nombre}` y `{trasteros}` de una respuesta guardada para un lead. */
export function fillPlatformLeadTemplate(
  text: string,
  lead: { companyName?: string | null; contactName?: string | null; units?: string | null },
): string {
  const company = lead.companyName?.trim() || lead.contactName?.trim() || '';
  const name = lead.contactName?.trim().split(/\s+/)[0] || company;
  return text
    .replace(/\{empresa\}/g, company)
    .replace(/\{nombre\}/g, name)
    .replace(/\{trasteros\}/g, lead.units?.trim() ?? '');
}

/** Variables de las plantillas de correo a un lead (las de los comerciales). */
const LEAD_TEMPLATE_KEYS = new Set([
  'nombre',
  'empresa',
  'trasteros',
  'ciudad',
  'comercial',
  'telefono_comercial',
  'email_comercial',
  'agenda',
  'enlace_registro',
  'codigo',
]);

/**
 * Plantilla (o paso de una secuencia) para un lead: `{nombre}`, `{empresa}`,
 * `{trasteros}`, `{ciudad}` y los datos de quien escribe. Una variable sin
 * valor desaparece; una desconocida se queda tal cual.
 */
export function renderPlatformLeadTemplate(
  text: string,
  lead: {
    companyName?: string | null;
    contactName?: string | null;
    units?: string | null;
    city?: string | null;
  },
  sender: Record<string, string | null | undefined> = {},
): string {
  const company = lead.companyName?.trim() || lead.contactName?.trim() || '';
  const vars: Record<string, string> = {
    nombre: lead.contactName?.trim().split(/\s+/)[0] || company,
    empresa: company,
    trasteros: lead.units?.trim() ?? '',
    ciudad: lead.city?.trim() ?? '',
  };
  return text.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    if (!LEAD_TEMPLATE_KEYS.has(key)) return match;
    return (vars[key] ?? sender[key] ?? '').trim();
  });
}
