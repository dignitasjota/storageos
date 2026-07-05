import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';

/**
 * Cron diario (08:00, un poco después del de alertas) que dispara los emails de
 * ciclo de vida al tenant. Corre en el API (ligero, no gateado por el flag de
 * workers) y se dedup entre réplicas con `claimDailyCronRun`.
 */
@Injectable()
export class TenantLifecycleEmailsCron {
  private readonly logger = new Logger(TenantLifecycleEmailsCron.name);

  constructor(
    private readonly lifecycle: TenantLifecycleEmailsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 8 * * *', { name: 'tenant-lifecycle.daily' })
  async run(): Promise<void> {
    try {
      // Con varias réplicas del API, solo una debe disparar los emails del día.
      if (!(await claimDailyCronRun(this.admin, 'tenant-lifecycle.daily'))) return;
      const res = await this.lifecycle.run();
      if (res.welcome + res.trialReminders + res.pastDue > 0) {
        this.logger.log(
          `tenant-lifecycle.daily: welcome=${res.welcome}, trial=${res.trialReminders}, pastDue=${res.pastDue}`,
        );
      }
    } catch (err) {
      this.logger.error(`tenant-lifecycle.daily fallo: ${(err as Error).message}`);
    }
  }
}
