import type { FacilityDocumentKind, OpeningHours, UnitStatusValue } from './schemas';

export interface FacilityDto {
  id: string;
  name: string;
  /** Slug público para la landing SEO (`/s/<tenant>/<slug>`). */
  publicSlug: string | null;
  ownerId: string | null;
  ownerName: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  /** Horario de apertura semanal (por día, en `timezone`); se muestra en la web pública. */
  openingHours: OpeningHours;
  /** Toque de queda de acceso (franja bloqueada, en `timezone`). */
  accessCurfewEnabled: boolean;
  accessCurfewStart: string | null;
  accessCurfewEnd: string | null;
  /** Características del local (24h, climatizado…), del mismo catálogo que la competencia. */
  features: string[];
  contactPhone: string | null;
  contactEmail: string | null;
  /** Imágenes del local (key de objeto + URL pública) para la landing. */
  images: Array<{ key: string; url: string }>;
  /** Vídeo (YouTube/Vimeo) para la landing pública del local. */
  videoUrl: string | null;
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
  defaultDepositAmount: number;
  color: string;
  features: Record<string, unknown>;
  /** Taquillas apilables de dos en dos (mismo hueco del plano). */
  stackable: boolean;
  /** `storage` (trastero) o `housing` (vivienda, alquiler exento de IVA). */
  propertyKind: 'storage' | 'housing';
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
  /** Par de taquillas apiladas en el mismo hueco: comparten `stackGroupId`,
   * se distinguen por `stackLevel` (0=abajo, 1=arriba). Null = sin apilar. */
  stackGroupId: string | null;
  stackLevel: number | null;
  notes: string | null;
  /** En mantenimiento: fecha prevista de vuelta al servicio (YYYY-MM-DD). */
  maintenanceUntil: string | null;
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

export interface FacilityImageUploadResponseDto {
  uploadUrl: string;
  /** Key del objeto a confirmar con POST /facilities/:id/images. */
  key: string;
  expiresIn: number;
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

export interface FacilityDocumentDto {
  id: string;
  facilityId: string;
  kind: FacilityDocumentKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  expiresOn: string | null;
  /** Días hasta que caduca (negativo = caducado); null sin caducidad. */
  daysToExpiry: number | null;
  notes: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

export interface FacilityDocumentUploadDto {
  uploadUrl: string;
  key: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
}

/** Ficha del trastero: precios, inquilinos y rentabilidad. */
export interface UnitInsightsDto {
  priceHistory: {
    changedAt: string;
    previousPrice: number;
    newPrice: number;
    source: string;
    userName: string | null;
  }[];
  tenancies: {
    contractId: string;
    contractNumber: string;
    customerId: string;
    customerName: string;
    startDate: string;
    endDate: string | null;
    status: string;
    priceMonthly: number;
    /** Facturado (con IVA, sin fianzas) en ese contrato. */
    invoiced: number;
  }[];
  /** Días que lleva libre (null si no está libre). */
  daysVacant: number | null;
  /** Días que ha estado alquilado en los últimos 365. */
  daysRentedLastYear: number;
  /** Facturado en los últimos 12 meses (con IVA, sin fianzas). */
  revenue12m: number;
  /** Facturado en 12 meses por m². */
  revenuePerM2: number | null;
  maintenanceUntil: string | null;
}

/** Quién ocupa cada trastero de una planta (visor del plano). */
export interface FloorOccupantDto {
  unitId: string;
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  /** Deuda vencida del inquilino. */
  overdue: number;
}

/** Resumen de cada local para comparar. */
export interface FacilitySummaryDto {
  facilityId: string;
  /** Cuotas al mes de sus contratos vivos (menos descuentos). */
  mrr: number;
  /** Cuota media de los ocupados. */
  avgPrice: number | null;
  totalM2: number;
  occupiedM2: number;
  /** Facturado este mes (con IVA, sin fianzas). */
  invoicedMonth: number;
  /** El trastero que más lleva libre: días (null si no hay libres). */
  longestVacantDays: number | null;
  /** Trasteros en mantenimiento o bloqueados. */
  outOfService: number;
}

/** Resumen por propietario (plan Administrador). */
export interface OwnerSummaryDto {
  ownerId: string;
  facilities: { id: string; name: string; units: number; occupied: number }[];
  units: number;
  occupied: number;
  mrr: number;
  /** Cobrado el mes pasado de sus contratos. */
  collectedLastMonth: number;
}

export interface OwnersOverviewDto {
  owners: OwnerSummaryDto[];
  /** Locales sin propietario (con el plan Administrador, sus facturas las emite el negocio). */
  facilitiesWithoutOwner: { id: string; name: string }[];
}
