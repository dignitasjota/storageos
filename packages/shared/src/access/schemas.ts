import { z } from 'zod';

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

// ============================================================================
// Enums
// ============================================================================

export const AccessMethodEnum = z.enum(['pin', 'qr', 'rfid']);
export type AccessMethodValue = z.infer<typeof AccessMethodEnum>;

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
    allowedHours: z.record(z.unknown()).default({}),
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
    allowedHours: z.record(z.unknown()).optional(),
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

export const CreateDeviceSchema = z.object({
  facilityId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  type: AccessDeviceTypeEnum,
  name: z.string().trim().min(1).max(120),
  hardwareId: z.string().trim().min(1).max(120),
  mqttTopic: optionalText(200),
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
