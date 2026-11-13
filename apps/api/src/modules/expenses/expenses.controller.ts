import {
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
} from '@nestjs/common';
import {
  CreateExpenseSchema,
  CreateRecurringExpenseSchema,
  UpdateExpenseSchema,
  UpdateRecurringExpenseSchema,
  roleHasPermission,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { parsePageRequest, toPage } from '../../common/pagination';

import { ExpensesService } from './expenses.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  ExpenseDto,
  PageDto,
  Permission,
  ProfitLossDto,
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
class CreateRecurringExpenseDto extends createZodDto(CreateRecurringExpenseSchema) {}
class UpdateRecurringExpenseDto extends createZodDto(UpdateRecurringExpenseSchema) {}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  /** Página de la lista (cursor + búsqueda) para el panel. Antes de `:id`. */
  @RequirePermission('expenses:read')
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageDto<ExpenseDto>> {
    const page = parsePageRequest(cursor, limit);
    const rows = await this.expenses.list(user.tenantId, {
      ...(search ? { search } : {}),
      page,
      ...(facilityId ? { facilityId } : {}),
      ...(category ? { category } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      facilityScope: user.facilityScope ?? null,
    });
    return toPage(rows, page);
  }

  @RequirePermission('expenses:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ExpenseDto[]> {
    return this.expenses.list(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      ...(category ? { category } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Número e importe de los gastos filtrados (la lista va por páginas). Antes de `:id`. */
  @RequirePermission('expenses:read')
  @Get('total')
  total(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
  ): Promise<{ count: number; amount: number }> {
    return this.expenses.total(user.tenantId, {
      ...(search ? { search } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(category ? { category } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Cuenta de resultados (P&L) por local en un periodo. */
  @RequirePermission('expenses:read')
  @Get('profit-loss')
  profitLoss(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<ProfitLossDto> {
    return this.expenses.getProfitLoss(user.tenantId, from, to, {
      facilityScope: user.facilityScope ?? null,
      invoicesVisible: can(user, 'invoices:read'),
      paymentsVisible: can(user, 'payments:read'),
    });
  }

  // ---- gastos recurrentes (plantillas) ----

  @RequirePermission('expenses:read')
  @Get('recurring')
  listRecurring(@CurrentUser() user: AuthenticatedUser): Promise<RecurringExpenseDto[]> {
    return this.expenses.listRecurring(user.tenantId, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Post('recurring')
  createRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRecurringExpenseDto,
  ): Promise<RecurringExpenseDto> {
    return this.expenses.createRecurring(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }

  /** Genera ya los gastos recurrentes vencidos de este tenant (sin esperar al cron). */
  @RequirePermission('expenses:manage')
  @Post('recurring/run')
  runRecurring(@CurrentUser() user: AuthenticatedUser): Promise<{ created: number }> {
    return this.expenses.generateForTenant(user.tenantId);
  }

  @RequirePermission('expenses:manage')
  @Patch('recurring/:id')
  updateRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateRecurringExpenseDto,
  ): Promise<RecurringExpenseDto> {
    return this.expenses.updateRecurring(user.tenantId, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Delete('recurring/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.expenses.removeRecurring(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateExpenseDto,
  ): Promise<ExpenseDto> {
    return this.expenses.create(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }

  @RequirePermission('expenses:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateExpenseDto,
  ): Promise<ExpenseDto> {
    return this.expenses.update(user.tenantId, id, body, user.facilityScope ?? null);
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
