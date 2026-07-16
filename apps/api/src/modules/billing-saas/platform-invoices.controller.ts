import {
  Query,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  IssuePlatformInvoiceSchema,
  UpdatePlatformBillingSettingsSchema,
  type PlatformBillingSettingsDto,
  type PlatformInvoiceDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { PlatformInvoicesService } from './platform-invoices.service';

import type { Response } from 'express';

class UpdateSettingsDto extends createZodDto(UpdatePlatformBillingSettingsSchema) {}
class IssueDto extends createZodDto(IssuePlatformInvoiceSchema) {}

/** Facturación del SaaS (TrasterOS → tenant). Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class PlatformInvoicesController {
  constructor(private readonly service: PlatformInvoicesService) {}

  @Get('platform-billing/settings')
  getSettings(): Promise<PlatformBillingSettingsDto> {
    return this.service.getSettings();
  }

  @Put('platform-billing/settings')
  updateSettings(@Body() body: UpdateSettingsDto): Promise<PlatformBillingSettingsDto> {
    return this.service.updateSettings(body);
  }

  @Get('tenants/:id/platform-invoices')
  listForTenant(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformInvoiceDto[]> {
    return this.service.listForTenant(id);
  }

  /** Todas las facturas SaaS (para el export contable). Antes de las rutas `:id`. */
  @Get('platform-invoices')
  listAll(@Query('from') from?: string, @Query('to') to?: string): Promise<PlatformInvoiceDto[]> {
    return this.service.listAll(from, to);
  }

  /**
   * Export contable (CSV) de las facturas SaaS de un año, para la asesoría.
   * Dato sensible → solo el rol `superadmin`. Devuelve el CSV directamente
   * (`@Res()`), con BOM UTF-8 y separador `;` para Excel es-ES.
   */
  @Get('platform-billing/export')
  @RequireSuperadmin()
  async exportInvoices(@Res() res: Response, @Query('year') year?: string): Promise<void> {
    const parsed = Number.parseInt(year ?? '', 10);
    const current = new Date().getUTCFullYear();
    const y = Number.isInteger(parsed) && parsed >= 2020 && parsed <= 2100 ? parsed : current;
    const csv = await this.service.exportCsvForYear(y);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="facturas-saas-${y}.csv"`);
    res.send(csv);
  }

  @Post('platform-invoices/issue')
  issue(@Body() body: IssueDto): Promise<PlatformInvoiceDto> {
    return this.service.issueForPayment(body.paymentId);
  }

  @Get('platform-invoices/:id/pdf')
  pdf(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ url: string }> {
    return this.service.getPdfUrl(id);
  }

  @Post('platform-invoices/:id/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resend(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.resend(id);
  }
}
