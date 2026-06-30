import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PlatformAlertsService } from './platform-alerts.service';

/** Cron diario (07:00) que evalúa las alertas de plataforma y envía el digest. */
@Injectable()
export class PlatformAlertsCron {
  private readonly logger = new Logger(PlatformAlertsCron.name);

  constructor(private readonly alerts: PlatformAlertsService) {}

  @Cron('0 7 * * *', { name: 'platform-alerts.daily' })
  async run(): Promise<void> {
    try {
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
