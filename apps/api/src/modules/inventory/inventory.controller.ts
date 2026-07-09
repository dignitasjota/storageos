import { Controller, Get } from '@nestjs/common';

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
    return this.inventory.findIssues(user.tenantId);
  }
}
