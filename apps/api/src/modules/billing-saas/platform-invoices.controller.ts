import {
  BadRequestException,
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
  ACCOUNTANT_INVOICE_COLUMNS,
  ACCOUNTANT_PAYMENT_COLUMNS,
  AccountantExportQuerySchema,
  IssuePlatformInvoiceSchema,
  RectifyPlatformInvoiceSchema,
  UpdatePlatformHoldedSettingsSchema,
  type HoldedSeriesListDto,
  type HoldedTestResultDto,
  type PlatformHoldedSettingsDto,
  toAccountantCsv,
  UpdatePlatformBillingSettingsSchema,
  type PlatformBillingSettingsDto,
  type PlatformInvoiceDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { AccountantExportService } from './accountant-export.service';
import { PlatformHoldedService } from './platform-holded.service';
import { PlatformInvoicesService } from './platform-invoices.service';

import type { Response } from 'express';

class UpdateSettingsDto extends createZodDto(UpdatePlatformBillingSettingsSchema) {}
class IssueDto extends createZodDto(IssuePlatformInvoiceSchema) {}
class RectifyDto extends createZodDto(RectifyPlatformInvoiceSchema) {}
class UpdateHoldedDto extends createZodDto(UpdatePlatformHoldedSettingsSchema) {}

/** Facturación del SaaS (TrasterOS → tenant). Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class PlatformInvoicesController {
  constructor(
    private readonly service: PlatformInvoicesService,
    private readonly accountant: AccountantExportService,
    private readonly holded: PlatformHoldedService,
  ) {}

  // ---- copia contable en Holded (desactivada hasta contratarlo) ----

  @Get('platform-billing/holded')
  getHolded(): Promise<PlatformHoldedSettingsDto> {
    return this.holded.getSettings();
  }

  @Put('platform-billing/holded')
  @RequireSuperadmin()
  updateHolded(@Body() body: UpdateHoldedDto): Promise<PlatformHoldedSettingsDto> {
    return this.holded.updateSettings(body);
  }

  @Get('platform-billing/holded/series')
  @RequireSuperadmin()
  holdedSeries(): Promise<HoldedSeriesListDto> {
    return this.holded.listSeries();
  }

  @Post('platform-billing/holded/test')
  @HttpCode(HttpStatus.OK)
  @RequireSuperadmin()
  testHolded(): Promise<HoldedTestResultDto> {
    return this.holded.test();
  }

  @Post('platform-billing/holded/backfill')
  @HttpCode(HttpStatus.OK)
  @RequireSuperadmin()
  backfillHolded(): Promise<{ synced: number }> {
    return this.holded.backfill();
  }

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

  /**
   * Exportación para la asesoría: facturas emitidas y cobros de la SL en un
   * rango, con las suscripciones y el negocio propio juntos. `format=json`
   * (vista previa), `csv` (una tabla por fichero, según `kind`) o `xlsx` (dos hojas).
   */
  @Get('platform-billing/accountant-export')
  @RequireSuperadmin()
  async accountantExport(
    @Res() res: Response,
    @Query() query: Record<string, string>,
  ): Promise<void> {
    const parsed = AccountantExportQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'Indica el periodo (desde y hasta)',
      });
    }
    const { from, to, format, kind } = parsed.data;
    const dto = await this.accountant.build(from, to);
    if (format === 'json') {
      res.json(dto);
      return;
    }
    const name = `asesoria-${from}-a-${to}`;
    if (format === 'xlsx') {
      const buf = await this.accountant.toXlsx(dto);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      res.send(buf);
      return;
    }
    const csv =
      kind === 'payments'
        ? toAccountantCsv(ACCOUNTANT_PAYMENT_COLUMNS, dto.payments)
        : toAccountantCsv(ACCOUNTANT_INVOICE_COLUMNS, dto.invoices);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${name}-${kind === 'payments' ? 'cobros' : 'facturas'}.csv"`,
    );
    res.send(csv);
  }

  @Post('platform-invoices/issue')
  issue(@Body() body: IssueDto): Promise<PlatformInvoiceDto> {
    return this.service.issueForPayment(body.paymentId);
  }

  /** Rectificativa de una factura de suscripción (sustitución o abono). */
  @Post('platform-invoices/:id/rectify')
  @RequireSuperadmin()
  rectify(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RectifyDto,
  ): Promise<PlatformInvoiceDto> {
    return this.service.rectify(id, body);
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
