import { Module } from '@nestjs/common';

import { BusinessRemindersModule } from '../business-reminders/business-reminders.module';
import { CustomerMessagesModule } from '../customer-messages/customer-messages.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { OperationsModule } from '../operations/operations.module';

import { DailyOpsController } from './daily-ops.controller';
import { DailyOpsService } from './daily-ops.service';

/**
 * Operaciones diarias que cruzan con Gastos, Mensajes y Vencimientos. Aparte
 * de `OperationsModule` porque Gastos importa la IA, y la IA, Operaciones.
 */
@Module({
  imports: [OperationsModule, ExpensesModule, CustomerMessagesModule, BusinessRemindersModule],
  controllers: [DailyOpsController],
  providers: [DailyOpsService],
})
export class DailyOpsModule {}
