import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { StaleChargesService } from './stale-charges.service';

/**
 * Cada 15 minutos cierra los cobros que se quedaron en curso sin respuesta de
 * la pasarela (ver `StaleChargesService`). Idempotente: cada cierre es una
 * transición condicionada, así que dos réplicas a la vez no duplican nada.
 * Solo se registra con `ENABLE_WORKERS_IN_API=true` (corre en el worker).
 */
@Injectable()
export class StaleChargesCron {
  private readonly logger = new Logger(StaleChargesCron.name);

  constructor(private readonly stale: StaleChargesService) {}

  @Cron('*/15 * * * *', { name: 'payments.stale-charges' })
  async run(): Promise<void> {
    const r = await this.stale.run();
    if (r.resolved || r.failed || r.expiredRedsysOrders) {
      this.logger.log(
        `[stale-charges] ${r.resolved} resueltos, ${r.failed} sin cargo, ${r.expiredRedsysOrders} órdenes de Redsys caducadas`,
      );
    }
  }
}
