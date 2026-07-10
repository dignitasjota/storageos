import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { RetentionService } from './retention.service';

/**
 * Revierte los descuentos de retención cuyo periodo (`months`) ya venció → la
 * cuota vuelve a precio completo. Sin esto, el descuento de una contraoferta
 * aceptada sería perpetuo (v1 lo aplicaba como `discountAmount` recurrente sin
 * fecha de fin).
 *
 * Solo se registra cuando `ENABLE_WORKERS_IN_API=true` (corre en el worker en
 * producción, junto al resto de crons).
 */
@Injectable()
export class RetentionDiscountExpiryCron {
  private readonly logger = new Logger(RetentionDiscountExpiryCron.name);

  constructor(private readonly retention: RetentionService) {}

  @Cron('0 4 * * *', { name: 'retention.discount-expiry' })
  async run(): Promise<{ reverted: number }> {
    const result = await this.retention.revertExpiredDiscounts();
    if (result.reverted > 0) {
      this.logger.log(`[retention] ${result.reverted} descuentos de retención revertidos`);
    }
    return result;
  }
}
