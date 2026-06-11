import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { StripeEventsService } from './stripe-events.service';

/**
 * Cron diario que purga `processed_stripe_events` antiguos. Aislado en su
 * propia clase (patron `SecurityAlertsCron`) para registrarlo solo cuando
 * `WORKERS_ENABLED_IN_API=true` sin condicionar el service.
 */
@Injectable()
export class StripeEventsCleanupCron {
  private readonly logger = new Logger(StripeEventsCleanupCron.name);

  constructor(private readonly events: StripeEventsService) {}

  @Cron('0 4 * * *', { name: 'stripe-events.cleanup' })
  async run(): Promise<void> {
    try {
      await this.events.cleanupOldEvents();
    } catch (err) {
      this.logger.error(
        `stripe-events.cleanup fallo: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
