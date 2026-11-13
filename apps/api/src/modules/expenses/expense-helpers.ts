import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CUSTOM_EXPENSE_CATEGORY_PREFIX,
  expenseAmounts,
  isBuiltinExpenseCategory,
  type ExpenseSource,
} from '@storageos/shared';

import { assertFacilityAllowed, type FacilityScope } from '../../common/facility-scope';

import type { Prisma } from '@storageos/database';

export const num = (d: Prisma.Decimal | number | null | undefined): number => Number(d ?? 0);
export const numOrNull = (d: Prisma.Decimal | number | null | undefined): number | null =>
  d === null || d === undefined ? null : Number(d);
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Nota de los gastos generados por una plantilla antes de enlazarlos con ella. */
export const AUTO_RECURRING_NOTE = 'Generado automáticamente (gasto recurrente)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un día `YYYY-MM-DD` que existe; si no, 400 (antes, un 500). */
export function assertDay(value: string | undefined | null, label: string): void {
  if (value === undefined || value === null) return;
  const ok =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) {
    throw new BadRequestException({
      code: 'invalid_date',
      message: `La fecha «${label}» no es válida (AAAA-MM-DD)`,
    });
  }
}

export function assertUuidParam(value: string | undefined, code: string, label: string): void {
  if (value !== undefined && !UUID_RE.test(value)) {
    throw new BadRequestException({ code, message: `${label} no válido` });
  }
}

export const dayDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
export const dayString = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

export function sourceOf(r: {
  externalRef: string | null;
  recurringExpenseId: string | null;
  notes: string | null;
}): ExpenseSource {
  if (r.externalRef?.startsWith('google_ads:')) return 'google_ads';
  if (r.externalRef?.startsWith('meta_ads:')) return 'meta_ads';
  if (r.recurringExpenseId || r.notes === AUTO_RECURRING_NOTE) return 'recurring';
  return 'manual';
}

/**
 * Quien solo ve unos locales gestiona los gastos de esos locales; los de toda
 * la empresa (sin local) los gestiona quien ve todos.
 */
export function assertTargetAllowed(scope: FacilityScope, facilityId: string | null): void {
  if (facilityId) {
    assertFacilityAllowed(scope, facilityId);
    return;
  }
  if (scope) {
    throw new ForbiddenException({
      code: 'facility_required',
      message:
        'Elige uno de tus locales: los gastos de toda la empresa los gestiona quien ve todos los locales',
    });
  }
}

/** Categoría de las de siempre o propia de la empresa (`custom:<id>`). */
export async function assertCategory(tx: Prisma.TransactionClient, key: string): Promise<void> {
  if (isBuiltinExpenseCategory(key)) return;
  if (key.startsWith(CUSTOM_EXPENSE_CATEGORY_PREFIX)) {
    const id = key.slice(CUSTOM_EXPENSE_CATEGORY_PREFIX.length);
    if (UUID_RE.test(id)) {
      const found = await tx.expenseCategory.findFirst({ where: { id }, select: { id: true } });
      if (found) return;
    }
  }
  throw new BadRequestException({ code: 'invalid_category', message: 'Categoría no válida' });
}

/** Nombres de las categorías propias de la empresa. */
export function customCategories(
  tx: Prisma.TransactionClient,
): Promise<{ id: string; name: string }[]> {
  return tx.expenseCategory.findMany({ select: { id: true, name: true } });
}

/** NIF sin espacios ni guiones, en mayúsculas. */
export function normalizeTaxId(value: string | null | undefined): string | null {
  const v = (value ?? '').replace(/[\s.-]/g, '').toUpperCase();
  return v || null;
}

export interface BreakdownInput {
  amount?: number | null | undefined;
  baseAmount?: number | null | undefined;
  vatRate?: number | null | undefined;
  vatDeductible?: boolean | null | undefined;
  withholdingRate?: number | null | undefined;
  withholdingModel?: string | null | undefined;
}

/**
 * Columnas del importe a partir del desglose (o del importe sin desglosar).
 * Una retención exige saber en qué modelo se declara.
 */
export function breakdownColumns(input: BreakdownInput): {
  amount: number;
  baseAmount: number | null;
  vatRate: number | null;
  vatAmount: number | null;
  vatDeductible: boolean;
  withholdingRate: number | null;
  withholdingAmount: number | null;
  withholdingModel: string | null;
  totalAmount: number | null;
} {
  const a = expenseAmounts(input);
  if (!a.broken) {
    if (!(a.amount > 0)) {
      throw new BadRequestException({
        code: 'amount_required',
        message: 'Indica el importe o la base',
      });
    }
    return {
      amount: a.amount,
      baseAmount: null,
      vatRate: null,
      vatAmount: null,
      vatDeductible: true,
      withholdingRate: null,
      withholdingAmount: null,
      withholdingModel: null,
      totalAmount: null,
    };
  }
  const withholdingRate = input.withholdingRate ?? 0;
  if (withholdingRate > 0 && !input.withholdingModel) {
    throw new BadRequestException({
      code: 'withholding_model_required',
      message: 'Indica si la retención va al modelo 111 (profesionales) o al 115 (alquiler)',
    });
  }
  if (!(a.amount > 0)) {
    throw new BadRequestException({
      code: 'amount_required',
      message: 'La base debe ser mayor que 0',
    });
  }
  return {
    amount: a.amount,
    baseAmount: a.baseAmount,
    vatRate: input.vatRate ?? 0,
    vatAmount: a.vatAmount,
    vatDeductible: input.vatDeductible !== false,
    withholdingRate: withholdingRate > 0 ? withholdingRate : null,
    withholdingAmount: withholdingRate > 0 ? a.withholdingAmount : null,
    withholdingModel: withholdingRate > 0 ? (input.withholdingModel ?? null) : null,
    totalAmount: a.totalAmount,
  };
}
