import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PlatformDunningService } from './platform-dunning.service';

/**
 * Cron diario del dunning del SaaS. Sin gatear por `WORKERS_ENABLED_IN_API`
 * (es ligero y no depende de BullMQ, igual que las alertas de plataforma);
 * corre en el proceso API.
 */
@Injectable()
export class PlatformDunningCron {
  private readonly logger = new Logger(PlatformDunningCron.name);

  constructor(private readonly dunning: PlatformDunningService) {}

  @Cron('0 8 * * *')
  async daily(): Promise<void> {
    try {
      await this.dunning.run();
    } catch (err) {
      this.logger.error(`Dunning cron falló: ${(err as Error).message}`);
    }
  }
}
