import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';

import { ExpenseCatalogService } from './expense-catalog.service';
import { ExpensesRecurringCron } from './expenses-recurring.cron';
import {
  ExpenseCategoriesController,
  ExpenseSuppliersController,
  ExpensesController,
} from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { ProfitLossService } from './profit-loss.service';
import { RecurringExpensesService } from './recurring-expenses.service';

/**
 * Gastos del operador: proveedores, categorías propias, desglose fiscal,
 * justificantes (con lectura por IA), pago (con la salida de caja), cuenta de
 * resultados por local, presupuesto y gastos recurrentes.
 */
@Module({
  imports: [AiModule],
  controllers: [ExpensesController, ExpenseSuppliersController, ExpenseCategoriesController],
  providers: [
    ExpensesService,
    ExpenseCatalogService,
    RecurringExpensesService,
    ProfitLossService,
    ExpensesRecurringCron,
  ],
  exports: [ExpensesService, ExpenseCatalogService, RecurringExpensesService, ProfitLossService],
})
export class ExpensesModule {}
