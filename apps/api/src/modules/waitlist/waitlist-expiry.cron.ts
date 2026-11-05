import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { WaitlistService } from './waitlist.service';

/**
 * Cada hora: caduca los avisos de la lista de espera sin respuesta, avisa al
 * siguiente, repasa las colas con trasteros libres, avisa al equipo de quien no
 * responde y pregunta a quien lleva mucho tiempo si sigue buscando.
 */
@Injectable()
export class WaitlistExpiryCron {
  private readonly logger = new Logger(WaitlistExpiryCron.name);

  constructor(private readonly waitlist: WaitlistService) {}

  @Cron('20 * * * *', { name: 'waitlist.notice-expiry' })
  async run(): Promise<void> {
    try {
      const { expired } = await this.waitlist.expireStaleNotifications();
      if (expired > 0) this.logger.log(`Avisos de lista de espera caducados: ${expired}`);
      const { notified } = await this.waitlist.notifyWaitingWithFreeUnits();
      if (notified > 0) this.logger.log(`Lista de espera: avisos por trastero libre: ${notified}`);
      await this.waitlist.clearStalePreassignments();
      await this.waitlist.alertNoReplies();
      const { asked, removed } = await this.waitlist.reviewStaleEntries();
      if (asked + removed > 0) {
        this.logger.log(`Lista de espera: preguntados ${asked}, fuera de la cola ${removed}`);
      }
    } catch (err) {
      this.logger.error(`waitlist.notice-expiry falló: ${(err as Error).message}`);
    }
  }
}
