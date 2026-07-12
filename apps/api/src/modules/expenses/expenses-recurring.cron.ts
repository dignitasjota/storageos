import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { ExpensesService } from './expenses.service';

/**
 * Cron diario que genera los gastos de las plantillas recurrentes vencidas de
 * todos los tenants. Ligero y sin BullMQ → corre en el API (patrón
 * `claimDailyCronRun` para que solo una réplica lo ejecute al día). La
 * generación es idempotente (dedup por `lastGeneratedMonth`).
 */
@Injectable()
export class ExpensesRecurringCron {
  private readonly logger = new Logger(ExpensesRecurringCron.name);

  constructor(
    private readonly expenses: ExpensesService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 6 * * *')
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'expenses-recurring.daily'))) return;
      const res = await this.expenses.generateDueAll();
      if (res.created > 0) {
        this.logger.log(`Gastos recurrentes: ${res.created} generados en ${res.tenants} tenant(s)`);
      }
    } catch (err) {
      this.logger.error(`Cron de gastos recurrentes falló: ${(err as Error).message}`);
    }
  }
}
