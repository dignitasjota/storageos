import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LeadCrmService } from './lead-crm.service';

/**
 * Cada hora avisa de los contactos nuevos sin atender pasado el plazo del
 * tenant. Corre en el API: cada contacto se reserva con un `updateMany`
 * condicionado, así que varias réplicas no duplican el aviso.
 */
@Injectable()
export class LeadUnattendedCron {
  private readonly logger = new Logger(LeadUnattendedCron.name);

  constructor(private readonly crm: LeadCrmService) {}

  @Cron('20 * * * *', { name: 'leads.unattended' })
  async run(): Promise<void> {
    try {
      const n = await this.crm.notifyUnattended();
      if (n > 0) this.logger.log(`Contactos sin atender avisados: ${n}`);
    } catch (err) {
      this.logger.error(`Aviso de contactos sin atender falló: ${(err as Error).message}`);
    }
  }
}
