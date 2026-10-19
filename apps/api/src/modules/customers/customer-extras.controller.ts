import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerExtrasService } from './customer-extras.service';

import type { CustomerExtrasDto } from '@storageos/shared';

/**
 * Matriz inquilino × extras. Se registra antes que `CustomersController` para
 * que `/customers/extras` no lo capture `/customers/:id`.
 */
@Controller('customers')
export class CustomerExtrasController {
  constructor(private readonly service: CustomerExtrasService) {}

  @Get('extras')
  @RequirePermission('customers:read')
  matrix(@CurrentUser() user: AuthenticatedUser): Promise<CustomerExtrasDto> {
    return this.service.matrix(user.tenantId, user.facilityScope ?? null);
  }
}
