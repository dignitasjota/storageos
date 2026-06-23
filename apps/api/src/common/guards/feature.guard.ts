import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { featuresForPlan } from '@storageos/shared';

import { PrismaAdminService } from '../../modules/database/prisma-admin.service';
import { FEATURE_KEY } from '../decorators/require-feature.decorator';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { TenantFeature } from '@storageos/shared';

/**
 * Guard de gating por plan. Se evalúa DESPUÉS del `PermissionsGuard`. Si el
 * handler declara `@RequireFeature(...)`, comprueba que el plan del tenant la
 * incluye (`featuresForPlan(plan.slug)`); si no, 403 `feature_not_in_plan`.
 *
 * Sin `@RequireFeature` (o sin `request.user`, p. ej. rutas públicas) deja pasar.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly admin: PrismaAdminService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<TenantFeature | undefined>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const tenantId = request.user?.tenantId;
    if (!tenantId) return true; // rutas públicas (device key, portal) no se gatean por plan

    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { slug: true } } },
    });
    const features = featuresForPlan(subscription?.plan.slug ?? '');
    if (!features.includes(required)) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'Esta función no está incluida en tu plan',
        details: { requiredFeature: required },
      });
    }
    return true;
  }
}
