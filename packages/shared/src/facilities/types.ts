import type {
  FacilityDocumentKind,
  OpeningException,
  OpeningHours,
  UnitStatusValue,
} from './schemas';

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
  /** Festivos y días con otro horario. */
  openingExceptions: OpeningException[];
  /** Indicaciones para llegar y enlace de Google Maps. */
  directions: string | null;
  mapsUrl: string | null;
  /** Toque de queda de acceso (franja bloqueada, en `timezone`). */
  accessCurfewEnabled: boolean;
  accessCurfewStart: string | null;
  accessCurfewEnd: string | null;
  /** Características del local (24h, climatizado…), del mismo catálogo que la competencia. */
  features: string[];
  contactPhone: string | null;
  contactEmail: string | null;
  /** Imágenes del local (key de objeto + URL pública) para la landing. */
  images: Array<{ key: string; url: string; alt: string | null }>;
  /** Vídeo (YouTube/Vimeo) para la landing pública del local. */
  videoUrl: string | null;
  isActive: boolean;
  /** Local en «próxima apertura» (admite reservas anticipadas). */
  preOpening: boolean;
  /** Fecha de apertura prevista (`YYYY-MM-DD`), o null si aún no está fijada. */
  openingDate: string | null;
  /** Meses desde la firma para abrir antes de que el cliente pueda irse con todo. */
  preOpeningMaxMonths: number;
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
  features: string[];
  images: { key: string; url: string }[];
  /** En mantenimiento: fecha prevista de vuelta al servicio (YYYY-MM-DD). */
  maintenanceUntil: string | null;
  /** En mantenimiento o bloqueado: por qué y desde cuándo. */
  outOfServiceReason: string | null;
  outOfServiceSince: string | null;
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
    /** Se trasladó a otro trastero: el contrato siguió allí. */
    movedAway: boolean;
    priceMonthly: number;
    /** Facturado sin IVA ni fianzas mientras estuvo en este trastero. */
    invoiced: number;
  }[];
  /** Días que lleva libre (null si no está libre). */
  daysVacant: number | null;
  /** Días que ha estado alquilado en los últimos 365. */
  daysRentedLastYear: number;
  /** Días que se miran: 365, o menos si el trastero es más reciente. */
  daysTrackedLastYear: number;
  /** Lo que paga al mes el inquilino actual, sin IVA. */
  currentFee: number | null;
  /** La otra taquilla, si está apilado. */
  stackPartner: { id: string; code: string; status: string } | null;
  /** Facturado en los últimos 12 meses (sin IVA ni fianzas). */
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

/** Trastero reservado de una planta y para quién. */
export interface FloorHoldDto {
  unitId: string;
  label: string;
  name: string | null;
  until: string | null;
  link: string;
}

/** Resumen de cada local para comparar. */
export interface FacilitySummaryDto {
  facilityId: string;
  /** Las mismas cuentas que el Resumen: el inquilino de prueba no ocupa. */
  totalUnits: number;
  occupiedUnits: number;
  /** Cuotas al mes de sus contratos vivos (menos descuentos). Null sin permiso. */
  mrr: number | null;
  /** Cuota media de los ocupados. Null sin permiso o sin contratos. */
  avgPrice: number | null;
  totalM2: number;
  occupiedM2: number;
  /** Facturado este mes (con IVA, sin fianzas). Null sin permiso. */
  invoicedMonth: number | null;
  /** Deuda vencida a hoy. Null sin permiso. */
  overdue: number | null;
  /** Altas y bajas de este mes. */
  moveIns: number;
  moveOuts: number;
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

/** Lo que impide borrar un local: hay que resolverlo antes. */
export interface FacilityDeleteBlockerDto {
  kind: 'live_contracts' | 'draft_contracts' | 'reservations' | 'scheduled_moves' | 'waitlist';
  count: number;
  /** «3 contratos en vigor». */
  label: string;
  /** Pantalla donde resolverlo. */
  href: string;
}

export interface FacilityDeletePreviewDto {
  unitsCount: number;
  blockers: FacilityDeleteBlockerDto[];
  /** Lo que se apaga al borrarlo. */
  turnsOff: {
    maintenancePlans: number;
    recurringExpenses: number;
    accessDevices: number;
    cameraDevices: number;
  };
  /** Personas que solo ven este local: se quedan sin ninguno hasta que les asignes otro. */
  usersLeftWithoutFacilities: string[];
}

/** Lo que pasa en un local, de un vistazo. */
export interface FacilityOverviewDto {
  /** Dirección de su página en la web (con el dominio propio si lo hay). */
  publicUrl: string | null;
  /** Ocupación por tamaño: solo los que tiene el local. */
  byType: {
    unitTypeId: string;
    name: string;
    color: string;
    defaultPriceMonthly: number;
    total: number;
    occupied: number;
    reserved: number;
    available: number;
    outOfService: number;
    avgPrice: number;
  }[];
  /** Null sin permiso para ver el dinero. */
  mrr: number | null;
  overdue: number | null;
  /** Los últimos 30 días. */
  moveIns: number;
  moveOuts: number;
  waitlist: number;
  /** Inquilinos con contrato en vigor y correo (a quienes llega un aviso del local). */
  tenantsReachable: number;
  openIncidents: number;
  expiringDocuments: { id: string; name: string; expiresOn: string; daysToExpiry: number }[];
  offlineDevices: { id: string; name: string }[];
}

/** Días que un local borrado se puede restaurar. */
export const FACILITY_RESTORE_DAYS = 30;

/** Un local en la papelera. */
export interface DeletedFacilityDto {
  id: string;
  name: string;
  city: string | null;
  deletedAt: string;
  /** Días que quedan para poder restaurarlo. */
  daysLeft: number;
  unitsCount: number;
}

export interface FacilityRestoreResultDto {
  facility: FacilityDto;
  /** Lo que se ha vuelto a encender. */
  restored: {
    maintenancePlans: number;
    recurringExpenses: number;
    accessDevices: number;
    cameraDevices: number;
  };
}

/** Quién del equipo ve este local. */
export interface FacilityTeamMemberDto {
  id: string;
  fullName: string;
  email: string;
  role: string;
  /** `assigned`: tiene este local asignado; `all`: ve todos los locales. */
  access: 'assigned' | 'all';
}

export interface FacilityHistoryItemDto {
  id: string;
  action: string;
  userName: string | null;
  occurredAt: string;
  changes: Record<string, unknown> | null;
}

export interface FacilityHistoryDto {
  items: FacilityHistoryItemDto[];
  nextCursor: string | null;
}
