import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { SaasAddonsService } from './saas-addons.service';

import type { TenantBillingStatusDto } from '@storageos/shared';

/**
 * Estado de cuenta del tenant (pagos pendientes). SIN `@RequirePermission`: lo
 * consulta cualquier usuario autenticado del tenant para pintar el banner de
 * «pago pendiente» en el panel (el `JwtAuthGuard` global ya exige sesión).
 */
@Controller('settings/billing-status')
export class BillingStatusController {
  constructor(private readonly addons: SaasAddonsService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser): Promise<TenantBillingStatusDto> {
    return this.addons.billingStatus(user.tenantId);
  }
}
