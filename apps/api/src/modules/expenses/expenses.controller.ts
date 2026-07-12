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
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ExpensesService } from './expenses.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { ExpenseDto, ProfitLossDto, RecurringExpenseDto } from '@storageos/shared';

class CreateExpenseDto extends createZodDto(CreateExpenseSchema) {}
class UpdateExpenseDto extends createZodDto(UpdateExpenseSchema) {}
class CreateRecurringExpenseDto extends createZodDto(CreateRecurringExpenseSchema) {}
class UpdateRecurringExpenseDto extends createZodDto(UpdateRecurringExpenseSchema) {}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

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
    return this.expenses.getProfitLoss(user.tenantId, from, to);
  }

  // ---- gastos recurrentes (plantillas) ----

  @RequirePermission('expenses:read')
  @Get('recurring')
  listRecurring(@CurrentUser() user: AuthenticatedUser): Promise<RecurringExpenseDto[]> {
    return this.expenses.listRecurring(user.tenantId);
  }

  @RequirePermission('expenses:manage')
  @Post('recurring')
  createRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRecurringExpenseDto,
  ): Promise<RecurringExpenseDto> {
    return this.expenses.createRecurring(user.tenantId, user.sub, body);
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
    return this.expenses.updateRecurring(user.tenantId, id, body);
  }

  @RequirePermission('expenses:manage')
  @Delete('recurring/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRecurring(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.expenses.removeRecurring(user.tenantId, id);
  }

  @RequirePermission('expenses:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateExpenseDto,
  ): Promise<ExpenseDto> {
    return this.expenses.create(user.tenantId, user.sub, body);
  }

  @RequirePermission('expenses:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateExpenseDto,
  ): Promise<ExpenseDto> {
    return this.expenses.update(user.tenantId, id, body);
  }

  @RequirePermission('expenses:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.expenses.remove(user.tenantId, id);
  }
}
