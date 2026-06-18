import type { UnitStatusValue } from './schemas';

export interface FacilityDto {
  id: string;
  name: string;
  /** Slug público para la landing SEO (`/s/<tenant>/<slug>`). */
  publicSlug: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  openingHours: Record<string, unknown>;
  contactPhone: string | null;
  contactEmail: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Resumen rapido para listados. */
  unitsTotal: number;
  unitsOccupied: number;
}

export interface FacilityFloorDto {
  id: string;
  facilityId: string;
  name: string;
  floorNumber: number;
  planImageUrl: string | null;
  planWidthPx: number | null;
  planHeightPx: number | null;
  isDefault: boolean;
  createdAt: string;
}

export interface UnitTypeDto {
  id: string;
  name: string;
  description: string | null;
  defaultPriceMonthly: number;
  color: string;
  features: Record<string, unknown>;
  isActive: boolean;
  unitsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UnitDto {
  id: string;
  facilityId: string;
  facilityName: string;
  floorId: string;
  floorName: string;
  unitTypeId: string;
  unitTypeName: string;
  unitTypeColor: string;
  code: string;
  widthM: number;
  depthM: number;
  heightM: number;
  areaM2: number;
  volumeM3: number;
  status: UnitStatusValue;
  basePriceMonthly: number;
  planX: number | null;
  planY: number | null;
  planWidth: number | null;
  planHeight: number | null;
  planShape: Record<string, unknown> | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UnitStatusHistoryDto {
  id: string;
  previousStatus: UnitStatusValue;
  newStatus: UnitStatusValue;
  changedByUserId: string | null;
  changedByName: string | null;
  reason: string | null;
  occurredAt: string;
}

export interface PlanUploadResponseDto {
  uploadUrl: string;
  publicUrl: string;
  /** Seg de validez del uploadUrl. */
  expiresIn: number;
  /** Headers que el cliente debe incluir en el PUT. */
  requiredHeaders: Record<string, string>;
}

export interface OccupancyDashboardDto {
  totalUnits: number;
  byStatus: Record<UnitStatusValue, number>;
  byFacility: Array<{
    facilityId: string;
    facilityName: string;
    totalUnits: number;
    occupiedUnits: number;
    occupancyPct: number;
  }>;
  byUnitType: Array<{
    unitTypeId: string;
    unitTypeName: string;
    color: string;
    totalUnits: number;
    occupiedUnits: number;
    occupancyPct: number;
  }>;
}
