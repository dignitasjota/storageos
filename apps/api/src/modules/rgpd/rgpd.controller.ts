import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AnonymizePreviewDto,
  CreateDataSubjectRequestSchema,
  type DataSubjectRequestDto,
  UpdateDataSubjectRequestSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { RgpdService } from './rgpd.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateDataSubjectRequestDto extends createZodDto(CreateDataSubjectRequestSchema) {}
class UpdateDataSubjectRequestDto extends createZodDto(UpdateDataSubjectRequestSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('rgpd')
export class RgpdController {
  constructor(private readonly rgpd: RgpdService) {}

  @RequirePermission('rgpd:manage')
  @Get('requests')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<DataSubjectRequestDto[]> {
    return this.rgpd.list(user.tenantId);
  }

  @RequirePermission('rgpd:manage')
  @Post('requests')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateDataSubjectRequestDto,
    @Req() req: Request,
  ): Promise<DataSubjectRequestDto> {
    return this.rgpd.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('rgpd:manage')
  @Patch('requests/:id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateDataSubjectRequestDto,
    @Req() req: Request,
  ): Promise<DataSubjectRequestDto> {
    return this.rgpd.updateRequest({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('rgpd:manage')
  @UseGuards(CustomerScopeGuard)
  @Get('customers/:id/export')
  async exportCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    return this.rgpd.exportCustomerData(user.tenantId, id, {
      userId: user.sub,
      meta: extractMeta(req),
    });
  }

  /** Qué se borra y qué se conserva al anonimizarlo, y qué lo impide. */
  @RequirePermission('rgpd:manage')
  @UseGuards(CustomerScopeGuard)
  @Get('customers/:id/anonymize-preview')
  async anonymizePreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AnonymizePreviewDto> {
    return this.rgpd.anonymizePreview(user.tenantId, id);
  }

  @RequirePermission('rgpd:manage')
  @UseGuards(CustomerScopeGuard)
  @Post('customers/:id/anonymize')
  @HttpCode(HttpStatus.NO_CONTENT)
  async anonymize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('requestId') requestId: string | undefined,
    @Query('confirmDebt') confirmDebt: string | undefined,
    @Req() req: Request,
  ): Promise<void> {
    await this.rgpd.anonymizeCustomer({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId: id,
      ...(requestId ? { requestId } : {}),
      confirmDebt: confirmDebt === '1' || confirmDebt === 'true',
      meta: extractMeta(req),
    });
  }
}
