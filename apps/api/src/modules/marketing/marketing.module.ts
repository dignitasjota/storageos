import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AiModule } from '../ai/ai.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { AdCampaignDraftController } from './ad-campaign-draft.controller';
import { AdSpendSyncCron } from './ad-platforms/ad-spend-sync.cron';
import { AdSpendSyncService } from './ad-platforms/ad-spend-sync.service';
import { GoogleAdsSettingsService } from './ad-platforms/google-ads-settings.service';
import { GoogleAdsController } from './ad-platforms/google-ads.controller';
import { MetaAdsSettingsService } from './ad-platforms/meta-ads-settings.service';
import { MetaAdsController } from './ad-platforms/meta-ads.controller';
import { CatalogFeedController } from './catalog-feed.controller';
import { CatalogFeedService } from './catalog-feed.service';
import { MarketingChannelsService } from './marketing-channels.service';
import { MarketingPublicController } from './marketing-public.controller';
import { MarketingRenewalsCron } from './marketing-renewals.cron';
import { MarketingController } from './marketing.controller';

/**
 * Control de marketing: catálogo de canales/campañas de captación (portales
 * inmobiliarios, Google/Meta Ads, publicidad física...) + coste vinculado
 * (`expenses`) + rendimiento (coste↔leads↔conversión↔MRR) + enlace
 * corto/QR con contador de clics para campañas físicas + avisos de
 * renovación + sincronización automática de gasto (Google Ads/Meta Ads,
 * credenciales pegadas a mano por el tenant).
 */
@Module({
  imports: [NotificationsModule, AiModule],
  controllers: [
    MarketingController,
    MarketingPublicController,
    GoogleAdsController,
    MetaAdsController,
    CatalogFeedController,
    AdCampaignDraftController,
  ],
  providers: [
    MarketingChannelsService,
    MarketingRenewalsCron,
    GoogleAdsSettingsService,
    MetaAdsSettingsService,
    AdSpendSyncService,
    CatalogFeedService,
    ...(WORKERS_ENABLED_IN_API ? [AdSpendSyncCron] : []),
  ],
  exports: [MarketingChannelsService],
})
export class MarketingModule {}
