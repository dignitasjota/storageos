import {
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
  type PaymentDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PaymentsService } from './payments.service';

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
  constructor(private readonly payments: PaymentsService) {}

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
      meta: extractMeta(req),
    });
  }
}
