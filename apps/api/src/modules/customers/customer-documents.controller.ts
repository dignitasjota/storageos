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
  Req,
} from '@nestjs/common';
import {
  type CustomerDocumentDto,
  type CustomerDocumentUploadDto,
  RegisterCustomerDocumentSchema,
  RequestCustomerDocumentUploadSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { CustomerDocumentsService } from './customer-documents.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class RequestCustomerDocumentUploadDto extends createZodDto(RequestCustomerDocumentUploadSchema) {}
class RegisterCustomerDocumentDto extends createZodDto(RegisterCustomerDocumentSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller()
export class CustomerDocumentsController {
  constructor(private readonly docs: CustomerDocumentsService) {}

  @Get('customers/:customerId/documents')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<CustomerDocumentDto[]> {
    return this.docs.list(user.tenantId, customerId);
  }

  @Roles('owner', 'manager', 'staff')
  @Post('customers/:customerId/documents/upload-url')
  @HttpCode(HttpStatus.OK)
  async requestUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() input: RequestCustomerDocumentUploadDto,
  ): Promise<CustomerDocumentUploadDto> {
    return this.docs.requestUploadUrl(user.tenantId, customerId, input);
  }

  @Roles('owner', 'manager', 'staff')
  @Post('customers/:customerId/documents')
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() input: RegisterCustomerDocumentDto,
    @Req() req: Request,
  ): Promise<CustomerDocumentDto> {
    return this.docs.register({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Delete('documents/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.docs.delete({
      tenantId: user.tenantId,
      userId: user.sub,
      documentId: id,
      meta: extractMeta(req),
    });
  }
}
