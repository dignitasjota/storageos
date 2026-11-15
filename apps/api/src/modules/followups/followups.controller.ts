import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateCustomerFollowupSchema,
  type CustomerFollowupDto,
  FollowupInboxTabEnum,
  type FollowupDueCountDto,
  type FollowupInboxDto,
  type Permission,
  UpdateCustomerFollowupSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { FollowupsService } from './followups.service';

class CreateFollowupDto extends createZodDto(CreateCustomerFollowupSchema) {}
class UpdateFollowupDto extends createZodDto(UpdateCustomerFollowupSchema) {}

function canSee(permissions: readonly Permission[] | undefined) {
  const has = (p: Permission) => !permissions || permissions.includes(p);
  return { customers: has('customers:read'), leads: has('leads:read') };
}

function forbidden() {
  return new ForbiddenException({
    code: 'insufficient_permission',
    message: 'No tienes permiso para ver los seguimientos',
  });
}

/** Seguimientos/recordatorios del staff sobre inquilinos. */
@Controller()
export class FollowupsController {
  constructor(private readonly followups: FollowupsService) {}

  /**
   * Bandeja única de seguimientos: inquilinos (con `customers:read`) y
   * contactos (con `leads:read`). Antes de `followups/:id`.
   */
  @Get('followups/inbox')
  inbox(
    @CurrentUser() user: AuthenticatedUser,
    @Query('tab') tab?: string,
    @Query('mine') mine?: string,
  ): Promise<FollowupInboxDto> {
    const can = canSee(user.permissions);
    if (!can.customers && !can.leads) throw forbidden();
    return this.followups.inbox(user.tenantId, {
      tab: FollowupInboxTabEnum.catch('today').parse(tab),
      mine: mine === '1' || mine === 'true',
      userId: user.sub,
      scope: user.facilityScope ?? null,
      ...can,
    });
  }

  /** Cuántos tocan hoy o están atrasados (número del menú). */
  @Get('followups/due-count')
  dueCount(@CurrentUser() user: AuthenticatedUser): Promise<FollowupDueCountDto> {
    const can = canSee(user.permissions);
    if (!can.customers && !can.leads) return Promise.resolve({ due: 0 });
    return this.followups.dueCount(user.tenantId, {
      scope: user.facilityScope ?? null,
      ...can,
    });
  }

  /** Bandeja global de pendientes. */
  @RequirePermission('customers:read')
  @Get('followups')
  listPending(@CurrentUser() user: AuthenticatedUser): Promise<CustomerFollowupDto[]> {
    return this.followups.listPending(user.tenantId, user.facilityScope ?? null);
  }

  @RequirePermission('customers:read')
  @UseGuards(CustomerScopeGuard)
  @Get('customers/:customerId/followups')
  listForCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<CustomerFollowupDto[]> {
    return this.followups.listForCustomer(user.tenantId, customerId);
  }

  @RequirePermission('customers:write')
  @UseGuards(CustomerScopeGuard)
  @Post('customers/:customerId/followups')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() input: CreateFollowupDto,
  ): Promise<CustomerFollowupDto> {
    return this.followups.create({ tenantId: user.tenantId, userId: user.sub, customerId, input });
  }

  @RequirePermission('customers:write')
  @Patch('followups/:id')
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateFollowupDto,
  ): Promise<CustomerFollowupDto> {
    return this.followups.setStatus({
      tenantId: user.tenantId,
      id,
      input,
      scope: user.facilityScope ?? null,
      userId: user.sub,
    });
  }

  @RequirePermission('customers:write')
  @Delete('followups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.followups.remove(user.tenantId, id, user.facilityScope ?? null);
  }
}
