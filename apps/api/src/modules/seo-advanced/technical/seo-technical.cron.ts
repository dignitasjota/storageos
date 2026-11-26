import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SeoInspectionService } from './seo-inspection.service';
import { SeoPageSpeedService } from './seo-pagespeed.service';

/**
 * Tareas de la PR 9 que corren en el worker (hora de España): el lote diario
 * de inspecciones de URL (06:30, solo los proyectos que lo activan), la cola
 * de inspecciones que ya pueden hacerse (cada hora: las que esperaban a que
 * se reiniciara la cuota) y la medición semanal de PageSpeed (lunes 04:30).
 */
@Injectable()
export class SeoTechnicalCron {
  private readonly logger = new Logger(SeoTechnicalCron.name);

  constructor(
    private readonly inspection: SeoInspectionService,
    private readonly pagespeed: SeoPageSpeedService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('30 6 * * *', { name: 'seo.inspection-batch', timeZone: 'Europe/Madrid' })
  async inspectionBatch(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo.inspection-batch'))) return;
      const res = await this.inspection.enqueueBatchesAll();
      if (res.queued > 0) {
        this.logger.log(`SEO: ${res.queued} inspección(es) de URL en ${res.projects} proyecto(s)`);
      }
    } catch (err) {
      this.logger.error(`Lote de inspecciones SEO: ${(err as Error).message}`);
    }
  }

  @Cron('20 * * * *', { name: 'seo.inspection-queue', timeZone: 'Europe/Madrid' })
  async inspectionQueue(): Promise<void> {
    try {
      await this.inspection.scheduleDue();
    } catch (err) {
      this.logger.error(`Cola de inspecciones SEO: ${(err as Error).message}`);
    }
  }

  @Cron('30 4 * * 1', { name: 'seo.pagespeed-weekly', timeZone: 'Europe/Madrid' })
  async pagespeedWeekly(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo.pagespeed-weekly'))) return;
      const res = await this.pagespeed.enqueueWeeklyAll();
      if (res.queued > 0) {
        this.logger.log(
          `SEO: ${res.queued} medición(es) de PageSpeed en ${res.projects} proyecto(s)`,
        );
      }
    } catch (err) {
      this.logger.error(`PageSpeed semanal: ${(err as Error).message}`);
    }
  }
}
