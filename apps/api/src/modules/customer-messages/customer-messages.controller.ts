import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type CustomerMessageDto, SendCustomerMessageSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerMessagesService } from './customer-messages.service';

class SendCustomerMessageDto extends createZodDto(SendCustomerMessageSchema) {}

/** Chat del staff con un inquilino (lado panel). */
@Controller('customers/:customerId/messages')
export class CustomerMessagesController {
  constructor(private readonly messages: CustomerMessagesService) {}

  @RequirePermission('customers:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<CustomerMessageDto[]> {
    return this.messages.list(user.tenantId, customerId, 'staff');
  }

  @RequirePermission('customers:write')
  @Post()
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() body: SendCustomerMessageDto,
  ): Promise<CustomerMessageDto> {
    return this.messages.sendFromStaff(user.tenantId, customerId, user.sub, body.body);
  }
}
