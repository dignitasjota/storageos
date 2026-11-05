import {
  Body,
  Controller,
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
  type CustomerMessageDto,
  MessageAttachmentUploadSchema,
  type MessageAttachmentUploadDto,
  messageAttachmentsOf,
  SendCustomerMessageSchema,
  type ConversationContextDto,
  UpdateConversationSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerConversationsService } from './customer-conversations.service';
import { CustomerMessagesService } from './customer-messages.service';

class SendCustomerMessageDto extends createZodDto(SendCustomerMessageSchema) {}
class AttachmentUploadDto extends createZodDto(MessageAttachmentUploadSchema) {}
class UpdateConversationDto extends createZodDto(UpdateConversationSchema) {}

/** Chat del staff con un inquilino (lado panel). */
@Controller('customers/:customerId/messages')
@UseGuards(CustomerScopeGuard)
export class CustomerMessagesController {
  constructor(
    private readonly messages: CustomerMessagesService,
    private readonly conversations: CustomerConversationsService,
  ) {}

  @RequirePermission('customers:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Query('before', new ParseUUIDPipe({ optional: true })) before?: string,
  ): Promise<CustomerMessageDto[]> {
    return this.messages.list(user.tenantId, customerId, 'staff', user.sub, before);
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
      messageAttachmentsOf(body),
      body.isInternal ?? false,
    );
  }

  /** Si le llega lo que se escribe, estado de la conversación y datos para las respuestas. */
  @RequirePermission('customers:read')
  @Get('context')
  context(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<ConversationContextDto> {
    return this.conversations.context(user.tenantId, customerId);
  }

  /** Cierra o reabre la conversación y elige quién la lleva. */
  @RequirePermission('customers:write')
  @Patch('conversation')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() body: UpdateConversationDto,
  ): Promise<ConversationContextDto> {
    return this.conversations.update(user.tenantId, customerId, body, user.sub);
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
