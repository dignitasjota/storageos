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
import { CreateExpenseSchema, UpdateExpenseSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ExpensesService } from './expenses.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { ExpenseDto, ProfitLossDto } from '@storageos/shared';

class CreateExpenseDto extends createZodDto(CreateExpenseSchema) {}
class UpdateExpenseDto extends createZodDto(UpdateExpenseSchema) {}

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
