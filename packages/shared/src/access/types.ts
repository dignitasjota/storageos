import type {
  AccessAllowedHours,
  AccessCredentialStatusValue,
  AccessDeviceTypeValue,
  AccessMethodValue,
  AccessResultValue,
} from './schemas';

export interface AccessCredentialDto {
  id: string;
  customerId: string | null;
  /** Inquilino o titular del acceso temporal. */
  customerName: string;
  holderKind: string | null;
  validFrom: string | null;
  method: AccessMethodValue;
  status: AccessCredentialStatusValue;
  label: string | null;
  secretPreview: string | null;
  rfidUid: string | null;
  allowedFacilityIds: string[];
  allowedUnitIds: string[];
  allowedHours: AccessAllowedHours;
  /** Acceso 24h: salta el toque de queda del local. */
  bypassCurfew: boolean;
  /** Usos máximos (single-use = 1, pase nocturno). null = ilimitado. */
  maxUses: number | null;
  usesCount: number;
  suspendReason: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  suspendedAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  contractId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Cuando se crea o se rota una credencial PIN/QR el secreto se devuelve
 * UNA SOLA VEZ. El frontend debe mostrarlo al usuario y avisar de que no
 * vuelve a verse.
 */
export interface AccessCredentialWithSecretDto extends AccessCredentialDto {
  /** Texto plano del PIN o token QR; null si method=rfid. */
  revealedSecret: string | null;
}

export interface AccessDeviceDto {
  id: string;
  facilityId: string;
  facilityName: string;
  unitId: string | null;
  unitCode: string | null;
  type: AccessDeviceTypeValue;
  name: string;
  hardwareId: string;
  apiKeyPreview: string | null;
  mqttTopic: string | null;
  /** Provider de cerradura del device (null = default global env). */
  provider: string | null;
  /** URL del controlador HTTP / terminal Dahua (sin el secreto). */
  controlUrl: string | null;
  /** Si tiene secreto HMAC configurado (sin exponerlo). */
  hasControlSecret: boolean;
  isOnline: boolean;
  lastSeenAt: string | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Solo se devuelve al crear o al regenerar la API key. */
export interface AccessDeviceWithKeyDto extends AccessDeviceDto {
  revealedApiKey: string;
}

export interface AccessLogDto {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  credentialId: string | null;
  customerId: string | null;
  customerName: string | null;
  method: AccessMethodValue;
  result: AccessResultValue;
  attemptedValue: string | null;
  reason: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
  /** Apertura o cierre desde el panel: quién lo hizo. */
  staffName: string | null;
}

/** Todo el acceso de un inquilino. */
export interface CustomerAccessSummaryDto {
  credentials: AccessCredentialDto[];
  /** Cortado por una factura sin pagar. */
  cutForDebt: boolean;
  /** Facturas que tienen el acceso cortado. */
  debtInvoices: { id: string; invoiceNumber: string | null; amountPending: number }[];
  lastAllowedAt: string | null;
  lastDeniedAt: string | null;
  recent: AccessLogDto[];
}

/** Cómo va la sincronización de un terminal. */
export interface AccessSyncDeviceDto {
  deviceId: string;
  deviceName: string;
  facilityName: string;
  /** Credenciales que deberían estar en el terminal. */
  expected: number;
  synced: number;
  failed: number;
  errors: { credentialId: string; holderName: string; error: string }[];
}

/** Foto de cámara más cercana a un acceso. */
export interface AccessLogCameraDto {
  url: string;
  occurredAt: string;
  cameraName: string;
}

export interface VerifyAccessResultDto {
  result: AccessResultValue;
  /** Si allowed, el device puede abrir la cerradura. */
  allowed: boolean;
  /** Customer asociado (para mostrar en panel del device). */
  customerName?: string | null;
  /** Motivo cuando denied. */
  reason?: string;
}

/**
 * Credencial de acceso vista desde el portal del inquilino: incluye el valor
 * (PIN o token QR) descifrado para mostrarlo/presentarlo en el lector. Solo
 * `pin` y `qr` (la RFID es una tarjeta física). `value` es null en credenciales
 * antiguas sin copia cifrada → el inquilino puede regenerarla para obtener una.
 */
export interface PortalAccessCredentialDto {
  id: string;
  method: 'pin' | 'qr';
  label: string | null;
  status: AccessCredentialStatusValue;
  value: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Acceso adicional que se creó el propio inquilino (familiar, empleado…). */
  extra?: boolean;
  /**
   * Acceso suspendido: por un impago (con la factura y lo que falta por pagar)
   * u otro motivo del operador. `value` va a null mientras esté suspendido.
   */
  suspension?: {
    unpaid: boolean;
    invoiceId: string | null;
    invoiceNumber: string | null;
    pending: number | null;
  } | null;
}

/** Una puerta que el inquilino puede abrir desde el portal («tu móvil es la llave»). */
export interface PortalDoorDto {
  id: string;
  name: string;
  facilityName: string;
}

/** Resultado de intentar abrir una puerta desde el portal. */
export interface PortalOpenDoorResultDto {
  opened: boolean;
  message: string;
}

/** Una entrada del historial de accesos del inquilino (slim, sin datos internos). */
export interface PortalAccessLogDto {
  id: string;
  /** Nombre del dispositivo/puerta; null si se borró. */
  deviceName: string | null;
  method: AccessMethodValue;
  result: AccessResultValue;
  occurredAt: string;
}

/** Un pase nocturno, visto por el staff (subpágina de accesos). */
export interface NightPassStaffDto {
  id: string;
  customerId: string;
  customerName: string;
  /** active = sin usar y vigente · used = ya utilizado · expired = caducó sin usar. */
  status: 'active' | 'used' | 'expired';
  createdAt: string;
  expiresAt: string | null;
}

/** Listado de pases nocturnos del tenant + resumen (para la subpágina staff). */
export interface NightPassListDto {
  passes: NightPassStaffDto[];
  total: number;
  active: number;
  used: number;
  expired: number;
  /** Ingresos facturados por pases nocturnos (suma de las líneas «Pase nocturno»). */
  revenue: number;
}

/** Motivos del registro de accesos que no son texto para leer. */
const ACCESS_REASON_LABELS: Record<string, string> = {
  remote_open_by_staff: 'Apertura desde el panel',
  remote_close_by_staff: 'Cierre desde el panel',
  portal_open_by_customer: 'Apertura desde el área de clientes',
  reconciled_from_device: 'Registrado por el terminal',
  control_url_unsafe: 'Dirección del equipo no permitida',
  lock_error: 'La cerradura no ha respondido',
  http_error: 'La cerradura no ha respondido',
  redirect_not_allowed: 'La cerradura no ha respondido',
  device_sin_control_url: 'Equipo sin dirección configurada',
  device_sin_credenciales_digest: 'Equipo sin usuario y contraseña',
  close_not_supported: 'El equipo no admite cierre remoto',
};

/** Motivo de un registro de acceso, en palabras. */
export function accessReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const text = reason.replace(/^portal: /, '');
  return ACCESS_REASON_LABELS[text] ?? text;
}

/** ¿Es una apertura o un cierre hecho por el equipo, y no una entrada? */
export function isStaffAccessLog(reason: string | null | undefined): boolean {
  return reason === 'remote_open_by_staff' || reason === 'remote_close_by_staff';
}
