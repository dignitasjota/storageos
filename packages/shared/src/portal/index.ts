import { z } from 'zod';

import type { ContractStatusValue } from '../customers/schemas';

/** Contrato tal como lo ve el inquilino en su portal. */
export interface PortalContractDto {
  id: string;
  contractNumber: string;
  unitCode: string;
  facilityName: string;
  status: ContractStatusValue;
  startDate: string;
  endDate: string | null;
  priceMonthly: number;
  effectivePrice: number;
  cancellationNoticeDays: number;
  endingRequestedAt: string | null;
}

/** Solicitud de baja (move-out) desde el portal. */
export const RequestMoveOutSchema = z.object({
  /** Fecha de salida deseada (YYYY-MM-DD); debe respetar el preaviso. */
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD'),
});
export type RequestMoveOutInput = z.infer<typeof RequestMoveOutSchema>;
