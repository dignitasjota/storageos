import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  type CustomerMessageDto,
  MessageAttachmentUploadSchema,
  type MessageAttachmentUploadDto,
  SendCustomerMessageSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerMessagesService } from './customer-messages.service';

class SendCustomerMessageDto extends createZodDto(SendCustomerMessageSchema) {}
class AttachmentUploadDto extends createZodDto(MessageAttachmentUploadSchema) {}

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
    return this.messages.list(user.tenantId, customerId, 'staff', user.sub);
  }

  @RequirePermission('customers:write')
  @Post()
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() body: SendCustomerMessageDto,
  ): Promise<CustomerMessageDto> {
    return this.messages.sendFromStaff(
      user.tenantId,
      customerId,
      user.sub,
      body.body,
      body.attachment,
    );
  }

  /** URL firmada para adjuntar una imagen o PDF al mensaje. */
  @RequirePermission('customers:write')
  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() body: AttachmentUploadDto,
  ): Promise<MessageAttachmentUploadDto> {
    return this.messages.requestAttachmentUpload(user.tenantId, customerId, body.mimeType);
  }
}
