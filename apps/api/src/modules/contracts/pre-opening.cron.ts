import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PreOpeningService } from './pre-opening.service';

/**
 * Cada hora: empiezan las reservas de los locales que abren hoy (en su hora)
 * y se avisa a las que abren en 3 días. Solo con `ENABLE_WORKERS_IN_API` (en
 * producción, en el worker).
 */
@Injectable()
export class PreOpeningCron {
  private readonly logger = new Logger(PreOpeningCron.name);

  constructor(private readonly preOpening: PreOpeningService) {}

  @Cron('15 * * * *', { name: 'contracts.pre-opening' })
  async run(): Promise<void> {
    try {
      const { started, reminded } = await this.preOpening.runDue();
      if (started + reminded > 0)
        this.logger.log(`Reservas antes de la apertura: ${started} empiezan, ${reminded} avisadas`);
    } catch (err) {
      this.logger.error(`contracts.pre-opening falló: ${(err as Error).message}`);
    }
  }
}
