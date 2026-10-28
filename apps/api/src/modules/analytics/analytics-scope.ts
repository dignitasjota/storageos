import { BadRequestException } from '@nestjs/common';

import { isFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';

import type { Prisma } from '@storageos/database';

/**
 * Locales que cubre una consulta de analítica: el elegido en la página (si el
 * usuario lo puede ver) o, sin elegir, los de su alcance. `ids` undefined =
 * toda la empresa; `explicit` = se eligió un local concreto.
 */
export interface AnalyticsScope {
  ids: string[] | undefined;
  explicit: boolean;
}

export const ALL_FACILITIES: AnalyticsScope = { ids: undefined, explicit: false };

export function resolveAnalyticsScope(
  userScope: FacilityScope,
  requestedFacilityId?: string,
): AnalyticsScope {
  const requested = requestedFacilityId?.trim();
  if (requested) {
    // Un local fuera del alcance no da error: simplemente no hay datos.
    return { ids: isFacilityAllowed(userScope, requested) ? [requested] : [], explicit: true };
  }
  return { ids: userScope ?? undefined, explicit: false };
}

/** Clave estable para cachés por alcance. */
export function scopeKey(scope: AnalyticsScope): string {
  return scope.ids ? [...scope.ids].sort().join(',') : '*';
}

/** Trasteros del alcance (los de un local borrado no cuentan). */
export function unitWhere(scope: AnalyticsScope): Prisma.UnitWhereInput {
  return {
    facility: { deletedAt: null },
    ...(scope.ids ? { facilityId: { in: scope.ids } } : {}),
  };
}

export function contractWhere(scope: AnalyticsScope): Prisma.ContractWhereInput {
  return scope.ids ? { unit: { facilityId: { in: scope.ids } } } : {};
}

/**
 * Factura de un local: por el trastero del contrato, su propio local (pase
 * nocturno) o el de su venta. Con alcance y sin local elegido entran también
 * las que no son de ningún local (F2 sueltas).
 */
export function invoiceWhere(scope: AnalyticsScope): Prisma.InvoiceWhereInput {
  if (!scope.ids) return {};
  const inScope: Prisma.InvoiceWhereInput[] = [
    { contract: { unit: { facilityId: { in: scope.ids } } } },
    { facilityId: { in: scope.ids } },
    { productSale: { facilityId: { in: scope.ids } } },
  ];
  if (!scope.explicit) inScope.push({ contractId: null, facilityId: null, productSale: null });
  return { OR: inScope };
}

/** Contactos de un local; sin local elegido, también los que no indicaron ninguno. */
export function leadWhere(scope: AnalyticsScope): Prisma.LeadWhereInput {
  if (!scope.ids) return {};
  if (scope.explicit) return { preferredFacilityId: { in: scope.ids } };
  return { OR: [{ preferredFacilityId: { in: scope.ids } }, { preferredFacilityId: null }] };
}

export function invalidDate(field: string, value: string): BadRequestException {
  return new BadRequestException({
    code: 'invalid_date',
    message: `Fecha no válida en «${field}»: ${value}`,
  });
}

// ---------------------------------------------------------------------------
// Ciclo de vida de un contrato para las métricas (bajas, estancia, previsión)
// ---------------------------------------------------------------------------

export interface LifecycleContract {
  status: string;
  startDate: Date;
  signedAt: Date | null;
  endedAt: Date | null;
  cancelledAt: Date | null;
  firstPaymentDeadline: Date | null;
}

/** Campos que hay que pedir para `contractLifecycle`. */
export const LIFECYCLE_SELECT = {
  status: true,
  startDate: true,
  signedAt: true,
  endedAt: true,
  cancelledAt: true,
  firstPaymentDeadline: true,
} as const;

/**
 * Cuándo empieza y acaba un contrato a efectos de las métricas, o null si no
 * cuenta: sin firmar (borradores y reservas online no firmadas) o una reserva
 * firmada que se canceló sin pagar (sigue con su plazo de pago). Empieza al
 * firmarse o en su fecha de inicio, lo que sea más tarde; acaba al terminar o
 * al cancelarse (una cancelación de un contrato en marcha es una baja).
 */
export function contractLifecycle(c: LifecycleContract): { begin: Date; end: Date | null } | null {
  if (!c.signedAt) return null;
  if (c.status === 'cancelled' && c.firstPaymentDeadline) return null;
  const begin = c.signedAt > c.startDate ? c.signedAt : c.startDate;
  let end: Date | null = null;
  if (c.status === 'ended') end = c.endedAt ?? c.cancelledAt;
  else if (c.status === 'cancelled') end = c.cancelledAt ?? c.endedAt;
  if (end && end < begin) end = begin;
  return { begin, end };
}

/**
 * Cuota mensual de la cartera viva (contratos activos o con baja pedida, menos
 * su descuento). Es el MRR que se usa en todas las pantallas.
 */
export async function liveMrr(
  tx: Prisma.TransactionClient,
  scope: AnalyticsScope,
): Promise<{ mrr: number; contracts: number }> {
  const rows = await tx.contract.findMany({
    where: {
      status: { in: ['active', 'ending'] },
      ...STARTED_CONTRACT_WHERE,
      deletedAt: null,
      ...contractWhere(scope),
    },
    select: { priceMonthly: true, discountAmount: true },
  });
  const mrr = rows.reduce(
    (sum, c) => sum + Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)),
    0,
  );
  return { mrr: Math.round(mrr * 100) / 100, contracts: rows.length };
}
