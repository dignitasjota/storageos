import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { CampaignInsightsService } from './campaign-insights.service';
import { CampaignsService } from './campaigns.service';

/**
 * Retoma las campañas atascadas en «enviando» (el API se reinició mientras
 * encolaba los correos). Corre en el API, donde se envían; cada campaña se
 * reclama de forma atómica, así que con varias réplicas no se duplica.
 */
@Injectable()
export class CampaignsResumeCron {
  private readonly logger = new Logger(CampaignsResumeCron.name);

  constructor(
    private readonly campaigns: CampaignsService,
    private readonly insights: CampaignInsightsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('*/5 * * * *', { name: 'campaigns.resume' })
  async tick(): Promise<void> {
    try {
      await this.campaigns.resumeStale();
      await this.campaigns.dispatchScheduled();
    } catch (err) {
      this.logger.error(`No se pudieron retomar campañas: ${(err as Error).message}`);
    }
  }

  /** Guarda los resultados de las campañas antes de que la limpieza borre sus envíos. */
  @Cron('30 3 * * *', { name: 'campaigns.results-snapshot' })
  async snapshot(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'campaigns.results-snapshot'))) return;
      await this.insights.snapshotOld();
    } catch (err) {
      this.logger.error(`No se pudieron guardar resultados: ${(err as Error).message}`);
    }
  }
}
