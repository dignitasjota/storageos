/**
 * Seguimientos, Trials, En riesgo y Oportunidades del panel super admin:
 * esquemas, tipos y cálculos sin base de datos que usan el API y la web.
 */

import { z } from 'zod';

import type {
  AdminAddonOpportunityDto,
  AdminAtRiskDto,
  AdminAtRiskTenantDto,
  AdminOpportunityCandidateDto,
  AdminTrialDto,
} from './types';

const DAY = 86_400_000;

/** Un día real en formato YYYY-MM-DD (2026-13-45 no lo es). */
const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Esa fecha no existe');

/** Suma días a una fecha YYYY-MM-DD (sin husos: es un día de calendario). */
export function addDaysToDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// =================================================================== seguimientos

export const AdminFollowupKindEnum = z.enum(['tenant', 'lead']);
export type AdminFollowupKind = z.infer<typeof AdminFollowupKindEnum>;

export const AdminFollowupTabEnum = z.enum(['today', 'overdue', 'upcoming', 'done']);
export type AdminFollowupTab = z.infer<typeof AdminFollowupTabEnum>;

/** Los hechos de la bandeja: los cerrados en estos últimos días. */
export const FOLLOWUP_DONE_WINDOW_DAYS = 30;

/** Pestaña de la bandeja en la que cae un seguimiento (`today` = YYYY-MM-DD de Madrid). */
export function followupTab(
  f: { status: string; dueDate: string },
  today: string,
): AdminFollowupTab {
  if (f.status === 'done') return 'done';
  if (f.dueDate < today) return 'overdue';
  if (f.dueDate === today) return 'today';
  return 'upcoming';
}

/**
 * Fecha propuesta para el siguiente seguimiento al cerrar uno: una semana
 * después de hoy (dos si el que se cierra ya era de hace más de una semana).
 */
export function suggestNextFollowupDay(today: string, closedDueDate?: string): string {
  const late = closedDueDate ? closedDueDate < addDaysToDay(today, -7) : false;
  return addDaysToDay(today, late ? 14 : 7);
}

/** Un seguimiento de la bandeja unificada (de un tenant o de un lead). */
export interface AdminFollowupItemDto {
  kind: AdminFollowupKind;
  id: string;
  /** Id del tenant o del lead. */
  subjectId: string;
  subjectName: string;
  /** Estado del tenant (activo, prueba, suspendido…) o fase del lead. */
  subjectStatus: string | null;
  title: string;
  note: string | null;
  dueDate: string;
  status: 'pending' | 'done';
  completedAt: string | null;
  completedByName: string | null;
  outcome: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  authorName: string | null;
  createdAt: string;
}

export interface AdminFollowupInboxDto {
  items: AdminFollowupItemDto[];
  /** Cuántos hay en cada pestaña (con los mismos filtros). */
  counts: Record<AdminFollowupTab, number>;
  /** Se muestran los primeros; hay más que no caben. */
  truncated: boolean;
}

export const CreateAdminFollowupSchema = z.object({
  kind: AdminFollowupKindEnum,
  /** Id del tenant o del lead. */
  subjectId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional(),
  dueDate: dayString,
  /** Quién se encarga (null = nadie en concreto; sin enviar = quien lo crea). */
  assignedToId: z.string().uuid().nullable().optional(),
});
export type CreateAdminFollowupInput = z.infer<typeof CreateAdminFollowupSchema>;

export const UpdateAdminFollowupSchema = z
  .object({
    status: z.enum(['pending', 'done']).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    dueDate: dayString.optional(),
    assignedToId: z.string().uuid().nullable().optional(),
    /** «Qué pasó» (solo al marcarlo hecho). */
    outcome: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nada que cambiar' });
export type UpdateAdminFollowupInput = z.infer<typeof UpdateAdminFollowupSchema>;

export const BulkAdminFollowupsSchema = z
  .object({
    items: z
      .array(z.object({ kind: AdminFollowupKindEnum, id: z.string().uuid() }))
      .min(1)
      .max(200),
    action: z.enum(['postpone', 'assign', 'done']),
    /** Posponer: días desde hoy. */
    days: z.number().int().min(1).max(365).optional(),
    /** Reasignar (null = sin asignar). */
    assignedToId: z.string().uuid().nullable().optional(),
    outcome: z.string().trim().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'postpone' && !v.days) {
      ctx.addIssue({ code: 'custom', path: ['days'], message: 'Indica cuántos días' });
    }
    if (v.action === 'assign' && v.assignedToId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['assignedToId'], message: 'Indica quién' });
    }
  });
export type BulkAdminFollowupsInput = z.infer<typeof BulkAdminFollowupsSchema>;

export interface BulkAdminFollowupsResultDto {
  updated: number;
  /** No existían o ya estaban hechos. */
  skipped: number;
}

/** Atrasados o de hoy asignados a mí o sin asignar (aviso del menú). */
export interface AdminFollowupsOverdueCountDto {
  count: number;
}

// ======================================================================= trials

export const AdminTrialFilterEnum = z.enum(['all', 'this_week', 'expired', 'unused', 'real_use']);
export type AdminTrialFilter = z.infer<typeof AdminTrialFilterEnum>;

export const ADMIN_TRIALS_PAGE_SIZE = 25;

/** Pasos de la puesta en marcha que mira la columna «Progreso». */
export const TRIAL_PROGRESS_STEPS = [
  { key: 'facility', label: 'Local' },
  { key: 'units', label: 'Trasteros' },
  { key: 'customers', label: 'Inquilinos' },
  { key: 'contract', label: 'Primer contrato' },
  { key: 'company', label: 'Datos fiscales' },
  { key: 'payment', label: 'Forma de cobro' },
] as const;
export type TrialProgressStep = (typeof TRIAL_PROGRESS_STEPS)[number]['key'];

export interface AdminTrialProgressDto {
  done: number;
  total: number;
  /** Lo que le falta, en el orden de la puesta en marcha. */
  missing: string[];
}

export function trialProgress(has: Record<TrialProgressStep, boolean>): AdminTrialProgressDto {
  const missing = TRIAL_PROGRESS_STEPS.filter((s) => !has[s.key]).map((s) => s.label);
  return {
    done: TRIAL_PROGRESS_STEPS.length - missing.length,
    total: TRIAL_PROGRESS_STEPS.length,
    missing,
  };
}

export type AdminTrialConversionLevel = 'high' | 'medium' | 'low';

export interface AdminTrialConversionDto {
  level: AdminTrialConversionLevel;
  /** Por qué, en una frase. */
  reason: string;
}

/**
 * Probabilidad de que pague, sencilla y explicada: lo que más pesa es el uso
 * real (contratos y facturas), después lo avanzada que está la puesta en
 * marcha y si el equipo entra.
 */
export function trialConversion(input: {
  progressDone: number;
  progressTotal: number;
  activeContracts: number;
  invoices: number;
  lastActivityAt: Date | null;
  now: Date;
}): AdminTrialConversionDto {
  const days = input.lastActivityAt
    ? Math.floor((input.now.getTime() - input.lastActivityAt.getTime()) / DAY)
    : null;
  if (days === null) return { level: 'low', reason: 'Nadie de su equipo ha entrado nunca' };
  if (input.activeContracts > 0 || input.invoices > 0) {
    return days <= 7
      ? { level: 'high', reason: 'Ya lo usa de verdad: tiene contratos o facturas' }
      : {
          level: 'medium',
          reason: `Tiene contratos o facturas, pero no entra desde hace ${days} días`,
        };
  }
  if (days > 14) return { level: 'low', reason: `No entra desde hace ${days} días` };
  if (input.progressDone >= input.progressTotal - 2) {
    return { level: 'medium', reason: 'Casi lo tiene montado, aún sin contratos' };
  }
  return input.progressDone <= 1
    ? { level: 'low', reason: 'Entra, pero apenas ha empezado a montarlo' }
    : { level: 'medium', reason: 'A medio montar' };
}

export interface AdminTrialRowDto extends AdminTrialDto {
  progress: AdminTrialProgressDto;
  conversion: AdminTrialConversionDto;
  invoices: number;
  salesRepId: string | null;
  salesRepName: string | null;
  /** Lead del que viene (si lo hay). */
  leadId: string | null;
  leadName: string | null;
}

export interface AdminTrialsSummaryDto {
  /** Pruebas en curso (también las vencidas que aún no se han cerrado). */
  inProgress: number;
  /** Pruebas que terminan este mes y pagan / todas las que terminan este mes. */
  convertedThisMonth: number;
  endedThisMonth: number;
  conversionMonthPct: number | null;
  /** Días medios desde el alta hasta el primer pago (últimos 3 meses). */
  avgDaysToPay: number | null;
  /** Pruebas ampliadas este mes. */
  extendedThisMonth: number;
}

export interface AdminTrialsPageDto {
  items: AdminTrialRowDto[];
  total: number;
  page: number;
  pageSize: number;
  /** Cuántos caen en cada filtro (con la búsqueda aplicada). */
  counts: Record<AdminTrialFilter, number>;
  summary: AdminTrialsSummaryDto;
}

/** Una prueba que terminó sin pagar: queda activa en solo lectura. */
export interface AdminExpiredTrialDto {
  id: string;
  name: string;
  slug: string;
  planName: string | null;
  planSlug: string | null;
  /** Cuándo terminó (fin de la prueba o cierre). */
  endedAt: string | null;
  daysSince: number | null;
  lastActivityAt: string | null;
  facilities: number;
  units: number;
  activeContracts: number;
  salesRepName: string | null;
  leadId: string | null;
}

/** Plantillas para escribir a varias pruebas a la vez. */
export const TRIAL_MESSAGE_TEMPLATES = [
  {
    key: 'help',
    label: '¿Te ayudamos a empezar?',
    subject: '¿Te ayudamos a poner en marcha {empresa}?',
    body: [
      'Hola {nombre},',
      '',
      'Hemos visto que aún estás montando {empresa} en TrasterOS. Si quieres, te ayudamos: en una llamada de 20 minutos dejamos los locales, los trasteros y los cobros listos.',
      '',
      'Respóndenos desde Soporte en tu panel y te llamamos cuando te venga bien.',
    ].join('\n'),
  },
  {
    key: 'ending',
    label: 'Tu prueba acaba pronto',
    subject: 'Tu prueba de TrasterOS acaba pronto',
    body: [
      'Hola {nombre},',
      '',
      'La prueba gratis de {empresa} termina en pocos días. Para seguir sin cortes, elige tu plan en Configuración → Suscripción.',
      '',
      'Si necesitas más tiempo o tienes dudas, escríbenos desde Soporte.',
    ].join('\n'),
  },
  { key: 'free', label: 'Mensaje libre', subject: '', body: '' },
] as const;

// ===================================================================== en riesgo

export const RetentionPlaybookReasonEnum = z.enum([
  'past_due',
  'trial_expiring',
  'trial_expired',
  'inactive',
  'low_health',
  'scheduled_end',
  'cancel_at_period_end',
]);
export type RetentionPlaybookReason = z.infer<typeof RetentionPlaybookReasonEnum>;

/**
 * Correo del playbook de retención según el motivo. `message` (opcional, del
 * admin) va al principio, tras el saludo.
 */
export function retentionPlaybookEmail(
  reason: RetentionPlaybookReason | null | undefined,
  args: { webBaseUrl: string; message?: string | null },
): { subject: string; body: string } {
  const support = `${args.webBaseUrl}/support`;
  const billing = `${args.webBaseUrl}/settings/saas-billing`;
  const intro = args.message?.trim() ? [args.message.trim(), ''] : [];
  const close = ['', 'Un saludo,', 'El equipo de TrasterOS'];
  const make = (subject: string, lines: string[]) => ({
    subject,
    body: ['Hola,', '', ...intro, ...lines, ...close].join('\n'),
  });
  switch (reason) {
    case 'past_due':
      return make('No hemos podido cobrar tu cuota de TrasterOS', [
        'No hemos podido cobrar la última cuota de tu suscripción. Suele ser una tarjeta caducada o una domiciliación devuelta.',
        `Puedes revisarlo y pagar en Configuración → Suscripción: ${billing}`,
        '',
        `Si hay algún problema o necesitas un plazo, escríbenos desde Soporte: ${support}`,
      ]);
    case 'trial_expiring':
      return make('Tu prueba de TrasterOS acaba pronto', [
        'Tu prueba gratis termina en unos días. Para seguir sin cortes, elige tu plan en Configuración → Suscripción:',
        billing,
        '',
        `Si te falta tiempo para probarlo o quieres que te ayudemos a montarlo, escríbenos desde Soporte: ${support}`,
      ]);
    case 'trial_expired':
      return make('Tu prueba de TrasterOS ha terminado', [
        'Tu prueba gratis ha terminado y tu cuenta ha quedado en solo lectura: tus datos siguen ahí.',
        `Para volver a usarla, elige tu plan en Configuración → Suscripción: ${billing}`,
        '',
        `Si quieres más días de prueba o hablar con nosotros, escríbenos desde Soporte: ${support}`,
      ]);
    case 'scheduled_end':
    case 'cancel_at_period_end':
      return make('Antes de que te vayas de TrasterOS', [
        'Hemos visto que tu suscripción terminará pronto. Nos gustaría saber qué podemos mejorar y, si te sirve, buscar una solución: cambiar de plan, ayudarte con lo que no te encaja o ajustar el precio.',
        '',
        `Escríbenos desde Soporte: ${support}`,
      ]);
    case 'inactive':
      return make('¿Te ayudamos con TrasterOS?', [
        'Hace tiempo que nadie de tu equipo entra en TrasterOS. Si algo no te encaja o no sabes por dónde seguir, te ayudamos en una llamada corta.',
        '',
        `Escríbenos desde Soporte: ${support}`,
      ]);
    default:
      return make('¿Podemos ayudarte con TrasterOS?', [
        'Somos el equipo de TrasterOS. Queremos asegurarnos de que le estás sacando el máximo partido a la plataforma.',
        'Si hay algo que podamos mejorar, una duda que resolver o quieres que valoremos un descuento para que te siga saliendo a cuenta, estamos a tu disposición.',
        '',
        `Escríbenos desde Soporte en tu panel: ${support}`,
      ]);
  }
}

export const RetentionPlaybookPreviewSchema = z.object({
  reason: RetentionPlaybookReasonEnum.optional(),
  message: z.string().trim().max(2000).optional(),
});
export type RetentionPlaybookPreviewInput = z.infer<typeof RetentionPlaybookPreviewSchema>;

export interface RetentionPlaybookPreviewDto {
  subject: string;
  body: string;
  /** A quién iría (propietarios con la cuenta activada o el email de facturación). */
  recipients: string[];
}

/** Una fila de En riesgo con el dinero, quién lo lleva y el último contacto. */
export interface AdminAtRiskRowDto extends AdminAtRiskTenantDto {
  /** Cuota al mes sin IVA (en pruebas, la del plan). */
  monthly: number;
  ownerId: string | null;
  ownerName: string | null;
  /** De dónde sale: el seguimiento abierto o su comercial. */
  ownerSource: 'followup' | 'sales' | null;
  lastContactAt: string | null;
  lastContactType: string | null;
}

/** En riesgo con sus extras: dinero, responsable y bajas programadas. */
export type AdminAtRiskOverviewDto = {
  [K in keyof AdminAtRiskDto]: AdminAtRiskDto[K] extends AdminAtRiskTenantDto[]
    ? AdminAtRiskRowDto[]
    : AdminAtRiskDto[K];
} & {
  /** Baja o anonimización programadas. */
  scheduledEnd: AdminAtRiskRowDto[];
  /** Cancelarán al final del periodo que ya han pagado. */
  cancelAtPeriodEnd: AdminAtRiskRowDto[];
  /** Cuota al mes en juego (cada tenant una vez). */
  monthlyAtStake: number;
};

// ================================================================= oportunidades

export const OPPORTUNITY_NO_RESPONSE_DAYS = 14;

export const OpportunityOfferStatusEnum = z.enum(['sent', 'trialing', 'won', 'no_response']);
export type OpportunityOfferStatus = z.infer<typeof OpportunityOfferStatusEnum>;

export const OPPORTUNITY_OFFER_STATUS_LABELS: Record<OpportunityOfferStatus, string> = {
  sent: 'Enviada',
  trialing: 'Probándolo',
  won: 'Contratado',
  no_response: 'Sin respuesta',
};

/**
 * Estado de la última propuesta: contratada, probándolo, sin respuesta tras
 * `OPPORTUNITY_NO_RESPONSE_DAYS` días o enviada.
 */
export function opportunityOfferStatus(args: {
  sentAt: Date;
  hasAddon: boolean;
  trialing: boolean;
  now: Date;
}): OpportunityOfferStatus {
  if (args.hasAddon) return 'won';
  if (args.trialing) return 'trialing';
  return args.now.getTime() - args.sentAt.getTime() > OPPORTUNITY_NO_RESPONSE_DAYS * DAY
    ? 'no_response'
    : 'sent';
}

export interface AdminOpportunityOfferStateDto {
  status: OpportunityOfferStatus;
  sentAt: string;
  trialUntil: string | null;
}

export interface AdminOpportunityRowDto extends AdminOpportunityCandidateDto {
  offer: AdminOpportunityOfferStateDto | null;
  salesRepId: string | null;
  salesRepName: string | null;
}

export interface AdminOpportunityAcceptanceDto {
  /** Propuestas de los últimos 90 días. */
  sent: number;
  won: number;
  trialing: number;
  ratePct: number | null;
}

export interface AdminAddonOpportunityRowDto extends Omit<AdminAddonOpportunityDto, 'candidates'> {
  candidates: AdminOpportunityRowDto[];
  /** Precio × candidatos. */
  potentialMonthly: number;
  acceptance: AdminOpportunityAcceptanceDto;
}

export interface AdminTenantOpportunityDto {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  planName: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
  addons: {
    addonId: string;
    addonName: string;
    feature: string | null;
    priceMonthly: number;
    reasons: string[];
    interestCount: number;
    offer: AdminOpportunityOfferStateDto | null;
  }[];
  potentialMonthly: number;
}

export interface AdminOpportunityDismissalDto {
  id: string;
  tenantId: string;
  tenantName: string;
  addonId: string;
  addonName: string;
  until: string | null;
  reason: string;
  createdByName: string | null;
  createdAt: string;
}

export interface AdminOpportunitiesOverviewDto {
  addons: AdminAddonOpportunityRowDto[];
  byTenant: AdminTenantOpportunityDto[];
  dismissals: AdminOpportunityDismissalDto[];
  totals: { candidates: number; tenants: number; potentialMonthly: number };
  /** Los precios del catálogo llevan IVA (si no, «+ IVA»). */
  pricesIncludeVat: boolean;
}

export const DismissAddonOpportunitySchema = z.object({
  tenantId: z.string().uuid(),
  addonId: z.string().uuid(),
  /** 30, 90 o 180 días; null = siempre. */
  days: z.union([z.literal(30), z.literal(90), z.literal(180)]).nullable(),
  reason: z.string().trim().min(3).max(500),
});
export type DismissAddonOpportunityInput = z.infer<typeof DismissAddonOpportunitySchema>;

export const BulkProposeAddonSchema = z.object({
  addonId: z.string().uuid(),
  tenantIds: z.array(z.string().uuid()).min(1).max(100),
  message: z.string().trim().max(2000).optional(),
  trialDays: z.number().int().min(1).max(60).optional(),
  followupDays: z.number().int().min(0).max(60).default(7),
});
export type BulkProposeAddonInput = z.infer<typeof BulkProposeAddonSchema>;

export interface BulkProposeSkipDto {
  tenantId: string;
  tenantName: string;
  reason: string;
}

export interface BulkProposePreviewDto {
  willSend: { tenantId: string; tenantName: string; recipients: number }[];
  skipped: BulkProposeSkipDto[];
  /** Correos que saldrían. */
  emails: number;
}

export interface BulkProposeResultDto {
  sent: number;
  emails: number;
  skipped: BulkProposeSkipDto[];
}

export const HandOffOpportunitySchema = z.object({
  tenantId: z.string().uuid(),
  addonId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});
export type HandOffOpportunityInput = z.infer<typeof HandOffOpportunitySchema>;

export interface HandOffOpportunityResultDto {
  salesRepName: string;
  /** Seguimiento creado en su prospecto (null si el tenant no viene de uno). */
  followupId: string | null;
}
