import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CreateCustomerInteractionSchema, type CustomerInteractionDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerInteractionsService } from './customer-interactions.service';

class CreateInteractionDto extends createZodDto(CreateCustomerInteractionSchema) {}

@Controller('customers/:customerId/interactions')
export class CustomerInteractionsController {
  constructor(private readonly interactions: CustomerInteractionsService) {}

  @RequirePermission('customers:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<CustomerInteractionDto[]> {
    return this.interactions.list(user.tenantId, customerId);
  }

  @RequirePermission('customers:write')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() body: CreateInteractionDto,
  ): Promise<CustomerInteractionDto> {
    return this.interactions.create({
      tenantId: user.tenantId,
      customerId,
      userId: user.sub,
      input: body,
    });
  }

  @RequirePermission('customers:write')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.interactions.remove(user.tenantId, customerId, id);
  }
}
