import { z } from 'zod';

// ============================================================================
// Expedientes de impago (overlock → requerimiento → disposición)
// ============================================================================

export const DELINQUENCY_CASE_STATUSES = [
  'open',
  'overlocked',
  'final_notice',
  'resolution_pending',
  'disposal',
  'closed_paid',
  'closed_disposed',
  'closed_cancelled',
] as const;
export type DelinquencyCaseStatus = (typeof DELINQUENCY_CASE_STATUSES)[number];

/** Estados en los que el expediente está cerrado. */
export const CLOSED_CASE_STATUSES: DelinquencyCaseStatus[] = [
  'closed_paid',
  'closed_disposed',
  'closed_cancelled',
];

export const DISPOSAL_TYPES = ['auction_notarial', 'sale', 'donation', 'destruction'] as const;
export type DisposalType = (typeof DISPOSAL_TYPES)[number];

export const DISPOSAL_TYPE_LABELS: Record<DisposalType, string> = {
  auction_notarial: 'Subasta notarial',
  sale: 'Venta',
  donation: 'Donación',
  destruction: 'Destrucción',
};

export const CASE_FILE_KINDS = [
  'overlock_photo',
  'burofax_receipt',
  'inventory',
  'disposal_act',
  'other',
] as const;
export type CaseFileKind = (typeof CASE_FILE_KINDS)[number];

/** Tipos de evento del timeline del expediente. */
export const CASE_EVENT_TYPES = [
  'opened',
  'overlock_placed',
  'overlock_removed',
  'notice_sent',
  'deadline_expired',
  'payment_received',
  'inventory_done',
  'disposal_done',
  'settlement_done',
  'closed',
  'note',
] as const;
export type CaseEventType = (typeof CASE_EVENT_TYPES)[number];

// --- Schemas ---------------------------------------------------------------

/** Apertura manual de un expediente sobre un contrato con deuda. */
export const OpenCaseSchema = z.object({
  contractId: z.string().uuid(),
  notes: z.string().trim().max(2000).optional(),
});
export type OpenCaseInput = z.infer<typeof OpenCaseSchema>;

/** Registro del overlock (candado físico colocado). */
export const OverlockCaseSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});
export type OverlockCaseInput = z.infer<typeof OverlockCaseSchema>;

/** Registro del envío del requerimiento fehaciente (burofax). */
export const SendNoticeSchema = z.object({
  /** Fecha de envío del burofax (ISO); por defecto ahora. */
  sentAt: z.string().datetime().optional(),
  /** Días de plazo; por defecto el `collectionsNoticeDays` del tenant. */
  noticeDays: z.number().int().min(1).max(180).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type SendNoticeInput = z.infer<typeof SendNoticeSchema>;

/** Inicio de la disposición del contenido (exige inventario previo). */
export const StartDisposalSchema = z.object({
  disposalType: z.enum(DISPOSAL_TYPES),
  notes: z.string().trim().max(2000).optional(),
});
export type StartDisposalInput = z.infer<typeof StartDisposalSchema>;

/** Cierre por disposición completada + liquidación. */
export const CompleteDisposalSchema = z.object({
  /** Importe obtenido de la disposición en céntimos (0 si donación/destrucción). */
  proceedsCents: z.number().int().min(0).max(100_000_000).default(0),
  notes: z.string().trim().max(2000).optional(),
});
export type CompleteDisposalInput = z.infer<typeof CompleteDisposalSchema>;

/** Cancelación del expediente (el operador desiste). */
export const CancelCaseSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type CancelCaseInput = z.infer<typeof CancelCaseSchema>;

/** Nota manual añadida al timeline. */
export const CaseNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});
export type CaseNoteInput = z.infer<typeof CaseNoteSchema>;

/** Config del tenant para impagos físicos (opt-in; plazos por su asesoría). */
export const UpdateCollectionsSettingsSchema = z.object({
  collectionsEnabled: z.boolean().optional(),
  collectionsOpenAfterDays: z.number().int().min(1).max(365).optional(),
  collectionsNoticeDays: z.number().int().min(1).max(180).optional(),
  collectionsClauseRef: z.string().trim().max(500).optional().or(z.literal('')),
});
export type UpdateCollectionsSettingsInput = z.infer<typeof UpdateCollectionsSettingsSchema>;

// --- File uploads (patrón inspection photos) -------------------------------

export const RequestCaseFileUploadSchema = z.object({
  kind: z.enum(CASE_FILE_KINDS),
  contentType: z.string().trim().min(1).max(120),
});
export type RequestCaseFileUploadInput = z.infer<typeof RequestCaseFileUploadSchema>;

export const RegisterCaseFileSchema = z.object({
  kind: z.enum(CASE_FILE_KINDS),
  objectKey: z.string().trim().min(1).max(500),
  contentType: z.string().trim().max(120).optional(),
});
export type RegisterCaseFileInput = z.infer<typeof RegisterCaseFileSchema>;

// --- DTOs ------------------------------------------------------------------

export interface CollectionsSettingsResponse {
  collectionsEnabled: boolean;
  collectionsOpenAfterDays: number;
  collectionsNoticeDays: number;
  collectionsClauseRef: string | null;
}

export interface DelinquencyCaseEventDto {
  id: string;
  eventType: CaseEventType | string;
  payload: Record<string, unknown>;
  createdByName: string | null;
  occurredAt: string;
}

export interface DelinquencyCaseFileDto {
  id: string;
  kind: CaseFileKind | string;
  /** URL GET firmada (5 min). */
  url: string;
  contentType: string | null;
  createdAt: string;
}

/** Fila de la lista de expedientes. */
export interface DelinquencyCaseDto {
  id: string;
  contractId: string;
  customerId: string;
  customerName: string;
  unitId: string | null;
  unitCode: string | null;
  facilityId: string | null;
  facilityName: string | null;
  status: DelinquencyCaseStatus;
  /** Deuda viva (céntimos) recalculada de las facturas del contrato. */
  debtCents: number;
  disposalType: DisposalType | string | null;
  openedAt: string;
  overlockedAt: string | null;
  finalNoticeAt: string | null;
  finalNoticeDeadline: string | null;
  /** El plazo del requerimiento ya venció (y sigue sin pagar). */
  deadlineExpired: boolean;
  closedAt: string | null;
  notes: string | null;
}

/** Detalle con timeline + evidencias. */
export interface DelinquencyCaseDetailDto extends DelinquencyCaseDto {
  events: DelinquencyCaseEventDto[];
  files: DelinquencyCaseFileDto[];
}
