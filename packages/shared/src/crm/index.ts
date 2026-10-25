import { z } from 'zod';

import { InteractionTypeEnum } from '../customers/schemas';

// ============================================================================
// Seguimientos y actividad de un contacto
// ============================================================================

export const CreateLeadFollowupSchema = z.object({
  title: z.string().trim().min(2).max(200),
  note: z.string().trim().max(2000).optional(),
  /** YYYY-MM-DD */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
});
export type CreateLeadFollowupInput = z.infer<typeof CreateLeadFollowupSchema>;

export const UpdateLeadFollowupSchema = z.object({ status: z.enum(['pending', 'done']) });
export type UpdateLeadFollowupInput = z.infer<typeof UpdateLeadFollowupSchema>;

export interface LeadFollowupDto {
  id: string;
  leadId: string;
  leadName: string;
  title: string;
  note: string | null;
  dueDate: string;
  status: 'pending' | 'done';
  completedAt: string | null;
  authorName: string | null;
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
  })
  .refine((v) => v.responseHours !== undefined || v.autoAssign !== undefined, {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateLeadSettingsInput = z.infer<typeof UpdateLeadSettingsSchema>;

export interface LeadSettingsDto {
  responseHours: number;
  autoAssign: LeadAutoAssign;
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
    if (days <= 30) parts.push({ points: 20, reason: 'Lo necesita en menos de un mes' });
    else if (days <= 90) parts.push({ points: 10, reason: 'Lo necesita pronto' });
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
