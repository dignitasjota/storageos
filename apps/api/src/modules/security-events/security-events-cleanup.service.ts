import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { SecurityEventsService } from './security-events.service';

import type { Env } from '../../config/env.schema';

/**
 * Cron diario para borrar eventos de seguridad pasado `RETENTION_SECURITY_EVENTS_DAYS`.
 * Se ejecuta a las 03:00 UTC. Aislado en su propia clase para mantener
 * `SecurityEventsService` sin dependencias de `@nestjs/schedule`.
 */
@Injectable()
export class SecurityEventsCleanupService {
  private readonly logger = new Logger(SecurityEventsCleanupService.name);

  constructor(
    private readonly service: SecurityEventsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Cron('0 3 * * *', { name: 'security-events.cleanup' })
  async dailyCleanup(): Promise<void> {
    try {
      const days = this.config.get('RETENTION_SECURITY_EVENTS_DAYS', { infer: true });
      const { deleted } = await this.service.cleanup(days);
      if (deleted > 0) {
        this.logger.log(`security_events cleanup: borrados ${deleted} eventos > ${days} dias`);
      }
    } catch (err) {
      this.logger.error(
        `security_events cleanup fallo: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
