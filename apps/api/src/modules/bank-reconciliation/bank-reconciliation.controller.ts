import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  type BankStatementDetailDto,
  type BankStatementDto,
  ImportN43Schema,
  type ImportN43ResultDto,
  MatchTransactionSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { BankReconciliationService } from './bank-reconciliation.service';

class ImportN43Dto extends createZodDto(ImportN43Schema) {}
class MatchTransactionDto extends createZodDto(MatchTransactionSchema) {}

@Controller('bank-statements')
export class BankReconciliationController {
  constructor(private readonly service: BankReconciliationService) {}

  @RequirePermission('invoices:manage')
  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  import(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportN43Dto,
  ): Promise<ImportN43ResultDto> {
    return this.service.import({ tenantId: user.tenantId, userId: user.sub, input: body });
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

  @RequirePermission('invoices:manage')
  @Post('transactions/:id/match')
  @HttpCode(HttpStatus.OK)
  match(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MatchTransactionDto,
  ): Promise<BankStatementDetailDto> {
    return this.service.matchTransaction({
      tenantId: user.tenantId,
      userId: user.sub,
      transactionId: id,
      invoiceId: body.invoiceId,
    });
  }

  @RequirePermission('invoices:manage')
  @Post('transactions/:id/mark-return')
  @HttpCode(HttpStatus.OK)
  markReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MatchTransactionDto,
  ): Promise<BankStatementDetailDto> {
    return this.service.markReturn({
      tenantId: user.tenantId,
      userId: user.sub,
      transactionId: id,
      invoiceId: body.invoiceId,
    });
  }

  @RequirePermission('invoices:manage')
  @Post('transactions/:id/ignore')
  @HttpCode(HttpStatus.OK)
  ignore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BankStatementDetailDto> {
    return this.service.ignoreTransaction(user.tenantId, id);
  }
}
