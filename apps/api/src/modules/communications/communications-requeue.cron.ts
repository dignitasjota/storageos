import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CommunicationsService } from './communications.service';

/**
 * Vuelve a encolar los envíos que se quedaron en «Pendiente» sin trabajo en la
 * cola. Corre donde se despachan los envíos (el worker en producción).
 */
@Injectable()
export class CommunicationsRequeueCron {
  private readonly logger = new Logger(CommunicationsRequeueCron.name);

  constructor(private readonly communications: CommunicationsService) {}

  @Cron('*/10 * * * *', { name: 'communications.requeue-stuck' })
  async tick(): Promise<void> {
    try {
      await this.communications.requeueStuck();
    } catch (err) {
      this.logger.error(`No se pudieron reencolar envíos: ${(err as Error).message}`);
    }
  }
}
