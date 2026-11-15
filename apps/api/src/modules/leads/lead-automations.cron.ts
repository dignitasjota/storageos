import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LeadNurtureService } from './lead-nurture.service';
import { LeadQuotesService } from './lead-quotes.service';
import { LeadVisitsService } from './lead-visits.service';

/**
 * Cada hora: el 2.º y 3.er correo automático a los contactos de la web, el
 * recordatorio de los presupuestos sin reservar y el de las visitas de
 * mañana. Cada envío se reserva con un `updateMany` condicionado, así que
 * varias réplicas no lo duplican.
 */
@Injectable()
export class LeadAutomationsCron {
  private readonly logger = new Logger(LeadAutomationsCron.name);

  constructor(
    private readonly nurture: LeadNurtureService,
    private readonly quotes: LeadQuotesService,
    private readonly visits: LeadVisitsService,
  ) {}

  @Cron('25 * * * *', { name: 'leads.automations' })
  async run(): Promise<void> {
    for (const [label, job] of [
      ['secuencia de correos', () => this.nurture.runDue()],
      ['recordatorio de presupuestos', () => this.quotes.sendReminders()],
      ['recordatorio de visitas', () => this.visits.sendReminders()],
    ] as const) {
      try {
        const n = await job();
        if (n > 0) this.logger.log(`Contactos — ${label}: ${n}`);
      } catch (err) {
        this.logger.error(`Contactos — ${label} falló: ${(err as Error).message}`);
      }
    }
  }
}
