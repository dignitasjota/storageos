import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { UnitCessionsService } from './unit-cessions.service';

/**
 * Avisos al propietario de las cesiones que vencen y recordatorio de las que
 * no tienen fecha de fin. Cada hora, para llegar a tiempo
 * en la zona de cada local; cada aviso se reserva una vez por cesión. Solo se
 * registra donde corren los workers (en el worker en producción).
 */
@Injectable()
export class UnitCessionsCron {
  constructor(private readonly service: UnitCessionsService) {}

  @Cron('25 * * * *', { name: 'unit-cessions.notices' })
  async run(): Promise<{ expiring: number; expired: number; reviews: number }> {
    return this.service.sendNotices();
  }
}
