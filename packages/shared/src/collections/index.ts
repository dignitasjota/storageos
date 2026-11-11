import { z } from 'zod';

// ============================================================================
// Expedientes de impago (overlock → requerimiento → disposición)
// ============================================================================

export const DELINQUENCY_CASE_STATUSES = [
  'open',
  'overlocked',
  'final_notice',
  'resolution_pending',
  // Condición 12 del contrato: pasado el plazo se resuelve el contrato y los
  // bienes se trasladan (con inventario) a un lugar de custodia; solo después,
  // y por los cauces legales, se puede disponer de ellos.
  'contract_resolved',
  'goods_moved',
  'disposal',
  'closed_paid',
  'closed_disposed',
  'closed_cancelled',
] as const;
export type DelinquencyCaseStatus = (typeof DELINQUENCY_CASE_STATUSES)[number];

export const CASE_STATUS_LABELS: Record<DelinquencyCaseStatus, string> = {
  open: 'Abierto',
  overlocked: 'Con candado',
  final_notice: 'Requerimiento enviado',
  resolution_pending: 'Plazo vencido',
  contract_resolved: 'Contrato resuelto',
  goods_moved: 'Bienes en custodia',
  disposal: 'En disposición',
  closed_paid: 'Cerrado · pagado',
  closed_disposed: 'Cerrado · dispuesto',
  closed_cancelled: 'Cerrado · cancelado',
};

/** Estados en los que el expediente está cerrado. */
export const CLOSED_CASE_STATUSES: DelinquencyCaseStatus[] = [
  'closed_paid',
  'closed_disposed',
  'closed_cancelled',
];

/**
 * Cauces legales para disponer de los bienes (condición 12 del contrato): no
 * se vende ni se destruye nada por cuenta propia. Con «abandono acreditado»,
 * solo pasadas 8 semanas de custodia desde el traslado.
 */
export const DISPOSAL_TYPES = ['court_order', 'written_agreement', 'abandonment'] as const;
export type DisposalType = (typeof DISPOSAL_TYPES)[number];

/** Semanas de custodia antes de poder dar los bienes por abandonados. */
export const CUSTODY_WEEKS_BEFORE_ABANDONMENT = 8;
/** Plazo mínimo del requerimiento (condición 12: no inferior a 15 días). */
export const MIN_NOTICE_DAYS = 15;

export const DISPOSAL_TYPE_LABELS: Record<string, string> = {
  court_order: 'Resolución judicial',
  written_agreement: 'Acuerdo escrito con el inquilino',
  abandonment: 'Abandono acreditado (tras 8 semanas de custodia)',
  // Expedientes anteriores.
  auction_notarial: 'Subasta notarial',
  sale: 'Venta',
  donation: 'Donación',
  destruction: 'Destrucción',
};

export const CASE_FILE_KINDS = [
  'requirement', // el requerimiento fehaciente generado por el sistema (PDF)
  'overlock_photo',
  'burofax_receipt',
  'inventory',
  'custody_act',
  'disposal_act',
  'other',
] as const;
export type CaseFileKind = (typeof CASE_FILE_KINDS)[number];

export const CASE_FILE_KIND_LABELS: Record<CaseFileKind, string> = {
  requirement: 'Requerimiento (PDF)',
  overlock_photo: 'Foto del candado',
  burofax_receipt: 'Acuse del burofax',
  inventory: 'Inventario (fotos y lista)',
  custody_act: 'Acta del traslado',
  disposal_act: 'Documento del cauce legal (sentencia, acuerdo…)',
  other: 'Otro',
};

/** Tipos de evento del timeline del expediente. */
export const CASE_EVENT_TYPES = [
  'opened',
  'overlock_placed',
  'overlock_removed',
  'notice_sent',
  'notice_received',
  'deadline_expired',
  'contract_resolved',
  'goods_moved',
  'payment_received',
  'inventory_done',
  'disposal_started',
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
  /**
   * Cómo se le avisó antes del candado si no fue por un recordatorio de la app
   * (una llamada, en persona…): la condición 12 pide avisar antes.
   */
  priorNotice: z.string().trim().max(500).optional(),
});
export type OverlockCaseInput = z.infer<typeof OverlockCaseSchema>;

/** Registro del envío del requerimiento fehaciente (burofax). */
export const SendNoticeSchema = z.object({
  /** Fecha de envío del burofax (ISO); por defecto ahora. */
  sentAt: z.string().datetime().optional(),
  /** Días de plazo (mínimo 15); por defecto el del negocio. */
  noticeDays: z.number().int().min(MIN_NOTICE_DAYS).max(180).optional(),
  /** Nº de envío del burofax (para seguirlo). */
  tracking: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type SendNoticeInput = z.infer<typeof SendNoticeSchema>;

/** El inquilino recibió el requerimiento: el plazo cuenta desde ese día. */
export const NoticeReceivedSchema = z.object({
  receivedAt: z.string().datetime(),
  notes: z.string().trim().max(2000).optional(),
});
export type NoticeReceivedInput = z.infer<typeof NoticeReceivedSchema>;

/** Pasado el plazo sin pagar: el contrato queda resuelto (condición 12). */
export const ResolveContractSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});
export type ResolveContractInput = z.infer<typeof ResolveContractSchema>;

/** Traslado de los bienes con inventario a un lugar de custodia. */
export const MoveGoodsSchema = z.object({
  /** Dónde quedan custodiados (nave, trastero…). */
  custodyLocation: z.string().trim().min(3).max(300),
  notes: z.string().trim().max(2000).optional(),
});
export type MoveGoodsInput = z.infer<typeof MoveGoodsSchema>;

/** Inicio de la disposición, solo por un cauce legal. */
export const StartDisposalSchema = z.object({
  disposalType: z.enum(DISPOSAL_TYPES),
  notes: z.string().trim().max(2000).optional(),
});
export type StartDisposalInput = z.infer<typeof StartDisposalSchema>;

/** Cierre por disposición completada + liquidación. */
export const CompleteDisposalSchema = z.object({
  /** Importe obtenido de la disposición en céntimos (0 si donación/destrucción). */
  proceedsCents: z.number().int().min(0).max(100_000_000).default(0),
  /**
   * Liquidación fina: aplica la fianza retenida + lo obtenido de la disposición
   * a las facturas pendientes por antigüedad (más antigua primero). Por defecto sí.
   */
  applyDeposit: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional(),
});
export type CompleteDisposalInput = z.infer<typeof CompleteDisposalSchema>;

/** Desglose de la liquidación fina de un expediente al cerrarlo por disposición. */
export interface DelinquencySettlementDto {
  /** Deuda viva (céntimos) antes de aplicar fondos. */
  debtBeforeCents: number;
  /** Fianza retenida aplicada a la deuda (céntimos). */
  depositAppliedCents: number;
  /** Producto de la disposición aplicado a la deuda (céntimos). */
  proceedsAppliedCents: number;
  /** Deuda viva (céntimos) tras aplicar los fondos. */
  debtAfterCents: number;
  /** Lo obtenido de la disposición que sobra tras saldar la deuda (céntimos). */
  surplusCents: number;
  /** Fianza que no hizo falta y hay que devolver al inquilino (céntimos). */
  depositReturnedCents: number;
  /** Nº de facturas saldadas total o parcialmente. */
  invoicesSettled: number;
}

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
  collectionsOpenAfterDays: z.number().int().min(8).max(365).optional(),
  collectionsNoticeDays: z.number().int().min(MIN_NOTICE_DAYS).max(180).optional(),
  collectionsClauseRef: z.string().trim().max(500).optional().or(z.literal('')),
});
export type UpdateCollectionsSettingsInput = z.infer<typeof UpdateCollectionsSettingsSchema>;

// --- File uploads (patrón inspection photos) -------------------------------

// Evidencia de expedientes de impago: fotos del candado/inventario/burofax o
// el requerimiento en PDF. Mismo whitelist que el resto de subidas de
// documentos (las fotos del móvil se convierten a JPEG antes de subirlas).
export const CASE_FILE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;

export const RequestCaseFileUploadSchema = z.object({
  kind: z.enum(CASE_FILE_KINDS),
  contentType: z.enum(CASE_FILE_MIME_TYPES),
});
export type RequestCaseFileUploadInput = z.infer<typeof RequestCaseFileUploadSchema>;

export const RegisterCaseFileSchema = z.object({
  kind: z.enum(CASE_FILE_KINDS),
  objectKey: z.string().trim().min(1).max(500),
  contentType: z.enum(CASE_FILE_MIME_TYPES).optional(),
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
  /** Días de plazo del requerimiento, nº de envío y cuándo lo recibió. */
  noticeDays: number | null;
  noticeTracking: string | null;
  noticeReceivedAt: string | null;
  contractResolvedAt: string | null;
  goodsMovedAt: string | null;
  custodyLocation: string | null;
  /** Con «abandono acreditado», desde cuándo se puede (8 semanas de custodia). */
  abandonmentFrom: string | null;
  closedAt: string | null;
  notes: string | null;
}

/** Una factura vencida del expediente. */
export interface DelinquencyCaseInvoiceDto {
  id: string;
  invoiceNumber: string;
  dueDate: string | null;
  pendingCents: number;
}

/** Detalle con timeline + evidencias. */
export interface DelinquencyCaseDetailDto extends DelinquencyCaseDto {
  events: DelinquencyCaseEventDto[];
  files: DelinquencyCaseFileDto[];
  /** Las facturas vencidas que forman la deuda. */
  invoices: DelinquencyCaseInvoiceDto[];
  /** Ya se le avisó del impago (requisito para poner el candado). */
  reminded: boolean;
}

/** Resultado de generar el requerimiento fehaciente (PDF) del expediente. */
export interface DelinquencyRequirementPdfDto {
  /** URL GET firmada (5 min) del PDF generado. */
  url: string;
}

/** Vista rápida de los expedientes de impago ABIERTOS (para el Resumen del panel). */
export interface CollectionsSummaryDto {
  /** Nº de expedientes en cualquier estado no cerrado. */
  openCount: number;
  /** Deuda viva total de esos expedientes (euros, recalculada de las facturas). */
  totalDebt: number;
  /** Nº de expedientes por estado (solo estados abiertos, ausentes = 0). */
  byStatus: Partial<Record<DelinquencyCaseStatus, number>>;
}
