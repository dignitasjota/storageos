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
