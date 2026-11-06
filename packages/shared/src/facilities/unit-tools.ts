import { z } from 'zod';

import type { UnitDto } from './types';

/** Características de un trastero concreto, para buscarlo y enseñarlo. */
export const UnitFeatureEnum = z.enum([
  'ground_floor',
  'vehicle_access',
  'climate',
  'power_outlet',
  'lighting',
  'shelves',
  'double_door',
]);
export type UnitFeature = z.infer<typeof UnitFeatureEnum>;

export const UNIT_FEATURE_LABELS: Record<UnitFeature, string> = {
  ground_floor: 'Planta baja',
  vehicle_access: 'Acceso con vehículo',
  climate: 'Climatizado',
  power_outlet: 'Enchufe',
  lighting: 'Luz propia',
  shelves: 'Estanterías',
  double_door: 'Puerta doble',
};

export const UnitPriceRoundEnum = z.enum(['none', 'euro', 'five']);
export type UnitPriceRound = z.infer<typeof UnitPriceRoundEnum>;

export const UNIT_PRICE_ROUND_LABELS: Record<UnitPriceRound, string> = {
  none: 'Sin redondear',
  euro: 'Al euro',
  five: 'A 5 €',
};

/** Precio que deja un cambio en lote: el que lo aplica y la vista previa dan lo mismo. */
export function bulkUnitPrice(
  current: number,
  change: { mode: 'set' | 'percent'; value: number; round?: UnitPriceRound },
): number {
  const raw = change.mode === 'set' ? change.value : current * (1 + change.value / 100);
  if (change.round === 'euro') return Math.round(raw);
  if (change.round === 'five') return Math.round(raw / 5) * 5;
  return Math.round(raw * 100) / 100;
}

/** Lo que se deja de ingresar por tenerlo parado, al precio de catálogo (mes de 30 días). */
export function lostUnitIncome(priceMonthly: number, days: number): number {
  return Math.round(((priceMonthly * days) / 30) * 100) / 100;
}

/** Siguiente código de la serie: «A-09» → «A-10», «B7» → «B8», «Sótano» → «Sótano-2». */
export function nextUnitCode(code: string): string {
  const match = /^(.*?)(\d+)(\D*)$/.exec(code);
  if (!match) return `${code}-2`;
  const [, head = '', digits = '', tail = ''] = match;
  return `${head}${String(Number(digits) + 1).padStart(digits.length, '0')}${tail}`;
}

/** Una fila de la lista de Trasteros: el trastero y lo que pasa con él. */
export interface UnitOverviewRowDto extends UnitDto {
  /** Inquilino actual. Null si no hay o si quien mira no puede ver inquilinos. */
  tenant: {
    customerId: string;
    customerName: string;
    contractId: string;
    contractNumber: string;
    /** Lo que paga al mes, sin IVA. */
    monthly: number;
    /** Lo vencido de ese contrato; null sin permiso para ver dinero. */
    overdue: number | null;
  } | null;
  /** Días que lleva libre (null si no está libre). */
  daysVacant: number | null;
  offer: { code: string; freeMonths: number; validUntil: string } | null;
  /** En mantenimiento o bloqueado. */
  outOfService: { days: number; lostIncome: number } | null;
}

export interface UnitsOverviewDto {
  rows: UnitOverviewRowDto[];
  tenantsVisible: boolean;
  moneyVisible: boolean;
}

export const SaveUnitViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: z.record(z.unknown()),
});
export type SaveUnitViewInput = z.infer<typeof SaveUnitViewSchema>;

export interface UnitSavedViewDto {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  createdByName: string | null;
}
