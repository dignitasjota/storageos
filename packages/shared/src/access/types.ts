import type {
  AccessCredentialStatusValue,
  AccessDeviceTypeValue,
  AccessMethodValue,
  AccessResultValue,
} from './schemas';

export interface AccessCredentialDto {
  id: string;
  customerId: string;
  customerName: string;
  method: AccessMethodValue;
  status: AccessCredentialStatusValue;
  label: string | null;
  secretPreview: string | null;
  rfidUid: string | null;
  allowedFacilityIds: string[];
  allowedUnitIds: string[];
  allowedHours: Record<string, unknown>;
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
  /** URL del controlador HTTP (sin el secreto). */
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
}
