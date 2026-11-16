import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AdConversionsService } from './ad-conversions.service';

/**
 * Cada 30 minutos manda a Google Ads y a Meta los contratos firmados de quien
 * llegó por un anuncio. Llama a servicios externos → solo en el worker. Dos
 * réplicas no mandan dos veces: cada envío se reserva antes.
 */
@Injectable()
export class AdConversionsCron {
  private readonly logger = new Logger(AdConversionsCron.name);

  constructor(private readonly conversions: AdConversionsService) {}

  @Cron('*/30 * * * *', { name: 'marketing.ad-conversions' })
  async run(): Promise<void> {
    try {
      const r = await this.conversions.runAll();
      if (r.sent || r.failed) {
        this.logger.log(`[ad-conversions] enviadas ${r.sent}, fallidas ${r.failed}`);
      }
    } catch (err) {
      this.logger.error(`Envío de conversiones falló: ${(err as Error).message}`);
    }
  }
}
