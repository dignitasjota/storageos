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

/**
 * Alta pública en la lista de espera (visitante de la web, sin sesión). No lleva
 * `customerId`: es captación self-service. `website` es un honeypot anti-bot.
 */
export const PublicJoinWaitlistSchema = z.object({
  facilityId: z.string().uuid(),
  unitTypeId: z.string().uuid(),
  contactName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email(),
  contactPhone: z.string().trim().max(40).optional(),
  /** Honeypot: debe llegar vacío; si trae valor, es un bot → se descarta. */
  website: z.string().optional(),
});
export type PublicJoinWaitlistInput = z.infer<typeof PublicJoinWaitlistSchema>;

export interface PublicWaitlistOptionsUnitTypeDto {
  id: string;
  name: string;
  priceMonthly: number;
  /** Nº de trasteros disponibles ahora (0 = agotado → tiene sentido la cola). */
  available: number;
}

/** Catálogo público para el alta en la cola: locales + todos sus tipos activos. */
export interface PublicWaitlistOptionsDto {
  tenantName: string;
  facilities: {
    id: string;
    name: string;
    unitTypes: PublicWaitlistOptionsUnitTypeDto[];
  }[];
}

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
