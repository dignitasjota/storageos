import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateCustomerFollowupSchema,
  type CustomerFollowupDto,
  UpdateCustomerFollowupSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { FollowupsService } from './followups.service';

class CreateFollowupDto extends createZodDto(CreateCustomerFollowupSchema) {}
class UpdateFollowupDto extends createZodDto(UpdateCustomerFollowupSchema) {}

/** Seguimientos/recordatorios del staff sobre inquilinos. */
@Controller()
export class FollowupsController {
  constructor(private readonly followups: FollowupsService) {}

  /** Bandeja global de pendientes. */
  @RequirePermission('customers:read')
  @Get('followups')
  listPending(@CurrentUser() user: AuthenticatedUser): Promise<CustomerFollowupDto[]> {
    return this.followups.listPending(user.tenantId);
  }

  @RequirePermission('customers:read')
  @Get('customers/:customerId/followups')
  listForCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<CustomerFollowupDto[]> {
    return this.followups.listForCustomer(user.tenantId, customerId);
  }

  @RequirePermission('customers:write')
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
    return this.followups.setStatus({ tenantId: user.tenantId, id, input });
  }

  @RequirePermission('customers:write')
  @Delete('followups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.followups.remove(user.tenantId, id);
  }
}
