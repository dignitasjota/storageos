import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { TenantHealthService } from './tenant-health.service';

/**
 * Foto diaria de la salud de cada tenant (la del mes en curso, en hora de
 * España). Con ella Salud calcula la tendencia frente al mes pasado aunque
 * nadie abra la página; la consulta ya no escribe. Corre en el worker.
 */
@Injectable()
export class TenantHealthCron {
  private readonly logger = new Logger(TenantHealthCron.name);

  constructor(private readonly health: TenantHealthService) {}

  @Cron('20 3 * * *', { name: 'tenant-health.daily-snapshot', timeZone: 'Europe/Madrid' })
  async run(): Promise<void> {
    try {
      const n = await this.health.saveSnapshots();
      this.logger.log(`[salud] foto guardada de ${n} tenants`);
    } catch (err) {
      this.logger.error(`[salud] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
