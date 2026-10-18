import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { WaitlistService } from './waitlist.service';

/** Cada hora: caduca los avisos de la lista de espera sin respuesta y avisa al siguiente. */
@Injectable()
export class WaitlistExpiryCron {
  private readonly logger = new Logger(WaitlistExpiryCron.name);

  constructor(private readonly waitlist: WaitlistService) {}

  @Cron('20 * * * *', { name: 'waitlist.notice-expiry' })
  async run(): Promise<void> {
    try {
      const { expired } = await this.waitlist.expireStaleNotifications();
      if (expired > 0) this.logger.log(`Avisos de lista de espera caducados: ${expired}`);
    } catch (err) {
      this.logger.error(`waitlist.notice-expiry falló: ${(err as Error).message}`);
    }
  }
}
