import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SeoConversionsService } from './seo-conversions.service';
import { SeoReportsService } from './seo-reports.service';

/**
 * Tareas de SEO Avanzado de la PR 8 que corren en el worker: las
 * conversiones de cada día (05:15) y los informes semanal (jueves) y mensual
 * (día 5), hora de España. Cada informe se reserva además por
 * proyecto y periodo (`seo_reports`), así que repetir el cron no lo duplica.
 */
@Injectable()
export class SeoReportsCron {
  private readonly logger = new Logger(SeoReportsCron.name);

  constructor(
    private readonly conversions: SeoConversionsService,
    private readonly reports: SeoReportsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('15 5 * * *', { name: 'seo.conversions-daily', timeZone: 'Europe/Madrid' })
  async conversionsDaily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo.conversions-daily'))) return;
      const res = await this.conversions.recomputeAll();
      if (res.projects > 0) this.logger.log(`SEO: conversiones de ${res.projects} proyecto(s)`);
    } catch (err) {
      this.logger.error(`Conversiones SEO: ${(err as Error).message}`);
    }
  }

  // Google da los datos definitivos 2 o 3 días tarde: el semanal sale el jueves
  // (la semana ya está completa) y el mensual el día 5. Se lanza cada hora ese día
  // y el siguiente: lo que decide es la reserva por proyecto y periodo, así que un
  // reinicio del worker a esa hora no deja a nadie sin informe.
  @Cron('0 9-23 * * 4,5', { name: 'seo.report-weekly', timeZone: 'Europe/Madrid' })
  async weekly(): Promise<void> {
    await this.run('weekly');
  }

  @Cron('0 9-23 5,6 * *', { name: 'seo.report-monthly', timeZone: 'Europe/Madrid' })
  async monthly(): Promise<void> {
    await this.run('monthly');
  }

  private async run(kind: 'weekly' | 'monthly'): Promise<void> {
    try {
      const res = await this.reports.sendDueAll(kind);
      if (res.projects > 0) this.logger.log(`SEO: informe ${kind} ${res.sent}/${res.projects}`);
    } catch (err) {
      this.logger.error(`Informe SEO ${kind}: ${(err as Error).message}`);
    }
  }
}
