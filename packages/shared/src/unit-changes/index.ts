import { z } from 'zod';

/** Solicitud de cambio/upgrade de trastero desde el portal del inquilino. */
export const PortalUnitChangeRequestSchema = z
  .object({
    /** Contrato/trastero actual sobre el que pide el cambio (opcional). */
    contractId: z.string().uuid().optional(),
    /** Trastero libre del mismo local al que quiere cambiarse (autoservicio). */
    targetUnitId: z.string().uuid().optional(),
    /** Desde cuándo quiere el cambio (YYYY-MM-DD). */
    desiredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    note: z.string().trim().max(1000).default(''),
  })
  .refine((v) => !!v.targetUnitId || v.note.length >= 5, {
    message: 'Elige un trastero o cuéntanos qué necesitas',
    path: ['note'],
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
  /** Trastero que eligió (autoservicio). */
  targetUnitCode: string | null;
  desiredDate: string | null;
  note: string;
  status: UnitChangeRequestStatus;
  /** Motivo/nota del staff al resolver (aprobar o rechazar). */
  resolutionNote: string | null;
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
  /** Trastero que eligió el inquilino y desde cuándo (autoservicio). */
  targetUnitId: string | null;
  targetUnitCode: string | null;
  /** Precio del trastero elegido (sin IVA) frente al actual. */
  targetUnitPrice: number | null;
  currentPrice: number | null;
  desiredDate: string | null;
  note: string;
  status: UnitChangeRequestStatus;
  resolutionNote: string | null;
  createdAt: string;
  handledAt: string | null;
}
