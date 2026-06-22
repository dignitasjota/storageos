import { z } from 'zod';

/** Solicitud de cambio/upgrade de trastero desde el portal del inquilino. */
export const PortalUnitChangeRequestSchema = z.object({
  /** Contrato/trastero actual sobre el que pide el cambio (opcional). */
  contractId: z.string().uuid().optional(),
  note: z.string().trim().min(5).max(1000),
});
export type PortalUnitChangeRequestInput = z.infer<typeof PortalUnitChangeRequestSchema>;

/** Resolución de la solicitud por parte del staff. */
export const ResolveUnitChangeRequestSchema = z.object({
  status: z.enum(['handled', 'rejected']),
  resolutionNote: z.string().trim().max(1000).optional(),
});
export type ResolveUnitChangeRequestInput = z.infer<typeof ResolveUnitChangeRequestSchema>;

export type UnitChangeRequestStatus = 'pending' | 'handled' | 'rejected';

/** Vista del inquilino (portal). */
export interface PortalUnitChangeRequestDto {
  id: string;
  contractNumber: string | null;
  note: string;
  status: UnitChangeRequestStatus;
  createdAt: string;
}

/** Vista del staff. */
export interface UnitChangeRequestDto {
  id: string;
  customerId: string;
  customerName: string;
  contractId: string | null;
  contractNumber: string | null;
  unitCode: string | null;
  note: string;
  status: UnitChangeRequestStatus;
  resolutionNote: string | null;
  createdAt: string;
  handledAt: string | null;
}
