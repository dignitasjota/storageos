import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ReservationsService } from './reservations.service';

/**
 * Caduca las reservas cuyo `valid_until` ya pasó y **libera el trastero**
 * (reserved → available) si la reserva lo tenía retenido. Cubre tanto las
 * reservas formales como el «reservar para un cliente hasta el día Y» manual
 * desde la ficha del trastero, que de otro modo quedaría `reserved` para
 * siempre si el cliente no llega a firmar.
 *
 * Solo se registra cuando `ENABLE_WORKERS_IN_API=true` (corre en el worker en
 * producción, junto al resto de crons).
 */
@Injectable()
export class ReservationExpiryCron {
  private readonly logger = new Logger(ReservationExpiryCron.name);

  constructor(private readonly reservations: ReservationsService) {}

  @Cron('0 */2 * * *', { name: 'reservations.expiry' })
  async run(): Promise<{ expired: number }> {
    const result = await this.reservations.expireDueAll();
    if (result.expired > 0) {
      this.logger.log(`[reservations] ${result.expired} reservas caducadas liberadas`);
    }
    return result;
  }
}
