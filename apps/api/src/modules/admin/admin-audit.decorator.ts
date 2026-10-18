import { SetMetadata } from '@nestjs/common';

export const ADMIN_AUDIT_KEY = 'adminAudit';

export interface AdminAuditMeta {
  action: string;
  targetType?: string;
}

/**
 * Deja rastro en `super_admin_audit_logs` cuando el endpoint responde bien
 * (lo escribe `AdminAuditInterceptor`). Para acciones de configuración de la
 * plataforma que no tienen su propio `audit.record`. Solo guarda los nombres
 * de los campos enviados, nunca sus valores (pueden llevar claves o IBAN).
 */
export const AdminAudit = (action: string, targetType?: string) =>
  SetMetadata(ADMIN_AUDIT_KEY, {
    action,
    ...(targetType ? { targetType } : {}),
  } satisfies AdminAuditMeta);
