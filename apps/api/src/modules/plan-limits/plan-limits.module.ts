import { Global, Module } from '@nestjs/common';

import { PlanLimitsService } from './plan-limits.service';

/**
 * Enforcement de los límites del plan (units/facilities/users) ampliados por
 * add-ons de capacidad. Global + ligero (solo depende de PrismaAdminService)
 * para que units/facilities/invitations lo inyecten sin arrastrar billing-saas.
 */
@Global()
@Module({
  providers: [PlanLimitsService],
  exports: [PlanLimitsService],
})
export class PlanLimitsModule {}
