import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PaymentRetryService } from './payment-retry.service';

/**
 * Reintenta a diario el cobro automático de las facturas vencidas (con backoff
 * por tenant). Solo se registra cuando `ENABLE_WORKERS_IN_API=true` (corre en el
 * worker en producción).
 */
@Injectable()
export class PaymentRetryCron {
  private readonly logger = new Logger(PaymentRetryCron.name);

  constructor(private readonly retries: PaymentRetryService) {}

  @Cron('0 9 * * *', { name: 'payments.auto-retry' })
  async run(): Promise<{ attempted: number; recovered: number }> {
    const result = await this.retries.runRetries();
    if (result.attempted > 0) {
      this.logger.log(
        `[payment-retry] ${result.attempted} reintentos, ${result.recovered} recuperados`,
      );
    }
    return result;
  }
}
