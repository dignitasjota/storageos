import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { PlatformAlertsService } from './platform-alerts.service';

/**
 * Evalúa las alertas de plataforma y envía el aviso diario a la hora elegida
 * (hora de España; 07:00 por defecto). Corre cada hora y solo actúa en la suya.
 */
@Injectable()
export class PlatformAlertsCron {
  private readonly logger = new Logger(PlatformAlertsCron.name);

  constructor(
    private readonly alerts: PlatformAlertsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 * * * *', { name: 'platform-alerts.daily', timeZone: 'Europe/Madrid' })
  async run(): Promise<void> {
    try {
      const settings = await this.alerts.getSettings();
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Madrid',
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(new Date()),
      );
      if (hour !== settings.dailyHour) return;
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
