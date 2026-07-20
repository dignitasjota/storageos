import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

// ============================================================================
// Enums
// ============================================================================

export const AccessMethodEnum = z.enum(['pin', 'qr', 'rfid', 'face']);
export type AccessMethodValue = z.infer<typeof AccessMethodEnum>;

/**
 * Alta de una credencial FACIAL. La foto va aparte (base64 JPEG/PNG, ≤100KB por
 * el límite de Dahua `FaceInfoManager`). Feature `facial_access` (add-on).
 */
export const CreateFacialCredentialSchema = z.object({
  customerId: z.string().uuid(),
  label: z.string().trim().max(120).optional(),
  /** Foto de la cara en base64 (sin el prefijo `data:`). */
  photoBase64: z.string().min(1).max(200_000),
  photoMimeType: z.enum(['image/jpeg', 'image/png']).default('image/jpeg'),
  allowedFacilityIds: z.array(z.string().uuid()).optional(),
  allowedUnitIds: z.array(z.string().uuid()).optional(),
});
export type CreateFacialCredentialInput = z.infer<typeof CreateFacialCredentialSchema>;

export const AccessCredentialStatusEnum = z.enum([
  'pending',
  'active',
  'suspended',
  'revoked',
  'expired',
]);
export type AccessCredentialStatusValue = z.infer<typeof AccessCredentialStatusEnum>;

export const AccessDeviceTypeEnum = z.enum(['door', 'unit_lock', 'gate', 'other']);
export type AccessDeviceTypeValue = z.infer<typeof AccessDeviceTypeEnum>;

export const AccessResultEnum = z.enum([
  'allowed',
  'denied_invalid_credential',
  'denied_inactive_credential',
  'denied_outside_hours',
  'denied_wrong_facility',
  'denied_dunning',
  'denied_unknown',
  'error',
]);
export type AccessResultValue = z.infer<typeof AccessResultEnum>;

// ============================================================================
// Ventanas horarias por credencial
// ============================================================================

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM');

/**
 * Una franja horaria permitida para una credencial: días de la semana
 * (0=domingo … 6=sábado) + rango [start, end). No cruza medianoche (para el
 * bloqueo nocturno está el toque de queda del local); `start` < `end`.
 */
export const AccessWindowSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: HHMM,
    end: HHMM,
  })
  .refine((v) => v.start < v.end, {
    message: 'La hora de inicio debe ser anterior a la de fin',
    path: ['end'],
  });
export type AccessWindow = z.infer<typeof AccessWindowSchema>;

/** Ventanas horarias de una credencial. Sin ventanas = acceso a cualquier hora. */
export const AccessAllowedHoursSchema = z
  .object({ windows: z.array(AccessWindowSchema).max(14).default([]) })
  .default({ windows: [] });
export type AccessAllowedHours = z.infer<typeof AccessAllowedHoursSchema>;

/** Parseo defensivo del JSON `allowedHours` de una credencial (tolera `{}`). */
export function accessWindowsFrom(raw: unknown): AccessWindow[] {
  const parsed = AccessAllowedHoursSchema.safeParse(raw);
  return parsed.success ? parsed.data.windows : [];
}

const hhmmToMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/**
 * ¿El momento (día 0-6 + minutos desde medianoche) cae dentro de alguna
 * ventana? Sin ventanas → true (sin restricción horaria por credencial).
 */
export function isWithinAccessWindows(
  windows: AccessWindow[],
  weekday: number,
  minutes: number,
): boolean {
  if (windows.length === 0) return true;
  return windows.some(
    (w) => w.days.includes(weekday) && minutes >= hhmmToMin(w.start) && minutes < hhmmToMin(w.end),
  );
}

// ============================================================================
// Credentials
// ============================================================================

export const CreateCredentialSchema = z
  .object({
    customerId: z.string().uuid(),
    method: AccessMethodEnum,
    label: optionalText(120),
    /** Solo para method=rfid; UID hex. */
    rfidUid: z.string().trim().min(4).max(40).optional(),
    /** Si method=pin y no se pasa, se genera aleatorio. */
    pin: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, 'PIN de 4 a 8 digitos')
      .optional(),
    allowedFacilityIds: z.array(z.string().uuid()).default([]),
    allowedUnitIds: z.array(z.string().uuid()).default([]),
    allowedHours: AccessAllowedHoursSchema,
    /** Acceso 24h: salta el toque de queda del local (típico de staff). */
    bypassCurfew: z.boolean().default(false),
    /** Usos máximos (single-use = 1). Sin valor = ilimitado. */
    maxUses: z.number().int().positive().max(100).optional(),
    expiresAt: z.string().datetime().optional(),
    contractId: z.string().uuid().optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .refine((v) => v.method !== 'rfid' || !!v.rfidUid, {
    message: 'rfidUid requerido cuando method=rfid',
    path: ['rfidUid'],
  });
export type CreateCredentialInput = z.infer<typeof CreateCredentialSchema>;

export const UpdateCredentialSchema = z
  .object({
    label: optionalText(120),
    allowedFacilityIds: z.array(z.string().uuid()).optional(),
    allowedUnitIds: z.array(z.string().uuid()).optional(),
    allowedHours: AccessAllowedHoursSchema.optional(),
    bypassCurfew: z.boolean().optional(),
    expiresAt: z.string().datetime().optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateCredentialInput = z.infer<typeof UpdateCredentialSchema>;

export const RotateCredentialSchema = z.object({
  /** Si pin y omitido se genera aleatorio; si rfid se pasa el nuevo UID. */
  pin: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'PIN de 4 a 8 digitos')
    .optional(),
  rfidUid: z.string().trim().min(4).max(40).optional(),
});
export type RotateCredentialInput = z.infer<typeof RotateCredentialSchema>;

export const SuspendCredentialSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});
export type SuspendCredentialInput = z.infer<typeof SuspendCredentialSchema>;

// ============================================================================
// Devices
// ============================================================================

/** Provider de cerradura por dispositivo (null/omitido = default global env). */
export const LockProviderEnum = z.enum(['stub', 'mqtt', 'http', 'dahua']);
export type LockProviderValue = z.infer<typeof LockProviderEnum>;

export const CreateDeviceSchema = z.object({
  facilityId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  type: AccessDeviceTypeEnum,
  name: z.string().trim().min(1).max(120),
  hardwareId: z.string().trim().min(1).max(120),
  mqttTopic: optionalText(200),
  /** Provider de cerradura de este device; omitido = default global (env). */
  provider: LockProviderEnum.optional(),
  /**
   * Provider HTTP/Dahua: URL del controlador/terminal. HTTP = URL a la que se
   * hace POST firmado (HMAC); Dahua = base del terminal (`http://<ip>`), la
   * apertura va por `accessControl.cgi` con Digest usando `controlSecret`
   * en formato `user:pass`.
   */
  controlUrl: z.string().url().max(500).optional(),
  controlSecret: z.string().trim().min(8).max(200).optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateDeviceInput = z.infer<typeof CreateDeviceSchema>;

export const UpdateDeviceSchema = CreateDeviceSchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateDeviceInput = z.infer<typeof UpdateDeviceSchema>;

// ============================================================================
// Verify
// ============================================================================

export const VerifyAccessSchema = z.object({
  method: AccessMethodEnum,
  /** PIN, QR token o RFID UID. */
  credential: z.string().trim().min(1).max(500),
  /** Hardware ID o UUID del device. */
  deviceId: z.string().trim().min(1).max(120),
});
export type VerifyAccessInput = z.infer<typeof VerifyAccessSchema>;
