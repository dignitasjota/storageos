import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import {
  CreateInvoiceSeriesSchema,
  type InvoiceSeriesDto,
  UpdateInvoiceSeriesSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { InvoiceSeriesService } from './invoice-series.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateInvoiceSeriesDto extends createZodDto(CreateInvoiceSeriesSchema) {}
class UpdateInvoiceSeriesDto extends createZodDto(UpdateInvoiceSeriesSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('invoice-series')
export class InvoiceSeriesController {
  constructor(private readonly series: InvoiceSeriesService) {}

  @RequirePermission('invoices:read')
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<InvoiceSeriesDto[]> {
    return this.series.list(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateInvoiceSeriesDto,
    @Req() req: Request,
  ): Promise<InvoiceSeriesDto> {
    return this.series.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('billing:configure')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateInvoiceSeriesDto,
    @Req() req: Request,
  ): Promise<InvoiceSeriesDto> {
    return this.series.update({
      tenantId: user.tenantId,
      userId: user.sub,
      seriesId: id,
      input,
      meta: extractMeta(req),
    });
  }
}
