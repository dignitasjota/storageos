import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PortalService } from './portal.service';

import type { PortalMagicLinkDto } from '@storageos/shared';

/**
 * Generación de magic links de acceso al portal POR EL STAFF (autenticado), para
 * repartir a mano a inquilinos que no saben pedirlo. Distinto del flujo público
 * `/portal/login/*` (que envía el enlace por email).
 */
@Controller('customers/:customerId/portal-link')
export class PortalLinkController {
  constructor(private readonly portal: PortalService) {}

  @RequirePermission('customers:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<PortalMagicLinkDto> {
    return this.portal.createMagicLinkForCustomer(user.tenantId, customerId);
  }
}
