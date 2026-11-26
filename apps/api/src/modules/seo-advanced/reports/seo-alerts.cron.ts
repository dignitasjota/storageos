import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimAlert } from '../../admin/alert-state';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SeoAlertsService } from './seo-alerts.service';

/**
 * Cada hora (minuto 20), las alertas de los proyectos SEO con datos nuevos o
 * sin mirar desde hace 6 horas. Corre en el API, no en el worker: los avisos
 * de la plataforma por Telegram o Slack los manda el panel admin, que solo
 * está en el API. Se reserva la hora para no repetirlo entre réplicas.
 */
@Injectable()
export class SeoAlertsCron {
  private readonly logger = new Logger(SeoAlertsCron.name);

  constructor(
    private readonly alerts: SeoAlertsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('20 * * * *', { name: 'seo.alerts' })
  async hourly(): Promise<void> {
    try {
      if (!(await claimAlert(this.admin, 'seo.alerts', 'cron', 50))) return;
      const res = await this.alerts.evaluateDue();
      if (res.created > 0) this.logger.log(`SEO: ${res.created} alerta(s) nueva(s)`);
    } catch (err) {
      this.logger.error(`Alertas SEO: ${(err as Error).message}`);
    }
  }
}
