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
  UseGuards,
} from '@nestjs/common';
import {
  type CustomerDocumentDto,
  type CustomerDocumentUploadDto,
  RegisterCustomerDocumentSchema,
  RequestCustomerDocumentUploadSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

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

  @RequirePermission('customers:read')
  @UseGuards(CustomerScopeGuard)
  @Get('customers/:customerId/documents/:id/download')
  download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ url: string }> {
    return this.docs.getDownloadUrl(user.tenantId, customerId, id);
  }

  @RequirePermission('customers:read')
  @UseGuards(CustomerScopeGuard)
  @Get('customers/:customerId/documents')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<CustomerDocumentDto[]> {
    return this.docs.list(user.tenantId, customerId);
  }

  @RequirePermission('customers:write')
  @UseGuards(CustomerScopeGuard)
  @Post('customers/:customerId/documents/upload-url')
  @HttpCode(HttpStatus.OK)
  async requestUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() input: RequestCustomerDocumentUploadDto,
  ): Promise<CustomerDocumentUploadDto> {
    return this.docs.requestUploadUrl(user.tenantId, customerId, input);
  }

  @RequirePermission('customers:write')
  @UseGuards(CustomerScopeGuard)
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

  @RequirePermission('customers:write')
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
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }
}
