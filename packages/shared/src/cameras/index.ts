import { z } from 'zod';

/**
 * Cámaras de seguridad y alarma (AirShield vía NVR). La app integra SOLO el log
 * de eventos + snapshots; el vídeo en vivo/grabado va por la app oficial Dahua
 * (DMSS). La ingesta de eventos es agnóstica del origen (push del equipo, agente
 * on-site o puente DSS).
 */

/** Tipo de dispositivo/evento: cámara (vídeo/IA) o alarma (intrusión). */
export const CameraEventKindEnum = z.enum(['camera', 'alarm']);
export type CameraEventKind = z.infer<typeof CameraEventKindEnum>;

// --- Gestión de dispositivos (staff) ---

export const CreateCameraDeviceSchema = z.object({
  facilityId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  channel: z.number().int().min(1).max(256).default(1),
  /** Nº de serie del equipo (para añadirlo también a DMSS). */
  serialNumber: z.string().trim().max(120).optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateCameraDeviceInput = z.infer<typeof CreateCameraDeviceSchema>;

export const UpdateCameraDeviceSchema = CreateCameraDeviceSchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateCameraDeviceInput = z.infer<typeof UpdateCameraDeviceSchema>;

export interface CameraDeviceDto {
  id: string;
  facilityId: string;
  facilityName: string;
  name: string;
  channel: number;
  serialNumber: string | null;
  /** Primeros caracteres del token de ingesta (sin exponerlo entero). */
  ingestTokenPreview: string;
  isActive: boolean;
  lastEventAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Solo al crear/regenerar: incluye el token de ingesta en claro (una vez). */
export interface CameraDeviceWithTokenDto extends CameraDeviceDto {
  revealedIngestToken: string;
  /** URL a la que el equipo/agente debe empujar los eventos. */
  ingestUrl: string;
}

// --- Ingesta de eventos (origen: equipo / agente / puente) ---

/**
 * Payload NORMALIZADO de un evento. El origen (push del equipo, agente on-site,
 * puente DSS) traduce su formato nativo a este. `imageBase64` opcional = snapshot.
 */
export const IngestCameraEventSchema = z.object({
  kind: CameraEventKindEnum.default('camera'),
  eventType: z.string().trim().min(1).max(80),
  occurredAt: z.string().datetime().optional(),
  /** Snapshot del evento en base64 (JPEG/PNG). Opcional. */
  imageBase64: z.string().max(12_000_000).optional(),
  imageMimeType: z.enum(['image/jpeg', 'image/png']).optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type IngestCameraEventInput = z.infer<typeof IngestCameraEventSchema>;

export interface CameraEventDto {
  id: string;
  cameraDeviceId: string;
  cameraName: string;
  facilityId: string;
  kind: CameraEventKind;
  eventType: string;
  /** URL firmada temporal del snapshot (null si el evento no trae imagen). */
  snapshotUrl: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}
