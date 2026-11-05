import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { permissionsForRole } from '@storageos/shared';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerOverviewService } from './customer-overview.service';

import type { CustomerAccountDto, CustomerOverviewDto } from '@storageos/shared';

/**
 * Visión de los inquilinos (lista con cuota, cobro, deuda y extras) y estado de
 * cuenta de cada uno. Se registra antes que `CustomersController` para que
 * `/customers/overview` no lo capture `/customers/:id`.
 */
@Controller('customers')
export class CustomerOverviewController {
  constructor(private readonly service: CustomerOverviewService) {}

  @Get('overview')
  @RequirePermission('customers:read')
  overview(@CurrentUser() user: AuthenticatedUser): Promise<CustomerOverviewDto[]> {
    const permissions = user.permissions ?? permissionsForRole(user.role);
    return this.service.overview(user.tenantId, {
      facilityScope: user.facilityScope ?? null,
      moneyVisible: permissions.includes('invoices:read') && permissions.includes('payments:read'),
    });
  }

  @Get(':id/account')
  @RequirePermission('customers:read', 'invoices:read', 'payments:read')
  @UseGuards(CustomerScopeGuard)
  account(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerAccountDto> {
    return this.service.account(user.tenantId, id, user.facilityScope ?? null);
  }
}
