import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { WhatsappBookingRemindersService } from './whatsapp-booking-reminders.service';

/**
 * Cada hora: recordatorio por WhatsApp de las reservas del asistente sin
 * terminar y seguimiento de quien preguntó y no reservó. Solo con `ENABLE_WORKERS_IN_API=true` (en producción, el worker).
 */
@Injectable()
export class WhatsappBookingRemindersCron {
  private readonly logger = new Logger(WhatsappBookingRemindersCron.name);

  constructor(private readonly reminders: WhatsappBookingRemindersService) {}

  @Cron('45 * * * *', { name: 'whatsapp.booking-reminders' })
  async run(): Promise<void> {
    const sent = await this.reminders.sendDue();
    if (sent > 0) this.logger.log(`[whatsapp] ${sent} recordatorios de reserva enviados`);
    const followups = await this.reminders.sendFollowups();
    if (followups > 0) this.logger.log(`[whatsapp] ${followups} seguimientos enviados`);
  }
}
