import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { MarketingSummaryService } from './marketing-summary.service';

/**
 * El día 4 de cada mes envía «Tu marketing en <mes>» (GA4 y Search Console
 * ya tienen los datos del mes completo).
 */
@Injectable()
export class MarketingSummaryCron {
  private readonly logger = new Logger(MarketingSummaryCron.name);

  constructor(
    private readonly summary: MarketingSummaryService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 9 4 * *', { name: 'marketing-summary.monthly' })
  async monthly(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'marketing-summary.monthly'))) return;
      const res = await this.summary.sendDueAll();
      if (res.tenants > 0) {
        this.logger.log(`Resumen de marketing: ${res.sent}/${res.tenants} tenant(s)`);
      }
    } catch (err) {
      this.logger.error(`Cron del resumen de marketing falló: ${(err as Error).message}`);
    }
  }
}
