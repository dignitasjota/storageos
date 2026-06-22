import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { RentIncreasesService } from './rent-increases.service';

/**
 * Aplica las tandas ECRI programadas cuya fecha efectiva ya llegó: sube el
 * precio de cada contrato y la siguiente factura recurrente sale al precio
 * nuevo. Idempotente (solo items `pending`).
 *
 * Sub-bloque 14A.1: solo se registra cuando `ENABLE_WORKERS_IN_API=true`
 * (corre en el worker en producción).
 */
@Injectable()
export class RentIncreaseApplyCron {
  private readonly logger = new Logger(RentIncreaseApplyCron.name);

  constructor(private readonly service: RentIncreasesService) {}

  @Cron('0 6 * * *', { name: 'rent-increases.apply' })
  async run(): Promise<{ applied: number }> {
    const res = await this.service.applyDue();
    if (res.applied > 0) this.logger.log(`[rent-increase] tandas aplicadas hoy: ${res.applied}`);
    return res;
  }
}
