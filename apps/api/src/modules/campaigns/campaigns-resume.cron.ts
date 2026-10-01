import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CampaignsService } from './campaigns.service';

/**
 * Retoma las campañas atascadas en «enviando» (el API se reinició mientras
 * encolaba los correos). Corre en el API, donde se envían; cada campaña se
 * reclama de forma atómica, así que con varias réplicas no se duplica.
 */
@Injectable()
export class CampaignsResumeCron {
  private readonly logger = new Logger(CampaignsResumeCron.name);

  constructor(private readonly campaigns: CampaignsService) {}

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    try {
      await this.campaigns.resumeStale();
    } catch (err) {
      this.logger.error(`No se pudieron retomar campañas: ${(err as Error).message}`);
    }
  }
}
