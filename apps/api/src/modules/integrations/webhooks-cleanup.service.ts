import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { WebhooksService } from './webhooks.service';

import type { Env } from '../../config/env.schema';

/**
 * Cron diario para purgar `webhook_deliveries` antiguos. Se ejecuta a las
 * 04:00 UTC (1h después del cleanup de `security_events` para no solapar
 * picos de IO en BD). Aislado en clase propia para mantener
 * `WebhooksService` sin dependencias de `@nestjs/schedule` y poder
 * condicionar su registro con `WORKERS_ENABLED_IN_API`.
 *
 * Retención configurable via `WEBHOOK_DELIVERIES_RETENTION_DAYS` (default 30).
 */
@Injectable()
export class WebhooksCleanupService {
  private readonly logger = new Logger(WebhooksCleanupService.name);

  constructor(
    private readonly service: WebhooksService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Cron('0 4 * * *', { name: 'webhooks.deliveries.cleanup' })
  async dailyCleanup(): Promise<void> {
    const retentionDays = this.config.get('WEBHOOK_DELIVERIES_RETENTION_DAYS', { infer: true });
    try {
      const { deleted } = await this.service.cleanupDeliveries(retentionDays);
      if (deleted > 0) {
        this.logger.log(
          `webhook_deliveries cleanup: borrados ${deleted} deliveries > ${retentionDays} dias`,
        );
      }
    } catch (err) {
      this.logger.error(
        `webhook_deliveries cleanup fallo: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
