import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CorrectPaymentSchema,
  MonthCloseGenerateSchema,
  MonthSchema,
  SaveInvoiceViewSchema,
  SendInvoiceEmailSchema,
  UndoPaymentSchema,
  type InvoiceActivityDto,
  type InvoiceCancelPreviewDto,
  type InvoiceDto,
  type InvoiceRefundOptionsDto,
  type InvoiceSavedViewDto,
  type InvoiceTotalsDto,
  type MonthCloseDto,
  type MonthCloseGenerateResultDto,
  type SendInvoiceEmailResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { type InvoiceListQuery, parseInvoiceListQuery } from './invoice-list-query';
import { InvoiceToolsService } from './invoice-tools.service';
import { InvoicesService } from './invoices.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class UndoPaymentDto extends createZodDto(UndoPaymentSchema) {}
class CorrectPaymentDto extends createZodDto(CorrectPaymentSchema) {}
class SendInvoiceEmailDto extends createZodDto(SendInvoiceEmailSchema) {}
class SaveInvoiceViewDto extends createZodDto(SaveInvoiceViewSchema) {}
class MonthCloseGenerateDto extends createZodDto(MonthCloseGenerateSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Herramientas de facturas: totales, vistas guardadas, cierre del mes y, por
 * factura, actividad, cobros, duplicar, anular con vista previa, devoluciones
 * y envío por correo. Se registra antes que `InvoicesController` para que
 * `invoices/totals` no se tome por un `:id`.
 */
@ApiTags('Billing')
@ApiBearerAuth('jwt')
@Controller('invoices')
export class InvoiceToolsController {
  constructor(
    private readonly tools: InvoiceToolsService,
    private readonly invoices: InvoicesService,
  ) {}

  @RequirePermission('invoices:read')
  @Get('totals')
  totals(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: InvoiceListQuery,
  ): Promise<InvoiceTotalsDto> {
    return this.invoices.totals(user.tenantId, {
      ...parseInvoiceListQuery(query),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('invoices:read')
  @Get('views')
  views(@CurrentUser() user: AuthenticatedUser): Promise<InvoiceSavedViewDto[]> {
    return this.tools.listViews(user.tenantId);
  }

  @RequirePermission('invoices:read')
  @Post('views')
  saveView(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SaveInvoiceViewDto,
  ): Promise<InvoiceSavedViewDto> {
    return this.tools.saveView(user.tenantId, user.sub, body);
  }

  @RequirePermission('invoices:read')
  @Delete('views/:viewId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteView(
    @CurrentUser() user: AuthenticatedUser,
    @Param('viewId', new ParseUUIDPipe()) viewId: string,
  ): Promise<void> {
    await this.tools.deleteView(user.tenantId, viewId);
  }

  @RequirePermission('invoices:read')
  @Get('month-close')
  monthClose(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ): Promise<MonthCloseDto> {
    const parsed = MonthSchema.safeParse(month);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes no válido' });
    }
    return this.tools.monthClose(user.tenantId, parsed.data, user.facilityScope ?? null);
  }

  @RequirePermission('invoices:manage')
  @Post('month-close/generate')
  @HttpCode(HttpStatus.OK)
  generateMonth(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MonthCloseGenerateDto,
    @Req() req: Request,
  ): Promise<MonthCloseGenerateResultDto> {
    return this.tools.generateMonth(user.tenantId, user.sub, body.month, extractMeta(req));
  }

  @RequirePermission('invoices:read')
  @Get(':id/activity')
  activity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceActivityDto> {
    return this.tools.activity(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('invoices:manage')
  @Get(':id/cancel-preview')
  cancelPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceCancelPreviewDto> {
    return this.tools.cancelPreview(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('invoices:refund')
  @Get(':id/refund-options')
  refundOptions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceRefundOptionsDto> {
    return this.tools.refundOptions(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('invoices:write')
  @Post(':id/duplicate')
  duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.tools.duplicate({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('communications:send')
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendInvoiceEmailDto,
    @Req() req: Request,
  ): Promise<SendInvoiceEmailResultDto> {
    return this.tools.sendEmail({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:write')
  @Post(':id/payments/:paymentId/undo')
  @HttpCode(HttpStatus.OK)
  undoPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body() body: UndoPaymentDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.tools.undoPayment({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      paymentId,
      reason: body.reason,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:write')
  @Patch(':id/payments/:paymentId')
  correctPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body() body: CorrectPaymentDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.tools.correctPayment({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      paymentId,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }
}
