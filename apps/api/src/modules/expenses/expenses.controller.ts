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
  Put,
  Query,
} from '@nestjs/common';
import {
  BulkExpenseActionSchema,
  CreateExpenseCategorySchema,
  CreateExpenseSchema,
  CreateExpenseSupplierSchema,
  CreateRecurringExpenseSchema,
  MarkExpensePaidSchema,
  ProfitLossAllocationEnum,
  ReadExpenseReceiptSchema,
  RequestExpenseReceiptUploadSchema,
  UpdateExpenseBudgetsSchema,
  UpdateExpenseSchema,
  UpdateExpenseSupplierSchema,
  UpdateRecurringExpenseSchema,
  roleHasPermission,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { parsePageRequest, toPage } from '../../common/pagination';

import { ExpenseCatalogService } from './expense-catalog.service';
import { ExpensesService, type ExpenseFilters } from './expenses.service';
import { ProfitLossService } from './profit-loss.service';
import { RecurringExpensesService } from './recurring-expenses.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  BulkExpenseResultDto,
  ExpenseBudgetDto,
  ExpenseCategoryDto,
  ExpenseDto,
  ExpenseReceiptReadDto,
  ExpenseReceiptUploadDto,
  ExpenseSupplierDto,
  ExpenseTotalDto,
  PageDto,
  Permission,
  ProfitLossAllocation,
  ProfitLossDto,
  ProfitLossMonthlyDto,
  RecurringExpenseDto,
} from '@storageos/shared';

/** ¿Tiene el permiso? (los tokens antiguos no traen la lista: se mira el rol). */
function can(user: AuthenticatedUser, permission: Permission): boolean {
  return user.permissions
    ? user.permissions.includes(permission)
    : roleHasPermission(user.role, permission);
}

class CreateExpenseDto extends createZodDto(CreateExpenseSchema) {}
class UpdateExpenseDto extends createZodDto(UpdateExpenseSchema) {}
class MarkExpensePaidDto extends createZodDto(MarkExpensePaidSchema) {}
class RequestReceiptUploadDto extends createZodDto(RequestExpenseReceiptUploadSchema) {}
class ReadReceiptDto extends createZodDto(ReadExpenseReceiptSchema) {}
class CreateRecurringExpenseDto extends createZodDto(CreateRecurringExpenseSchema) {}
class UpdateRecurringExpenseDto extends createZodDto(UpdateRecurringExpenseSchema) {}
class UpdateBudgetsDto extends createZodDto(UpdateExpenseBudgetsSchema) {}
class CreateSupplierDto extends createZodDto(CreateExpenseSupplierSchema) {}
class UpdateSupplierDto extends createZodDto(UpdateExpenseSupplierSchema) {}
class CreateCategoryDto extends createZodDto(CreateExpenseCategorySchema) {}

interface FilterQuery {
  facilityId?: string;
  category?: string;
  from?: string;
  to?: string;
  search?: string;
  paymentStatus?: string;
  supplierId?: string;
}

function filtersOf(user: AuthenticatedUser, q: FilterQuery): ExpenseFilters {
  return {
    ...(q.facilityId ? { facilityId: q.facilityId } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.search ? { search: q.search } : {}),
    ...(q.paymentStatus ? { paymentStatus: q.paymentStatus } : {}),
    ...(q.supplierId ? { supplierId: q.supplierId } : {}),
    facilityScope: user.facilityScope ?? null,
  };
}

function allocationOf(value: string | undefined): ProfitLossAllocation {
  if (!value) return 'none';
  const parsed = ProfitLossAllocationEnum.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_allocation', message: 'Reparto no válido' });
  }
  return parsed.data;
}

@Controller('expenses')
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly recurring: RecurringExpensesService,
    private readonly pnl: ProfitLossService,
  ) {}

  /** Página de la lista (cursor + búsqueda) para el panel. Antes de `:id`. */
  @RequirePermission('expenses:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: FilterQuery & { cursor?: string; limit?: string },
  ): Promise<PageDto<ExpenseDto>> {
    const page = parsePageRequest(q.cursor, q.limit);
    const rows = await this.expenses.list(user.tenantId, { ...filtersOf(user, q), page });
    return toPage(rows, page);
  }

  @RequirePermission('expenses:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: FilterQuery): Promise<ExpenseDto[]> {
    return this.expenses.list(user.tenantId, filtersOf(user, q));
  }

  /** Todo lo filtrado para el CSV (hasta 5.000). Antes de `:id`. */
  @RequirePermission('expenses:read')
  @Get('export')
  exportRows(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: FilterQuery,
  ): Promise<ExpenseDto[]> {
    return this.expenses.list(user.tenantId, { ...filtersOf(user, q), take: 5000 });
  }

  /** Número, importe y pendiente de pago de lo filtrado. Antes de `:id`. */
  @RequirePermission('expenses:read')
  @Get('total')
  total(@CurrentUser() user: AuthenticatedUser, @Query() q: FilterQuery): Promise<ExpenseTotalDto> {
    return this.expenses.total(user.tenantId, filtersOf(user, q));
  }

  /** Cuenta de resultados (P&L) por local en un periodo. */
  @RequirePermission('expenses:read')
  @Get('profit-loss')
  profitLoss(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('allocation') allocation?: string,
  ): Promise<ProfitLossDto> {
    return this.pnl.getProfitLoss(user.tenantId, from, to, {
      allocation: allocationOf(allocation),
      facilityScope: user.facilityScope ?? null,
      invoicesVisible: can(user, 'invoices:read'),
      paymentsVisible: can(user, 'payments:read'),
    });
  }

  /** Mes a mes (como mucho 24 meses), opcionalmente de un local. */
  @RequirePermission('expenses:read')
  @Get('profit-loss/monthly')
  profitLossMonthly(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<ProfitLossMonthlyDto> {
    return this.pnl.getMonthly(user.tenantId, from, to, {
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
      invoicesVisible: can(user, 'invoices:read'),
      paymentsVisible: can(user, 'payments:read'),
    });
  }

  @RequirePermission('expenses:read')
  @Get('budgets')
  budgets(@CurrentUser() user: AuthenticatedUser): Promise<ExpenseBudgetDto[]> {
    return this.pnl.getBudgets(user.tenantId);
  }

  @RequirePermission('expenses:manage')
  @Put('budgets')
  setBudgets(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateBudgetsDto,
  ): Promise<ExpenseBudgetDto[]> {
    return this.pnl.setBudgets(user.tenantId, body);
  }

  // ---- justificante ----

  @RequirePermission('expenses:manage')
  @Post('receipt-upload-url')
  receiptUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RequestReceiptUploadDto,
  ): Promise<ExpenseReceiptUploadDto> {
    return this.expenses.receiptUploadUrl(user.tenantId, body.mimeType);
  }

  /** La IA lee el justificante y propone los datos (gasta una consulta del mes). */
  @RequirePermission('expenses:manage')
  @Post('receipts/read')
  @HttpCode(HttpStatus.OK)
  readReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ReadReceiptDto,
  ): Promise<ExpenseReceiptReadDto> {
    return this.expenses.readReceipt(user.tenantId, user.sub, body.key);
  }

  // ---- cambios en lote ----

  @RequirePermission('expenses:manage')
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  bulk(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<BulkExpenseResultDto> {
    // Unión por `action`: `createZodDto` no la admite, se valida aquí.
    const parsed = BulkExpenseActionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? 'Datos no válidos',
      });
    }
    return this.expenses.bulk(user.tenantId, user.sub, parsed.data, user.facilityScope ?? null);
  }

  // ---- gastos recurrentes (plantillas) ----

  @RequirePermission('expenses:read')
  @Get('recurring')
  listRecurring(@CurrentUser() user: AuthenticatedUser): Promise<RecurringExpenseDto[]> {
    return this.recurring.list(user.tenantId, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Post('recurring')
  createRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRecurringExpenseDto,
  ): Promise<RecurringExpenseDto> {
    return this.recurring.create(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }

  /** Genera ya los gastos recurrentes vencidos de este tenant (sin esperar al cron). */
  @RequirePermission('expenses:manage')
  @Post('recurring/run')
  runRecurring(@CurrentUser() user: AuthenticatedUser): Promise<{ created: number }> {
    return this.recurring.generateForTenant(user.tenantId);
  }

  /** Genera las fechas que se quedaron sin generar de una plantilla. */
  @RequirePermission('expenses:manage')
  @Post('recurring/:id/catch-up')
  @HttpCode(HttpStatus.OK)
  catchUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ created: number }> {
    return this.recurring.catchUp(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Patch('recurring/:id')
  updateRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateRecurringExpenseDto,
  ): Promise<RecurringExpenseDto> {
    return this.recurring.update(user.tenantId, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Delete('recurring/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.recurring.remove(user.tenantId, id, user.facilityScope ?? null);
  }

  // ---- un gasto ----

  @RequirePermission('expenses:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateExpenseDto,
  ): Promise<ExpenseDto> {
    return this.expenses.create(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }

  /** Un gasto (la revisión de Fiscalidad enlaza a cada uno). Tras las rutas fijas. */
  @RequirePermission('expenses:read')
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ExpenseDto> {
    return this.expenses.get(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:read')
  @Get(':id/receipt')
  receipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ url: string }> {
    return this.expenses.receiptUrl(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Post(':id/mark-paid')
  @HttpCode(HttpStatus.OK)
  markPaid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MarkExpensePaidDto,
  ): Promise<ExpenseDto> {
    return this.expenses.markPaid(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Post(':id/mark-pending')
  @HttpCode(HttpStatus.OK)
  markPending(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ExpenseDto> {
    return this.expenses.markPending(user.tenantId, user.sub, id, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateExpenseDto,
  ): Promise<ExpenseDto> {
    return this.expenses.update(user.tenantId, id, body, user.facilityScope ?? null, user.sub);
  }

  @RequirePermission('expenses:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.expenses.remove(user.tenantId, id, user.facilityScope ?? null);
  }
}

/** Proveedores de los gastos. */
@Controller('expense-suppliers')
export class ExpenseSuppliersController {
  constructor(private readonly catalog: ExpenseCatalogService) {}

  @RequirePermission('expenses:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
    @Query('all') all?: string,
  ): Promise<ExpenseSupplierDto[]> {
    return this.catalog.listSuppliers(user.tenantId, {
      ...(search ? { search } : {}),
      includeInactive: all === '1' || all === 'true',
    });
  }

  @RequirePermission('expenses:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateSupplierDto,
  ): Promise<ExpenseSupplierDto> {
    return this.catalog.createSupplier(user.tenantId, body);
  }

  @RequirePermission('expenses:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateSupplierDto,
  ): Promise<ExpenseSupplierDto> {
    return this.catalog.updateSupplier(user.tenantId, id, body);
  }

  @RequirePermission('expenses:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.catalog.removeSupplier(user.tenantId, id);
  }
}

/** Categorías de gasto: las de siempre y las propias. */
@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly catalog: ExpenseCatalogService) {}

  @RequirePermission('expenses:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ExpenseCategoryDto[]> {
    return this.catalog.listCategories(user.tenantId);
  }

  @RequirePermission('expenses:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCategoryDto,
  ): Promise<ExpenseCategoryDto> {
    return this.catalog.createCategory(user.tenantId, body);
  }

  @RequirePermission('expenses:manage')
  @Patch(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async rename(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateCategoryDto,
  ): Promise<void> {
    await this.catalog.renameCategory(user.tenantId, id, body);
  }

  /** Sus gastos pasan a «Otros». */
  @RequirePermission('expenses:manage')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ moved: number }> {
    return this.catalog.removeCategory(user.tenantId, id);
  }
}
