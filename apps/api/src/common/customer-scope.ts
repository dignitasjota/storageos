import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaService } from '../modules/database/prisma.service';

import type { FacilityScope } from './facility-scope';

/**
 * Inquilinos que ve quien solo tiene unos locales: los que tienen contrato en
 * ellos y los que no tienen contrato vivo en ninguno (contactos, ex-inquilinos).
 */
export function customerScopeWhere(scope: FacilityScope): Prisma.CustomerWhereInput {
  if (!scope) return {};
  return {
    OR: [
      {
        contracts: {
          some: {
            deletedAt: null,
            status: { in: ['draft', 'active', 'ending'] },
            unit: { facilityId: { in: scope } },
          },
        },
      },
      { contracts: { none: { deletedAt: null, status: { in: ['active', 'ending'] } } } },
    ],
  };
}

/**
 * El mismo criterio en SQL, para las consultas a mano. `customerId` es la
 * columna con el inquilino.
 */
export function customerScopeSql(customerId: Prisma.Sql, scope: FacilityScope): Prisma.Sql {
  if (!scope) return Prisma.sql`TRUE`;
  return Prisma.sql`(
    EXISTS (
      SELECT 1 FROM contracts k
      JOIN units u ON u.id = k.unit_id
      WHERE k.customer_id = ${customerId}
        AND k.deleted_at IS NULL
        AND k.status IN ('draft', 'active', 'ending')
        AND u.facility_id = ANY(${scope}::uuid[])
    )
    OR NOT EXISTS (
      SELECT 1 FROM contracts k
      WHERE k.customer_id = ${customerId}
        AND k.deleted_at IS NULL
        AND k.status IN ('active', 'ending')
    )
  )`;
}

/**
 * Locales que dan derecho a ver a un inquilino, para avisar solo a quien puede
 * abrirlo. Vacío = lo ve todo el equipo (sin contrato vivo).
 */
export async function customerVisibilityFacilities(
  db: { contract: Prisma.TransactionClient['contract'] },
  tenantId: string,
  customerId: string,
): Promise<string[]> {
  const contracts = await db.contract.findMany({
    where: {
      tenantId,
      customerId,
      deletedAt: null,
      status: { in: ['draft', 'active', 'ending'] },
    },
    select: { status: true, unit: { select: { facilityId: true } } },
  });
  if (!contracts.some((c) => c.status !== 'draft')) return [];
  return [...new Set(contracts.map((c) => c.unit.facilityId))];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Corta las rutas de un inquilino que el usuario no puede ver por su alcance:
 * para él no existe (404). El parámetro es `:customerId`, o `:id` en las rutas
 * de `/customers/:id`.
 */
@Injectable()
export class CustomerScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      user?: { tenantId: string; facilityScope?: FacilityScope };
      params: Record<string, string | undefined>;
    }>();
    const scope = req.user?.facilityScope;
    const id = req.params.customerId ?? req.params.id;
    if (!scope || !req.user || !id || !UUID.test(id)) return true;
    const visible = await this.prisma.withTenant(
      (tx) => tx.customer.count({ where: { id, ...customerScopeWhere(scope) } }),
      req.user.tenantId,
    );
    if (visible === 0) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    return true;
  }
}
