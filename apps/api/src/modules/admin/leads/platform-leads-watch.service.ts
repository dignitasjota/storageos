import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';

import {
  PLATFORM_LEAD_INBOUND,
  PLATFORM_TENANT_REGISTERED,
  type PlatformLeadInboundEvent,
  type PlatformTenantRegisteredEvent,
} from '../../../common/platform-lead-events';
import { ChatAlertsService } from '../chat-alerts.service';

import { PlatformLeadsService } from './platform-leads.service';

/**
 * Lo automático de los leads del panel admin: los mensajes de la web y las
 * cuentas nuevas entran solos, y cada 15 minutos se mueven las fases que marca
 * la cuenta (en prueba → cliente o perdido) y se avisa de los nuevos sin
 * atender. Corre en el API (ligero); cada cambio se reserva con una condición,
 * así que dos réplicas no lo hacen dos veces.
 */
@Injectable()
export class PlatformLeadsWatchService {
  private readonly logger = new Logger(PlatformLeadsWatchService.name);

  constructor(
    private readonly leads: PlatformLeadsService,
    private readonly chat: ChatAlertsService,
  ) {}

  @OnEvent(PLATFORM_LEAD_INBOUND)
  async onInbound(e: PlatformLeadInboundEvent): Promise<void> {
    try {
      await this.leads.ingestContact(e);
    } catch (err) {
      this.logger.error(`Mensaje de la web ${e.contactMessageId} sin lead: ${String(err)}`);
    }
  }

  @OnEvent(PLATFORM_TENANT_REGISTERED)
  async onTenant(e: PlatformTenantRegisteredEvent): Promise<void> {
    try {
      await this.leads.ingestTenant(e);
    } catch (err) {
      this.logger.error(`Tenant ${e.tenantId} sin lead: ${String(err)}`);
    }
  }

  @Cron('*/15 * * * *', { name: 'platform-leads.watch', timeZone: 'Europe/Madrid' })
  async watch(): Promise<void> {
    try {
      const moved = await this.leads.syncFromTenants();
      if (moved.customers || moved.lost) {
        this.logger.log(
          `[leads] ${moved.customers} pasan a cliente y ${moved.lost} a perdido (prueba sin contratar)`,
        );
      }
      for (const u of await this.leads.unattended()) {
        await this.chat.leadUnattended(u.name, u.hours, u.id);
      }
    } catch (err) {
      this.logger.error(`[leads] vigilancia: ${String(err)}`);
    }
  }
}
