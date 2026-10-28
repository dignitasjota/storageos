/** Una entrada del registro de actividad (audit log) del tenant. */
export interface AuditLogDto {
  id: string;
  /** Código de la acción (p. ej. "invoice.issued"). */
  action: string;
  entityType: string;
  entityId: string | null;
  /** Usuario que la realizó; null si fue el sistema o se borró su cuenta. */
  userName: string | null;
  createdAt: string;
  /** Qué cambió (lo que guardó la acción; puede ser null). */
  changes: unknown;
  ipAddress: string | null;
}

/** Filtros de GET /audit-logs. */
export interface AuditLogFilters {
  userId?: string;
  /** Prefijo de la acción (p. ej. «invoice.» o «invoice.issued»). */
  action?: string;
  from?: string;
  to?: string;
}

export interface AuditLogListDto {
  items: AuditLogDto[];
  /** Cursor para la siguiente página; null si no hay más. */
  nextCursor: string | null;
}
export * from './labels';
