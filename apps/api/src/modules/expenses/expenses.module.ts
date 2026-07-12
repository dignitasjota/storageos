import { Module } from '@nestjs/common';

import { ExpensesRecurringCron } from './expenses-recurring.cron';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

/** Gastos del operador + cuenta de resultados (P&L) por local + recurrentes. */
@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService, ExpensesRecurringCron],
  exports: [ExpensesService],
})
export class ExpensesModule {}
