import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { PlatformAlertsService } from './platform-alerts.service';

/** Cron diario (07:00) que evalúa las alertas de plataforma y envía el digest. */
@Injectable()
export class PlatformAlertsCron {
  private readonly logger = new Logger(PlatformAlertsCron.name);

  constructor(
    private readonly alerts: PlatformAlertsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 7 * * *', { name: 'platform-alerts.daily' })
  async run(): Promise<void> {
    try {
      // Con varias réplicas del API, solo una debe enviar el digest del día.
      if (!(await claimDailyCronRun(this.admin, 'platform-alerts.daily'))) return;
      const res = await this.alerts.evaluateAndNotify();
      if (res.sent) {
        this.logger.log(
          `platform-alerts.daily: digest enviado (pastDue=${res.pastDue}, trialExpiring=${res.trialExpiring})`,
        );
      }
    } catch (err) {
      this.logger.error(`platform-alerts.daily fallo: ${(err as Error).message}`);
    }
  }
}
