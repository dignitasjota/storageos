import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';

import { MarketingChannelsService } from './marketing-channels.service';
import { MarketingPublicController } from './marketing-public.controller';
import { MarketingRenewalsCron } from './marketing-renewals.cron';
import { MarketingController } from './marketing.controller';

/**
 * Control de marketing: catálogo de canales/campañas de captación (portales
 * inmobiliarios, Google/Meta Ads, publicidad física...) + coste vinculado
 * (`expenses`) + rendimiento (coste↔leads↔conversión↔MRR) + enlace
 * corto/QR con contador de clics para campañas físicas + avisos de
 * renovación.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [MarketingController, MarketingPublicController],
  providers: [MarketingChannelsService, MarketingRenewalsCron],
  exports: [MarketingChannelsService],
})
export class MarketingModule {}
