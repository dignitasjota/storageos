import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { UnitCessionsService } from './unit-cessions.service';

/**
 * Avisos al equipo de las cesiones que vencen. Cada hora, para llegar a tiempo
 * en la zona de cada local; cada aviso se reserva una vez por cesión. Solo se
 * registra donde corren los workers (en el worker en producción).
 */
@Injectable()
export class UnitCessionsCron {
  constructor(private readonly service: UnitCessionsService) {}

  @Cron('25 * * * *', { name: 'unit-cessions.notices' })
  async run(): Promise<{ expiring: number; expired: number }> {
    return this.service.sendNotices();
  }
}
