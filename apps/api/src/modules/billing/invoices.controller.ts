import {
  BadRequestException,
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
  BulkRemindCustomersSchema,
  type BulkInvoiceActionResultDto,
  CancelInvoiceSchema,
  CreateInvoiceSchema,
  type InvoiceDto,
  InvoiceStatusEnum,
  type LateFeePreviewDto,
  LinkHoldedCreditNoteSchema,
  MarkPaidManuallySchema,
  RectifyInvoiceSchema,
  RefundInvoiceSchema,
  type SignedDownloadDto,
  UpdateInvoiceSchema,
  VoidInvoiceSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertUuid, parsePageRequest, toPage } from '../../common/pagination';

import { BillingJobsService } from './billing-jobs.service';
import { type InvoiceListQuery, parseInvoiceListQuery } from './invoice-list-query';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceToolsService } from './invoice-tools.service';
import { InvoicesService } from './invoices.service';

import type { RequestMeta } from '../auth/auth.service';
import type { PageDto } from '@storageos/shared';
import type { Request } from 'express';

class CreateInvoiceDto extends createZodDto(CreateInvoiceSchema) {}
class UpdateInvoiceDto extends createZodDto(UpdateInvoiceSchema) {}
class CancelInvoiceDto extends createZodDto(CancelInvoiceSchema) {}
class VoidInvoiceDto extends createZodDto(VoidInvoiceSchema) {}
class RefundInvoiceDto extends createZodDto(RefundInvoiceSchema) {}
class MarkPaidManuallyDto extends createZodDto(MarkPaidManuallySchema) {}
class BulkRemindCustomersDto extends createZodDto(BulkRemindCustomersSchema) {}
class BulkInvoiceActionDto extends createZodDto(BulkInvoiceActionSchema) {}
class LinkHoldedCreditNoteDto extends createZodDto(LinkHoldedCreditNoteSchema) {}
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
    private readonly tools: InvoiceToolsService,
  ) {}

  /** Página de la lista (cursor + búsqueda) para el panel. Antes de `:id`. */
  @RequirePermission('invoices:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: InvoiceListQuery,
  ): Promise<PageDto<InvoiceDto>> {
    const page = parsePageRequest(query.cursor, query.limit);
    const rows = await this.invoices.list(user.tenantId, {
      ...parseInvoiceListQuery(query),
      page,
      facilityScope: user.facilityScope ?? null,
    });
    const result = toPage(rows, page);
    // Con el estado real del cobro (en curso, en remesa, en plan, recordada).
    return { ...result, items: await this.tools.withCollection(user.tenantId, result.items) };
  }

  @RequirePermission('invoices:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('contractId') contractId?: string,
    @Query('overdue') overdue?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<InvoiceDto[]> {
    const parsedStatus = parseStatus(status);
    assertUuid(customerId);
    assertUuid(contractId);
    assertUuid(facilityId);
    return this.invoices.list(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(customerId ? { customerId } : {}),
      ...(contractId ? { contractId } : {}),
      ...(overdue === 'true' ? { overdue: true } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('invoices:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceDto> {
    const dto = await this.invoices.detail(user.tenantId, id, user.facilityScope ?? null);
    const [withState] = await this.tools.withCollection(user.tenantId, [dto]);
    return withState ?? dto;
  }

  /** URL firmada de corta duración para descargar el PDF (bucket privado). */
  @RequirePermission('invoices:read')
  @Get(':id/signed-pdf')
  async signedPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SignedDownloadDto> {
    return this.invoices.getSignedPdfUrl(user.tenantId, id, user.facilityScope ?? null);
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
      facilityScope: user.facilityScope ?? null,
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
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  /** Recuerda su deuda a los inquilinos elegidos. ANTES de `:id/issue`. */
  @RequirePermission('communications:send')
  @Post('bulk/remind-customers')
  @HttpCode(HttpStatus.OK)
  async remindCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkRemindCustomersDto,
  ): Promise<BulkInvoiceActionResultDto> {
    return this.invoices.remindCustomers({
      tenantId: user.tenantId,
      customerIds: body.customerIds,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Envía en lote un recordatorio de pago a N facturas pendientes. ANTES de
   *  `:id/issue` para que `bulk` no se interprete como un `:id`. */
  @RequirePermission('communications:send')
  @Post('bulk/remind')
  @HttpCode(HttpStatus.OK)
  async bulkRemind(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkInvoiceActionDto,
  ): Promise<BulkInvoiceActionResultDto> {
    return this.invoices.bulkRemind({
      tenantId: user.tenantId,
      ids: body.ids,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Modo Holded: enlaza la rectificativa que el tenant creó en Holded. */
  @RequirePermission('invoices:manage')
  @Post(':id/link-holded')
  @HttpCode(HttpStatus.OK)
  async linkHolded(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: LinkHoldedCreditNoteDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.linkHoldedCreditNote({
      tenantId: user.tenantId,
      userId: user.sub,
      invoiceId: id,
      holdedDocumentId: body.holdedDocumentId,
      facilityScope: user.facilityScope ?? null,
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

  /** Cuánto sería el recargo por mora (para confirmarlo antes de emitirlo). */
  @RequirePermission('invoices:manage')
  @Get(':id/late-fee-preview')
  async lateFeePreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LateFeePreviewDto> {
    return this.invoices.lateFeePreview(user.tenantId, id, user.facilityScope ?? null);
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

  /**
   * Anular una factura emitida por error (de prueba, duplicada, de una
   * operación que no existió): registro de anulación y fuera de los libros. Lo
   * habitual, si la operación existió, es rectificarla (`/cancel`).
   */
  @RequirePermission('invoices:manage')
  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  async void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: VoidInvoiceDto,
    @Req() req: Request,
  ): Promise<InvoiceDto> {
    return this.invoices.void({
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
      rejectDuplicate: true,
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
      rejectDuplicate: true,
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
    // Alcance por local: asserta (403/404) antes de generar el PDF de la factura.
    const invoice = await this.invoices.detail(user.tenantId, id, user.facilityScope ?? null);
    if (invoice.status === 'draft') {
      throw new BadRequestException({
        code: 'invoice_is_draft',
        message: 'Un borrador no tiene PDF: emítelo primero',
      });
    }
    return this.pdf.generate(user.tenantId, id);
  }

  @RequirePermission('invoices:manage')
  @Post('jobs/run-recurring')
  @HttpCode(HttpStatus.OK)
  async runRecurring(@CurrentUser() user: AuthenticatedUser): Promise<{ jobId: string }> {
    return this.billingJobs.enqueueForTenant(user.tenantId);
  }
}

/** Estado de la lista: uno que no existe es un 400 legible, no un 500. */
function parseStatus(status: string | undefined) {
  if (!status) return undefined;
  const parsed = InvoiceStatusEnum.safeParse(status);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
  }
  return parsed.data;
}
