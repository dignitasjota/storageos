import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SecurityEventsService } from './security-events.service';

/**
 * Cron diario para borrar eventos de seguridad mas viejos de 90 dias.
 * Se ejecuta a las 03:00 UTC. Aislado en su propia clase para mantener
 * `SecurityEventsService` sin dependencias de `@nestjs/schedule`.
 */
@Injectable()
export class SecurityEventsCleanupService {
  private readonly logger = new Logger(SecurityEventsCleanupService.name);

  constructor(private readonly service: SecurityEventsService) {}

  @Cron('0 3 * * *', { name: 'security-events.cleanup' })
  async dailyCleanup(): Promise<void> {
    try {
      const { deleted } = await this.service.cleanup(90);
      if (deleted > 0) {
        this.logger.log(`security_events cleanup: borrados ${deleted} eventos > 90 dias`);
      }
    } catch (err) {
      this.logger.error(
        `security_events cleanup fallo: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
