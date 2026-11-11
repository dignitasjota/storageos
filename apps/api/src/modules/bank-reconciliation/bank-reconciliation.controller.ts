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
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type BankReconciliationSettingsDto,
  type BankStatementDetailDto,
  type BankStatementDto,
  ImportN43Schema,
  type ImportN43ResultDto,
  MarkReturnTransactionSchema,
  MatchTransactionSchema,
  UpdateBankReconciliationSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CompanyWideGuard } from '../../common/guards/company-wide.guard';

import { BankReconciliationService } from './bank-reconciliation.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class ImportN43Dto extends createZodDto(ImportN43Schema) {}
class MatchTransactionDto extends createZodDto(MatchTransactionSchema) {}
class MarkReturnTransactionDto extends createZodDto(MarkReturnTransactionSchema) {}
class UpdateSettingsDto extends createZodDto(UpdateBankReconciliationSettingsSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Conciliación bancaria (Cuaderno 43). El extracto es de toda la empresa: un
 * usuario restringido a algunos locales no la usa (403 `company_wide_only`).
 */
@Controller('bank-statements')
@RequireFeature('bank_reconciliation')
@UseGuards(CompanyWideGuard)
export class BankReconciliationController {
  constructor(private readonly service: BankReconciliationService) {}

  @RequirePermission('invoices:manage')
  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  import(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportN43Dto,
    @Req() req: Request,
  ): Promise<ImportN43ResultDto> {
    return this.service.import({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  /** Conciliación automática al importar (opcional). Antes de `:id`. */
  @RequirePermission('payments:read')
  @Get('settings')
  getSettings(@CurrentUser() user: AuthenticatedUser): Promise<BankReconciliationSettingsDto> {
    return this.service.getSettings(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSettingsDto,
  ): Promise<BankReconciliationSettingsDto> {
    return this.service.updateSettings({
      tenantId: user.tenantId,
      userId: user.sub,
      autoReconcile: body.autoReconcile,
    });
  }

  @RequirePermission('payments:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<BankStatementDto[]> {
    return this.service.listStatements(user.tenantId);
  }

  @RequirePermission('payments:read')
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BankStatementDetailDto> {
    return this.service.getStatement(user.tenantId, id);
  }

  /** Borra un extracto sin nada conciliado ni devuelto. */
  @RequirePermission('invoices:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.deleteStatement({
      tenantId: user.tenantId,
      userId: user.sub,
      statementId: id,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:manage')
  @Post('transactions/:id/match')
  @HttpCode(HttpStatus.OK)
  match(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MatchTransactionDto,
    @Req() req: Request,
  ): Promise<BankStatementDetailDto> {
    return this.service.matchTransaction({
      tenantId: user.tenantId,
      userId: user.sub,
      transactionId: id,
      invoiceIds: body.invoiceIds ?? [body.invoiceId!],
      ...(body.surplus ? { surplus: body.surplus } : {}),
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:manage')
  @Post('transactions/:id/mark-return')
  @HttpCode(HttpStatus.OK)
  markReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MarkReturnTransactionDto,
    @Req() req: Request,
  ): Promise<BankStatementDetailDto> {
    return this.service.markReturn({
      tenantId: user.tenantId,
      userId: user.sub,
      transactionId: id,
      invoiceId: body.invoiceId,
      ...(body.paymentId ? { paymentId: body.paymentId } : {}),
      meta: extractMeta(req),
    });
  }

  @RequirePermission('invoices:manage')
  @Post('transactions/:id/ignore')
  @HttpCode(HttpStatus.OK)
  ignore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<BankStatementDetailDto> {
    return this.service.ignoreTransaction({
      tenantId: user.tenantId,
      userId: user.sub,
      transactionId: id,
      meta: extractMeta(req),
    });
  }

  /** Deshace una conciliación (automática o a mano), una devolución o un «ignorado». */
  @RequirePermission('invoices:manage')
  @Post('transactions/:id/undo')
  @HttpCode(HttpStatus.OK)
  undo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<BankStatementDetailDto> {
    return this.service.undoTransaction({
      tenantId: user.tenantId,
      userId: user.sub,
      transactionId: id,
      meta: extractMeta(req),
    });
  }
}
