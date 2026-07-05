import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { WeeklyDigestService } from './weekly-digest.service';

/** Cron semanal (lunes 08:00) que envía el resumen de KPIs al super admin. */
@Injectable()
export class WeeklyDigestCron {
  private readonly logger = new Logger(WeeklyDigestCron.name);

  constructor(
    private readonly digest: WeeklyDigestService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 8 * * 1', { name: 'weekly-digest.weekly' })
  async run(): Promise<void> {
    try {
      // Con varias réplicas del API, solo una debe enviar el resumen del día.
      if (!(await claimDailyCronRun(this.admin, 'weekly-digest.weekly'))) return;
      const res = await this.digest.sendWeeklyDigest();
      if (res.sent) this.logger.log('weekly-digest.weekly: resumen enviado');
    } catch (err) {
      this.logger.error(`weekly-digest.weekly fallo: ${(err as Error).message}`);
    }
  }
}
