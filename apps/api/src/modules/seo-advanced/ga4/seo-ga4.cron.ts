import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SeoGa4Service } from './seo-ga4.service';

/**
 * Descarga diaria del tráfico orgánico de GA4 de los proyectos SEO (PR 12),
 * después de la de GA4 de Marketing (06:45) y de Search Console (07:00).
 */
@Injectable()
export class SeoGa4Cron {
  private readonly logger = new Logger(SeoGa4Cron.name);

  constructor(
    private readonly ga4: SeoGa4Service,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('20 7 * * *', { name: 'seo.ga4-daily' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo.ga4-daily'))) return;
      const res = await this.ga4.syncAllDue();
      if (res.projects > 0)
        this.logger.log(`GA4 de SEO: ${res.synced}/${res.projects} proyecto(s)`);
    } catch (err) {
      this.logger.error(`Cron de GA4 de SEO falló: ${(err as Error).message}`);
    }
  }
}
