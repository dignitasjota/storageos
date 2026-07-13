import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { BookingRecoveryService } from './booking-recovery.service';

/**
 * Recordatorio de reservas abandonadas: cada hora recuerda a los leads de
 * booking self-service `new` sin convertir (1-72 h) para recuperar la reserva.
 * Solo se registra cuando `ENABLE_WORKERS_IN_API=true` (corre en el worker en
 * producción, junto al resto de crons).
 */
@Injectable()
export class BookingRecoveryCron {
  private readonly logger = new Logger(BookingRecoveryCron.name);

  constructor(private readonly recovery: BookingRecoveryService) {}

  @Cron('0 * * * *', { name: 'move-in.booking-recovery' })
  async run(): Promise<{ reminded: number }> {
    const result = await this.recovery.sendDueReminders();
    if (result.reminded > 0) {
      this.logger.log(`[booking-recovery] ${result.reminded} recordatorios enviados`);
    }
    return result;
  }
}
