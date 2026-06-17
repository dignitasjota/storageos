import type { ReportFormatValue, ReportGeneratorCode, ReportStatusValue } from './schemas';

export interface ReportRunDto {
  id: string;
  generatorCode: ReportGeneratorCode | string;
  format: ReportFormatValue;
  status: ReportStatusValue;
  params: Record<string, unknown>;
  downloadUrl: string | null;
  fileBytes: number | null;
  errorMessage: string | null;
  triggeredByUserId: string | null;
  triggeredByName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ReportGeneratorCatalogEntry {
  code: ReportGeneratorCode | string;
  name: string;
  description: string;
  formats: ReportFormatValue[];
  paramsSchema: Record<string, ReportParamSchema>;
}

export interface ReportParamSchema {
  label: string;
  type: 'date' | 'period' | 'select' | 'text' | 'number';
  required: boolean;
  options?: { value: string; label: string }[];
}

// ============================================================================
// Analytics DTOs
// ============================================================================

export interface OccupancyKpiDto {
  totalUnits: number;
  occupiedUnits: number;
  reservedUnits: number;
  availableUnits: number;
  /** % units alquilados / total. */
  physicalOccupancy: number;
  /** MRR real (sum priceMonthly contratos active) / MRR potencial (sum default × total). */
  economicOccupancy: number;
  mrrActual: number;
  mrrPotential: number;
  perFacility: { facilityId: string; facilityName: string; total: number; occupied: number }[];
}

export interface ChurnKpiDto {
  /** Periodo agregado. */
  months: { yearMonth: string; activeAtStart: number; ended: number; churnRate: number }[];
}

export interface AgingKpiDto {
  /** Total pendiente en cada tramo en EUR. */
  buckets: { range: '0-30' | '30-60' | '60-90' | '+90'; amount: number; invoiceCount: number }[];
  totalOutstanding: number;
}

export interface LeadsFunnelKpiDto {
  totals: { new: number; contacted: number; qualified: number; won: number; lost: number };
  conversion: {
    newToContacted: number;
    contactedToQualified: number;
    qualifiedToWon: number;
  };
  bySource: { source: string; count: number }[];
}

export interface CustomerStatsKpiDto {
  /** Inquilinos activos (no anonimizados ni soft-deleted). */
  total: number;
  /** Inquilinos con al menos un contrato activo (generan ingresos). */
  withActiveContract: number;
  /** Altas desde el día 1 del mes actual. */
  newThisMonth: number;
}
