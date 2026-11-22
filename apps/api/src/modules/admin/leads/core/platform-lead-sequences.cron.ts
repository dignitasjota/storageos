import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PlatformLeadSequencesService } from './platform-lead-sequences.service';

/**
 * Cada 15 minutos manda los pasos de las secuencias de correos que tocan. Cada
 * paso se reserva antes de enviarlo, así que con varias réplicas no se repite.
 * Solo se registra con `ENABLE_WORKERS_IN_API=true` (en producción, el worker).
 */
@Injectable()
export class PlatformLeadSequencesCron {
  private readonly logger = new Logger(PlatformLeadSequencesCron.name);

  constructor(private readonly sequences: PlatformLeadSequencesService) {}

  @Cron('*/15 * * * *', { name: 'platform-leads.sequences', timeZone: 'Europe/Madrid' })
  async run(): Promise<void> {
    try {
      const res = await this.sequences.runDue();
      if (res.sent || res.stopped) {
        this.logger.log(`[leads] secuencias: ${res.sent} enviados, ${res.stopped} paradas`);
      }
    } catch (err) {
      this.logger.error(`[leads] secuencias: ${String(err)}`);
    }
  }
}
