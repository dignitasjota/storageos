import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { InventoryService } from './inventory.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermission('units:read')
  @Get('issues')
  async issues(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.findIssues(user.tenantId, user.facilityScope ?? null);
  }

  /** Pone el estado que le corresponde a un trastero descuadrado. */
  @RequirePermission('units:write')
  @Post('issues/:unitId/fix')
  @HttpCode(HttpStatus.OK)
  async fix(
    @CurrentUser() user: AuthenticatedUser,
    @Param('unitId', new ParseUUIDPipe()) unitId: string,
  ) {
    return this.inventory.fix({
      tenantId: user.tenantId,
      userId: user.sub,
      unitId,
      facilityScope: user.facilityScope ?? null,
    });
  }
}
