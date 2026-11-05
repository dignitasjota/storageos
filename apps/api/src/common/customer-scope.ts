import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../modules/database/prisma.service';

import type { FacilityScope } from './facility-scope';
import type { Prisma } from '@storageos/database';

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
