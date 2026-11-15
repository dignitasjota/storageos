import { z } from 'zod';

import { calendarDate } from '../common/calendar-date';
import { InteractionTypeEnum } from '../customers/schemas';

// ============================================================================
// Seguimientos y actividad de un contacto
// ============================================================================

export const CreateLeadFollowupSchema = z.object({
  title: z.string().trim().min(2).max(200),
  note: z.string().trim().max(2000).optional(),
  /** YYYY-MM-DD */
  dueDate: calendarDate,
  /** Responsable (si no, quien lo crea). */
  assignedToUserId: z.string().uuid().optional(),
});
export type CreateLeadFollowupInput = z.infer<typeof CreateLeadFollowupSchema>;

/**
 * Cambiar un seguimiento: marcarlo hecho (con lo que pasó), reabrirlo,
 * posponerlo (otra fecha), editarlo o cambiar el responsable.
 */
export const UpdateFollowupSchema = z
  .object({
    status: z.enum(['pending', 'done']).optional(),
    outcome: z.string().trim().max(2000).optional(),
    dueDate: calendarDate.optional(),
    title: z.string().trim().min(2).max(200).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    assignedToUserId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateFollowupInput = z.infer<typeof UpdateFollowupSchema>;
export const UpdateLeadFollowupSchema = UpdateFollowupSchema;
export type UpdateLeadFollowupInput = UpdateFollowupInput;

export interface LeadFollowupDto {
  id: string;
  leadId: string;
  leadName: string;
  title: string;
  note: string | null;
  dueDate: string;
  /** `cancelled`: el contacto se perdió o se borró. */
  status: 'pending' | 'done' | 'cancelled';
  completedAt: string | null;
  authorName: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  outcome: string | null;
  createdAt: string;
}

export const CreateLeadActivitySchema = z.object({
  type: InteractionTypeEnum.default('note'),
  content: z.string().trim().min(1).max(5000),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateLeadActivityInput = z.infer<typeof CreateLeadActivitySchema>;

export interface LeadActivityDto {
  id: string;
  leadId: string;
  type: string;
  content: string;
  occurredAt: string;
  userName: string | null;
}

// ============================================================================
// Contactos sin atender y reparto automático
// ============================================================================

export const LeadAutoAssignEnum = z.enum(['off', 'round_robin', 'facility']);
export type LeadAutoAssign = z.infer<typeof LeadAutoAssignEnum>;

export const LEAD_AUTO_ASSIGN_LABELS: Record<LeadAutoAssign, string> = {
  off: 'Sin reparto',
  round_robin: 'Por turnos entre el equipo',
  facility: 'Por turnos entre quien ve el local del contacto',
};

export const UpdateLeadSettingsSchema = z
  .object({
    responseHours: z.number().int().min(1).max(168).optional(),
    autoAssign: LeadAutoAssignEnum.optional(),
    /** Meses que se guardan los contactos perdidos sin actividad (después se anonimizan). */
    retentionMonths: z.number().int().min(3).max(60).optional(),
    /** Correos automáticos a los contactos nuevos (precios, a los 2 y a los 7 días). */
    nurtureEnabled: z.boolean().optional(),
    /** El plazo de «sin atender» cuenta solo en el horario de atención. */
    useBusinessHours: z.boolean().optional(),
    /** Recordar un presupuesto sin reservar a los N días (0 = no). */
    quoteReminderDays: z.number().int().min(0).max(30).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateLeadSettingsInput = z.infer<typeof UpdateLeadSettingsSchema>;

export interface LeadSettingsDto {
  responseHours: number;
  autoAssign: LeadAutoAssign;
  retentionMonths: number;
  nurtureEnabled: boolean;
  useBusinessHours: boolean;
  /** ¿Hay horario de atención configurado (Configuración → Mensajes)? */
  businessHoursConfigured: boolean;
  quoteReminderDays: number;
}

export interface LeadResponseUserDto {
  userId: string | null;
  userName: string;
  leads: number;
  contacted: number;
  /** Mediana de horas entre la llegada del contacto y la primera respuesta. */
  medianHours: number | null;
  withinTargetPct: number | null;
}

export interface LeadResponseStatsDto {
  days: number;
  responseHours: number;
  /** Contactos nuevos ahora mismo sin atender pasado el plazo. */
  unattended: number;
  overall: LeadResponseUserDto;
  byUser: LeadResponseUserDto[];
}

// ============================================================================
// Duplicados
// ============================================================================

export interface LeadDuplicateMemberDto {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
}

export interface LeadDuplicateGroupDto {
  /** email | phone */
  reason: 'email' | 'phone';
  key: string;
  leads: LeadDuplicateMemberDto[];
  /** Inquilino con ese mismo email o teléfono (si lo hay). */
  customer: { id: string; name: string } | null;
}

export const MergeLeadSchema = z.object({ intoLeadId: z.string().uuid() });
export type MergeLeadInput = z.infer<typeof MergeLeadSchema>;

export const LinkLeadCustomerSchema = z.object({ customerId: z.string().uuid() });
export type LinkLeadCustomerInput = z.infer<typeof LinkLeadCustomerSchema>;

/** Teléfono comparable: últimas 9 cifras (España sin prefijo). */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

export function emailKey(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

// ============================================================================
// Puntuación de contactos
// ============================================================================

export interface LeadScoreInput {
  status: string;
  source: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  preferredFacilityId: string | null;
  preferredUnitTypeId: string | null;
  preferredStartDate: string | null;
  budgetMonthly: number | null;
  createdAt: string;
}

export interface LeadScoreDto {
  score: number;
  /** Lo que más suma, para enseñarlo en la tarjeta. */
  reasons: string[];
}

const HOT_SOURCES = new Set(['widget', 'web', 'whatsapp', 'presupuesto', 'recommendation']);

/**
 * Puntuación 0-100 de lo probable que es que el contacto alquile. Heurística
 * transparente: cuenta lo que dejó (teléfono, tamaño, fecha, presupuesto), de
 * dónde vino y lo reciente que es. Ganados y perdidos no puntúan.
 */
export function leadScore(lead: LeadScoreInput, now: Date = new Date()): LeadScoreDto {
  if (lead.status === 'won' || lead.status === 'lost') return { score: 0, reasons: [] };
  const parts: Array<{ points: number; reason: string }> = [];
  if (lead.phone) parts.push({ points: 15, reason: 'Dejó su teléfono' });
  if (lead.email) parts.push({ points: 5, reason: 'Dejó su email' });
  if (lead.preferredUnitTypeId) parts.push({ points: 15, reason: 'Sabe el tamaño que busca' });
  if (lead.preferredFacilityId) parts.push({ points: 5, reason: 'Eligió local' });
  if (lead.budgetMonthly && lead.budgetMonthly > 0) {
    parts.push({ points: 10, reason: 'Indicó presupuesto' });
  }
  if (lead.preferredStartDate) {
    const days = (Date.parse(lead.preferredStartDate) - now.getTime()) / 86_400_000;
    // Una fecha ya pasada no dice que tenga prisa (puede que ya no lo necesite).
    if (days >= -1) {
      if (days <= 30) parts.push({ points: 20, reason: 'Lo necesita en menos de un mes' });
      else if (days <= 90) parts.push({ points: 10, reason: 'Lo necesita pronto' });
    }
  }
  if ((lead.message ?? '').trim().length >= 30) {
    parts.push({ points: 5, reason: 'Explicó lo que busca' });
  }
  if (HOT_SOURCES.has(lead.source))
    parts.push({ points: 10, reason: 'Llegó por la web o WhatsApp' });
  if (lead.status === 'qualified') parts.push({ points: 15, reason: 'Ya está cualificado' });
  else if (lead.status === 'contacted') parts.push({ points: 5, reason: 'Ya se le contactó' });
  const ageDays = (now.getTime() - Date.parse(lead.createdAt)) / 86_400_000;
  if (ageDays <= 3) parts.push({ points: 10, reason: 'Es reciente' });
  else if (ageDays > 60) parts.push({ points: -15, reason: 'Lleva más de dos meses' });
  else if (ageDays > 30) parts.push({ points: -5, reason: 'Lleva más de un mes' });

  const score = Math.max(
    0,
    Math.min(
      100,
      parts.reduce((s, p) => s + p.points, 0),
    ),
  );
  const reasons = parts
    .filter((p) => p.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((p) => p.reason);
  return { score, reasons };
}

/**
 * Nombre con el que se enseña un contacto: empresa, nombre y apellidos, o, si
 * no dejó nombre, su email o teléfono.
 */
export function leadDisplayName(l: {
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email?: string | null;
  phone?: string | null;
}): string {
  return (
    l.companyName?.trim() ||
    [l.firstName, l.lastName].filter(Boolean).join(' ').trim() ||
    l.email?.trim() ||
    l.phone?.trim() ||
    'Contacto sin nombre'
  );
}

// ============================================================================
// Mejoras (2026-11-15): filtros, cronología, presupuestos, visitas, informe
// ============================================================================

/** Orígenes de la web que reciben la secuencia automática de correos. */
export const LEAD_NURTURE_SOURCES = ['web', 'widget', 'landing', 'web_chat'] as const;

/** Cuántos contactos y cuánto suman (al mes) en cada fase del tablero. */
export interface LeadSummaryDto {
  byStatus: Record<string, { count: number; value: number }>;
}

export type LeadTimelineKind =
  | 'created'
  | 'email_out'
  | 'email_in'
  | 'whatsapp_in'
  | 'whatsapp_out'
  | 'webchat_in'
  | 'webchat_out'
  | 'activity'
  | 'quote'
  | 'visit'
  | 'status'
  | 'followup';

/** Todo lo que ha pasado con un contacto, por orden. */
export interface LeadTimelineItemDto {
  id: string;
  kind: LeadTimelineKind;
  at: string;
  title: string;
  body: string | null;
  /** Quién lo hizo (persona del equipo) o null si fue el contacto o el sistema. */
  by: string | null;
  /** Estado de entrega de un correo (sent, delivered, bounced…). */
  status: string | null;
}

export interface LeadQuoteRecordDto {
  id: string;
  sentAt: string;
  channel: 'email' | 'whatsapp';
  facilityName: string | null;
  unitTypeName: string | null;
  months: number;
  couponCode: string | null;
  totalToPay: number;
  monthlyWithVat: number;
  bookUrl: string;
  sentByName: string | null;
  reminderSentAt: string | null;
  bookedAt: string | null;
}

export const LeadVisitStatusEnum = z.enum(['scheduled', 'done', 'no_show', 'cancelled']);
export type LeadVisitStatus = z.infer<typeof LeadVisitStatusEnum>;
export const LEAD_VISIT_STATUS_LABELS: Record<LeadVisitStatus, string> = {
  scheduled: 'Programada',
  done: 'Hecha',
  no_show: 'No vino',
  cancelled: 'Cancelada',
};

export const CreateLeadVisitSchema = z.object({
  facilityId: z.string().uuid().optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  notes: z.string().trim().max(1000).optional(),
  userId: z.string().uuid().optional(),
});
export type CreateLeadVisitInput = z.infer<typeof CreateLeadVisitSchema>;

export const UpdateLeadVisitSchema = z
  .object({
    status: LeadVisitStatusEnum.optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    userId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateLeadVisitInput = z.infer<typeof UpdateLeadVisitSchema>;

export interface LeadVisitDto {
  id: string;
  leadId: string;
  leadName: string;
  facilityId: string | null;
  facilityName: string | null;
  scheduledAt: string;
  status: LeadVisitStatus;
  notes: string | null;
  userId: string | null;
  userName: string | null;
}

export interface LeadFunnelRowDto {
  key: string;
  label: string;
  leads: number;
  contacted: number;
  qualified: number;
  won: number;
  lost: number;
  /** Ganados / contactos (%). */
  conversionPct: number | null;
  /** Días medios desde que llegó hasta que se ganó. */
  avgDaysToWin: number | null;
}

export interface LeadFunnelReportDto {
  from: string;
  to: string;
  totals: LeadFunnelRowDto;
  bySource: LeadFunnelRowDto[];
  byUser: LeadFunnelRowDto[];
  byFacility: LeadFunnelRowDto[];
}

// --- Bandeja de seguimientos (inquilinos y contactos) ------------------------

export const FollowupInboxTabEnum = z.enum(['today', 'overdue', 'upcoming', 'done']);
export type FollowupInboxTab = z.infer<typeof FollowupInboxTabEnum>;

export interface FollowupInboxItemDto {
  id: string;
  kind: 'customer' | 'lead';
  targetId: string;
  targetName: string;
  title: string;
  note: string | null;
  dueDate: string;
  status: 'pending' | 'done' | 'cancelled';
  outcome: string | null;
  completedAt: string | null;
  authorName: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
}

export interface FollowupInboxDto {
  items: FollowupInboxItemDto[];
  counts: Record<FollowupInboxTab, number>;
}

export interface FollowupDueCountDto {
  due: number;
}
