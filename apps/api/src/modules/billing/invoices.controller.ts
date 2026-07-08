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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  BulkInvoiceActionSchema,
  type BulkInvoiceActionResultDto,
  CancelInvoiceSchema,
  CreateInvoiceSchema,
  type InvoiceDto,
  InvoiceStatusEnum,
  MarkPaidManuallySchema,
  RectifyInvoiceSchema,
  RefundInvoiceSchema,
  UpdateInvoiceSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { BillingJobsService } from './billing-jobs.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoicesService } from './invoices.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateInvoiceDto extends createZodDto(CreateInvoiceSchema) {}
class UpdateInvoiceDto extends createZodDto(UpdateInvoiceSchema) {}
class CancelInvoiceDto extends createZodDto(CancelInvoiceSchema) {}
class RefundInvoiceDto extends createZodDto(RefundInvoiceSchema) {}
class MarkPaidManuallyDto extends createZodDto(MarkPaidManuallySchema) {}
class BulkInvoiceActionDto extends createZodDto(BulkInvoiceActionSchema) {}
class RectifyInvoiceDto extends createZodDto(RectifyInvoiceSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@ApiTags('Billing')
@ApiBearerAuth('jwt')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
    private readonly billingJobs: BillingJobsService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('contractId') contractId?: string,
    @Query('overdue') overdue?: string,
  ): Promise<InvoiceDto[]> {
    const parsedStatus = status ? InvoiceStatusEnum.parse(status) : undefined;
    return this.invoices.list(user.tenantId, {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(customerId ? { customerId } : {}),
      ...(contractId ? { contractId } : {}),
      ...(overdue === 'true' ? { overdue: true } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceDto> {
    return this.invoices.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('invoices:write')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateInvoiceDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:write')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateInvoiceDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.update({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  /** Emite N borradores en lote (cierre mensual). ANTES de `:id/issue` para que
   *  `bulk` no se interprete como un `:id`. */
  @RequirePermission('invoices:manage')
  @Post('bulk/issue')
  @HttpCode(HttpStatus.OK)
  async bulkIssue(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkInvoiceActionDto,
    @Req() req: Request,
  ): Promise<BulkInvoiceActionResultDto> {
    return this.invoices.bulkIssue({
      tenantId: user.tenantId,
      userId: user.sub,
      ids: body.ids,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:manage')
  @Post(':id/issue')
  @HttpCode(HttpStatus.OK)
  async issue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.issue({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:manage')
  @Post(':id/late-fee')
  @HttpCode(HttpStatus.OK)
  async lateFee(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceDto> {
    return this.invoices.createLateFee({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('invoices:manage')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CancelInvoiceDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.cancel({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  // Devolución: acción sensible, solo `owner` (más fino que el rol).
  @RequirePermission('invoices:refund')
  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  async refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RefundInvoiceDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.refund({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:write')
  @Post(':id/mark-paid')
  @HttpCode(HttpStatus.OK)
  async markPaid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: MarkPaidManuallyDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.markPaidManually({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:manage')
  @Post(':id/rectify')
  @HttpCode(HttpStatus.CREATED)
  async rectify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RectifyInvoiceDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.rectify({
      tenantId: user.tenantId,
      userId: user.sub,
      originalInvoiceId: id,
      facilityScope: user.facilityScope ?? null,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:manage')
  @Post(':id/generate-pdf')
  @HttpCode(HttpStatus.OK)
  async generatePdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ pdfUrl: string }> {
    return this.pdf.generate(user.tenantId, id);
  }

  @RequirePermission('invoices:manage')
  @Post('jobs/run-recurring')
  @HttpCode(HttpStatus.OK)
  async runRecurring(@CurrentUser() user: AuthenticatedUser): Promise<{ jobId: string }> {
    return this.billingJobs.enqueueForTenant(user.tenantId);
  }
}
