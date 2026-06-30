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
}

export interface AuditLogListDto {
  items: AuditLogDto[];
  /** Cursor para la siguiente página; null si no hay más. */
  nextCursor: string | null;
}
