import { z } from 'zod';

export type WaitlistStatus = 'waiting' | 'notified' | 'converted' | 'cancelled';

/** Alta en la lista de espera de un tipo de trastero de un local. */
export const CreateWaitlistEntrySchema = z.object({
  facilityId: z.string().uuid(),
  unitTypeId: z.string().uuid(),
  /** Cliente existente (opcional); si no, basta el contacto libre. */
  customerId: z.string().uuid().optional(),
  contactName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email(),
  contactPhone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type CreateWaitlistEntryInput = z.infer<typeof CreateWaitlistEntrySchema>;

/** Cambio de estado manual de una entrada (marcar convertida o cancelada). */
export const UpdateWaitlistEntrySchema = z.object({
  status: z.enum(['converted', 'cancelled']),
});
export type UpdateWaitlistEntryInput = z.infer<typeof UpdateWaitlistEntrySchema>;

export interface WaitlistEntryDto {
  id: string;
  facilityId: string;
  facilityName: string;
  unitTypeId: string;
  unitTypeName: string;
  customerId: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  status: WaitlistStatus;
  notifiedAt: string | null;
  notes: string | null;
  createdAt: string;
}
