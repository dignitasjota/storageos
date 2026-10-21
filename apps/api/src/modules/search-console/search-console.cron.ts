import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SearchConsoleService } from './search-console.service';
import { SeoReportService } from './seo-report.service';

/**
 * Descarga cada día las búsquedas de los tenants con Search Console conectado
 * y, el día 3 de cada mes, envía el informe del mes anterior.
 */
@Injectable()
export class SearchConsoleCron {
  private readonly logger = new Logger(SearchConsoleCron.name);

  constructor(
    private readonly gsc: SearchConsoleService,
    private readonly report: SeoReportService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('30 6 * * *', { name: 'search-console.daily' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'search-console.daily'))) return;
      const res = await this.gsc.syncAllDue();
      if (res.tenants > 0)
        this.logger.log(`Search Console: ${res.synced}/${res.tenants} tenant(s)`);
    } catch (err) {
      this.logger.error(`Cron de Search Console falló: ${(err as Error).message}`);
    }
  }

  @Cron('0 9 3 * *', { name: 'seo-report.monthly' })
  async monthly(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo-report.monthly'))) return;
      const res = await this.report.sendDueAll();
      if (res.tenants > 0) this.logger.log(`Informe de SEO: ${res.sent}/${res.tenants} tenant(s)`);
    } catch (err) {
      this.logger.error(`Cron del informe de SEO falló: ${(err as Error).message}`);
    }
  }
}
