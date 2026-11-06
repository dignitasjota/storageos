import type { UnitOverviewRowDto, UnitStatusValue } from '@storageos/shared';

export interface UnitListFilters {
  status: UnitStatusValue | 'all';
  unitTypeId: string;
  floorId: string;
  feature: string;
  /** Libres desde hace más de estos días (vacío = sin filtro). */
  vacantDays: string;
  debt: boolean;
  offer: boolean;
  stacked: boolean;
  stopped: boolean;
  minArea: string;
  maxArea: string;
  minPrice: string;
  maxPrice: string;
}

export const EMPTY_FILTERS: UnitListFilters = {
  status: 'all',
  unitTypeId: 'all',
  floorId: 'all',
  feature: 'all',
  vacantDays: '',
  debt: false,
  offer: false,
  stacked: false,
  stopped: false,
  minArea: '',
  maxArea: '',
  minPrice: '',
  maxPrice: '',
};

export const FILTER_TOGGLES: {
  key: 'debt' | 'offer' | 'stacked' | 'stopped';
  label: string;
}[] = [
  { key: 'debt', label: 'Con deuda' },
  { key: 'offer', label: 'Con oferta' },
  { key: 'stacked', label: 'Apilados' },
  { key: 'stopped', label: 'Fuera de servicio' },
];

export const PRESET_VIEWS: { name: string; filters: Partial<UnitListFilters> }[] = [
  { name: 'Libres más de 30 días', filters: { vacantDays: '30' } },
  { name: 'Libres más de 90 días', filters: { vacantDays: '90' } },
  { name: 'Alquilados con deuda', filters: { debt: true } },
  { name: 'Fuera de servicio', filters: { stopped: true } },
  { name: 'Con oferta', filters: { offer: true } },
];

const num = (v: string) => {
  const n = Number(v.replace(',', '.'));
  return v.trim() && Number.isFinite(n) ? n : null;
};

/** Filtros salvo el estado: las tiras de arriba cuentan lo que dejan los demás. */
export function matchesUnit(u: UnitOverviewRowDto, f: UnitListFilters): boolean {
  if (f.unitTypeId !== 'all' && u.unitTypeId !== f.unitTypeId) return false;
  if (f.floorId !== 'all' && u.floorId !== f.floorId) return false;
  if (f.feature !== 'all' && !u.features.includes(f.feature)) return false;
  if (f.debt && !(u.tenant?.overdue && u.tenant.overdue > 0)) return false;
  if (f.offer && !u.offer) return false;
  if (f.stacked && !u.stackGroupId) return false;
  if (f.stopped && !u.outOfService) return false;
  const vacant = num(f.vacantDays);
  if (vacant !== null && (u.daysVacant === null || u.daysVacant < vacant)) return false;
  const minArea = num(f.minArea);
  const maxArea = num(f.maxArea);
  if (minArea !== null && u.areaM2 < minArea) return false;
  if (maxArea !== null && u.areaM2 > maxArea) return false;
  const minPrice = num(f.minPrice);
  const maxPrice = num(f.maxPrice);
  if (minPrice !== null && u.basePriceMonthly < minPrice) return false;
  if (maxPrice !== null && u.basePriceMonthly > maxPrice) return false;
  return true;
}
