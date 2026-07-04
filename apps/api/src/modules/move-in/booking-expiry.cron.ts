import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SignaturesService } from './signatures.service';

/**
 * Cancela los contratos de booking self-service del portal cuya 1ª factura no
 * se pagó en plazo (`first_payment_deadline`): libera la unidad y anula la
 * factura. Evita el «contrato zombi» que ocupa inventario y entra en dunning
 * sin que el inquilino haya pagado ni tenga acceso.
 *
 * Solo se registra cuando `ENABLE_WORKERS_IN_API=true` (corre en el worker en
 * producción, junto al resto de crons).
 */
@Injectable()
export class BookingExpiryCron {
  private readonly logger = new Logger(BookingExpiryCron.name);

  constructor(private readonly signatures: SignaturesService) {}

  @Cron('0 */6 * * *', { name: 'move-in.booking-expiry' })
  async run(): Promise<{ cancelled: number }> {
    const result = await this.signatures.expireUnpaidBookings();
    if (result.cancelled > 0) {
      this.logger.log(`[move-in] ${result.cancelled} bookings impagados cancelados`);
    }
    return result;
  }
}
