import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AccountantReportService } from './accountant-report.service';

/**
 * Envío automático a la asesoría (cada mes o cada trimestre, desde el día 5).
 * Ligero → corre en el API; `claimDailyCronRun` evita que dos réplicas lo
 * ejecuten y cada empresa reserva su periodo antes de enviarlo.
 */
@Injectable()
export class AccountantReportCron {
  private readonly logger = new Logger(AccountantReportCron.name);

  constructor(
    private readonly reports: AccountantReportService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 8 * * *', { name: 'fiscal.accountant-report', timeZone: 'Europe/Madrid' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'fiscal.accountant-report'))) return;
      const res = await this.reports.runDue();
      if (res.sent + res.failed > 0) {
        this.logger.log(`asesoría: ${res.sent} enviados, ${res.failed} fallidos`);
      }
    } catch (err) {
      this.logger.error(`Cron del envío a la asesoría falló: ${(err as Error).message}`);
    }
  }
}
