import { z } from 'zod';

// ============================================================================
// Funcionalidades de la Operativa: entrada y salida, tareas automáticas,
// asignación en lote, contexto de una incidencia, autorizados, informe de
// accesos y la vista de la puerta.
// ============================================================================

/** Un paso de la entrada o la salida de un contrato. */
export interface ContractChecklistStepDto {
  key: string;
  label: string;
  done: boolean;
  /** Qué falta o dónde se hace. */
  hint: string | null;
}

export interface ContractChecklistDto {
  moveIn: ContractChecklistStepDto[];
  /** Solo con la baja pedida o el contrato cerrado. */
  moveOut: ContractChecklistStepDto[] | null;
}

/** Reglas de tareas automáticas por evento de contrato. */
export const TaskAutoRulesSchema = z.object({
  /** Llamada de bienvenida N días después de firmar. */
  welcomeCall: z.object({
    enabled: z.boolean(),
    days: z.number().int().min(0).max(60),
  }),
  /** Revisar el trastero N días después de la salida. */
  moveOutInspection: z.object({
    enabled: z.boolean(),
    days: z.number().int().min(0).max(30),
  }),
  /** Llamar para renovar cuando el contrato está a punto de vencer. */
  renewalCall: z.object({ enabled: z.boolean() }),
});
export type TaskAutoRules = z.infer<typeof TaskAutoRulesSchema>;

export const DEFAULT_TASK_AUTO_RULES: TaskAutoRules = {
  welcomeCall: { enabled: false, days: 3 },
  moveOutInspection: { enabled: false, days: 1 },
  renewalCall: { enabled: false },
};

/** Lee las reglas guardadas completando lo que falte. */
export function parseTaskAutoRules(raw: unknown): TaskAutoRules {
  const r = (raw ?? {}) as Partial<Record<keyof TaskAutoRules, Record<string, unknown>>>;
  const merged = {
    welcomeCall: { ...DEFAULT_TASK_AUTO_RULES.welcomeCall, ...(r.welcomeCall ?? {}) },
    moveOutInspection: {
      ...DEFAULT_TASK_AUTO_RULES.moveOutInspection,
      ...(r.moveOutInspection ?? {}),
    },
    renewalCall: { ...DEFAULT_TASK_AUTO_RULES.renewalCall, ...(r.renewalCall ?? {}) },
  };
  const parsed = TaskAutoRulesSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_TASK_AUTO_RULES;
}

export const BulkAssignTasksSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(200),
  /** null = quitar la asignación. */
  assignedToUserId: z.string().uuid().nullable(),
});
export type BulkAssignTasksInput = z.infer<typeof BulkAssignTasksSchema>;

export interface BulkAssignTasksResultDto {
  updated: number;
}

/** Contexto de una incidencia: el trastero, quién lo ha tenido y los últimos accesos. */
export interface IncidentContextDto {
  unit: { id: string; code: string; status: string; facilityName: string } | null;
  contracts: {
    id: string;
    contractNumber: string;
    customerId: string;
    customerName: string;
    status: string;
    startDate: string;
    endDate: string | null;
  }[];
  accessLogs: {
    id: string;
    occurredAt: string;
    result: string;
    customerName: string | null;
    deviceName: string | null;
  }[];
}

/** Trasladar el contrato desde la solicitud de cambio de trastero. */
export const MoveFromUnitChangeSchema = z.object({
  newUnitId: z.string().uuid(),
  newPrice: z.number().positive().max(100_000).optional(),
  prorate: z.boolean().optional(),
});
export type MoveFromUnitChangeInput = z.infer<typeof MoveFromUnitChangeSchema>;

/** Personas autorizadas por el inquilino. */
export const CustomerAuthorizedPersonSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  documentNumber: z.string().trim().max(40).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  relationship: z.string().trim().max(80).optional().or(z.literal('')),
  canAccess: z.boolean().default(true),
  canPickup: z.boolean().default(false),
  canManage: z.boolean().default(false),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
});
export type CustomerAuthorizedPersonInput = z.infer<typeof CustomerAuthorizedPersonSchema>;

export interface CustomerAuthorizedPersonDto {
  id: string;
  customerId: string;
  fullName: string;
  documentNumber: string | null;
  phone: string | null;
  relationship: string | null;
  canAccess: boolean;
  canPickup: boolean;
  canManage: boolean;
  notes: string | null;
  createdAt: string;
}

/** Informe de accesos de un periodo. */
export interface AccessReportDto {
  days: number;
  totals: { allowed: number; denied: number; uniqueCustomers: number };
  byDay: { date: string; allowed: number; denied: number }[];
  /** 24 posiciones (hora local del tenant). */
  byHour: number[];
  topCustomers: { customerId: string; customerName: string; visits: number }[];
  /** Quién acumula más denegaciones (posible PIN mal o acceso cortado). */
  topDenied: { customerId: string | null; customerName: string; denied: number; reason: string }[];
}

/** PIN de un solo uso para un visitante, válido hasta el final del día. */
export const VisitorPinSchema = z.object({
  customerId: z.string().uuid(),
  facilityId: z.string().uuid(),
  label: z.string().trim().max(80).optional().or(z.literal('')),
});
export type VisitorPinInput = z.infer<typeof VisitorPinSchema>;

export interface VisitorPinDto {
  credentialId: string;
  pin: string;
  expiresAt: string;
}

/** Vista de la puerta del local (tablet en recepción). */
export interface DoorViewPersonDto {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  unitCode: string;
}

export interface DoorViewDto {
  facility: { id: string; name: string; timezone: string };
  devices: { id: string; name: string; lastSeenAt: string | null }[];
  moveIns: DoorViewPersonDto[];
  moveOuts: DoorViewPersonDto[];
  recent: {
    id: string;
    occurredAt: string;
    result: string;
    customerName: string | null;
    deviceName: string | null;
  }[];
}
