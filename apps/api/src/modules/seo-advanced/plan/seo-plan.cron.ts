import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SeoTaskNoticesService } from './seo-task-notices.service';

/** Cada mañana (08:00 en España), aviso de las tareas SEO que vencen hoy o van atrasadas. */
@Injectable()
export class SeoPlanCron {
  private readonly logger = new Logger(SeoPlanCron.name);

  constructor(
    private readonly notices: SeoTaskNoticesService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 8 * * *', { name: 'seo.tasks-due', timeZone: 'Europe/Madrid' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo.tasks-due'))) return;
      const res = await this.notices.dueToday();
      if (res.notified > 0) this.logger.log(`SEO: ${res.notified} aviso(s) de tareas`);
    } catch (err) {
      this.logger.error(`Avisos de tareas SEO: ${(err as Error).message}`);
    }
  }
}
