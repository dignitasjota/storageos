import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  BulkInvoiceActionSchema,
  type BulkInvoiceActionResultDto,
  ChargeInvoiceSchema,
  type ReturnedReceiptsDto,
  type PaymentDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PaymentsService } from './payments.service';
import { ReturnedReceiptsService } from './returned-receipts.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class ChargeInvoiceDto extends createZodDto(ChargeInvoiceSchema) {}
class BulkInvoiceActionDto extends createZodDto(BulkInvoiceActionSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly returnedReceipts: ReturnedReceiptsService,
  ) {}

  /** Recibos devueltos y adeudos rechazados en un periodo. */
  @RequirePermission('payments:read')
  @Get('returns')
  async returns(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<ReturnedReceiptsDto> {
    if (facilityId && !/^[0-9a-f-]{36}$/i.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.returnedReceipts.list(user.tenantId, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(kind ? { kind } : {}),
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('payments:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('invoiceId') invoiceId?: string,
    @Query('customerId') customerId?: string,
  ): Promise<PaymentDto[]> {
    return this.payments.list(user.tenantId, {
      ...(invoiceId ? { invoiceId } : {}),
      ...(customerId ? { customerId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Cobra N facturas en lote. ANTES de `invoices/:invoiceId/charge` para que
   *  `bulk` no se interprete como un `:invoiceId`. */
  @RequirePermission('payments:charge')
  @Post('invoices/bulk/charge')
  @HttpCode(HttpStatus.OK)
  async bulkCharge(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkInvoiceActionDto,
    @Req() req: Request,
  ): Promise<BulkInvoiceActionResultDto> {
    return this.payments.bulkCharge({
      tenantId: user.tenantId,
      userId: user.sub,
      ids: body.ids,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('payments:charge')
  @Post('invoices/:invoiceId/charge')
  @HttpCode(HttpStatus.OK)
  async charge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Body() input: ChargeInvoiceDto,
    @Req() req: Request,
  ): Promise<PaymentDto> {
    return this.payments.chargeInvoice({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId,
      input,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }
}
