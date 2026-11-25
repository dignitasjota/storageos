import { BILLING_STALE_HOURS } from '@storageos/shared';

import type { PrismaAdminService } from '../database/prisma-admin.service';
import type { Prisma } from '@storageos/database';

/**
 * Criterio ÚNICO de «factura con problema en la AEAT» del panel super admin.
 * Lo usan el resumen y «Hoy» (`AdminOpsHealthService`) y las pestañas de
 * Problemas de facturación (`AdminBillingOpsHealthService`): así los conteos, la
 * lista y los avisos coinciden.
 */

/** Pendiente de la AEAT más de esto = algo va mal. */
export const AEAT_PENDING_STALE_HOURS = BILLING_STALE_HOURS;
/** Envíos fallidos seguidos de un emisor a partir de los cuales se considera atascado. */
export const EMITTER_FAILING_THRESHOLD = 3;

export type FailingEmitter = { tenantId: string; ownerId: string | null };

/** Negocios cuyos problemas de Veri*Factu se cuentan: vivos y con Veri*Factu activado. */
export function liveVerifactuTenantWhere(): Prisma.TenantWhereInput {
  return { deletedAt: null, status: { not: 'cancelled' }, verifactuEnabled: true };
}

/** Momento a partir del cual un registro pendiente se da por atascado. */
export function staleBefore(now: Date): Date {
  return new Date(now.getTime() - AEAT_PENDING_STALE_HOURS * 60 * 60 * 1000);
}

/**
 * Emisores con envíos fallando de forma repetida (SOAP fault, sin respuesta…):
 * sus registros pendientes están atascados aunque aún no lleven 48 h.
 */
export async function failingEmitters(admin: PrismaAdminService): Promise<
  (FailingEmitter & {
    consecutiveFailures: number;
    lastError: string | null;
    retryAt: Date | null;
  })[]
> {
  return admin.verifactuEmitter.findMany({
    where: {
      consecutiveFailures: { gte: EMITTER_FAILING_THRESHOLD },
      tenant: liveVerifactuTenantWhere(),
    },
    select: {
      tenantId: true,
      ownerId: true,
      consecutiveFailures: true,
      lastError: true,
      retryAt: true,
    },
  });
}

/** Registros pendientes que nunca han salido: >48 h o de un emisor que falla. */
export function unsentRecordWhere(
  before: Date,
  failing: FailingEmitter[],
): Prisma.VerifactuRecordWhereInput {
  return {
    status: 'pending',
    sentAt: null,
    tenant: liveVerifactuTenantWhere(),
    OR: [
      { createdAt: { lt: before } },
      ...failing.map((f) => ({ tenantId: f.tenantId, ownerId: f.ownerId })),
    ],
  };
}

export type AeatProblemType = 'rejected' | 'error' | 'warnings' | 'stale' | 'unsent';

/** Facturas con UN tipo de problema concreto. */
export function aeatProblemTypeWhere(
  type: AeatProblemType,
  before: Date,
  failing: FailingEmitter[],
): Prisma.InvoiceWhereInput {
  switch (type) {
    case 'rejected':
      return { aeatStatus: 'rejected' };
    case 'error':
      return { aeatStatus: 'error' };
    case 'warnings':
      return { aeatStatus: 'accepted_with_warnings' };
    case 'stale':
      return { aeatStatus: 'pending', aeatSentAt: { lt: before } };
    case 'unsent':
      return {
        aeatStatus: 'pending',
        aeatSentAt: null,
        verifactuRecords: { some: unsentRecordWhere(before, failing) },
      };
  }
}

/** Facturas con algún problema en la AEAT (incluye las que nunca llegaron a enviarse). */
export function aeatProblemWhere(
  before: Date,
  failing: FailingEmitter[],
  types: readonly AeatProblemType[] = ['rejected', 'error', 'warnings', 'stale', 'unsent'],
): Prisma.InvoiceWhereInput {
  return {
    deletedAt: null,
    tenant: liveVerifactuTenantWhere(),
    OR: types.map((t) => aeatProblemTypeWhere(t, before, failing)),
  };
}
