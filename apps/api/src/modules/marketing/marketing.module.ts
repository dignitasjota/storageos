import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AiModule } from '../ai/ai.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QUEUE_EMAIL } from '../queues/queue-names';

import { AdCampaignDraftController } from './ad-campaign-draft.controller';
import { AdPerformanceService } from './ad-platforms/ad-performance.service';
import { AdSpendSyncCron } from './ad-platforms/ad-spend-sync.cron';
import { AdSpendSyncService } from './ad-platforms/ad-spend-sync.service';
import { GoogleAdsSettingsService } from './ad-platforms/google-ads-settings.service';
import { GoogleAdsController } from './ad-platforms/google-ads.controller';
import { MetaAdsSettingsService } from './ad-platforms/meta-ads-settings.service';
import { MetaAdsController } from './ad-platforms/meta-ads.controller';
import { CatalogFeedController } from './catalog-feed.controller';
import { CatalogFeedService } from './catalog-feed.service';
import { Ga4Client } from './ga4/ga4.client';
import { Ga4Controller } from './ga4/ga4.controller';
import { Ga4Cron } from './ga4/ga4.cron';
import { Ga4Service } from './ga4/ga4.service';
import { MarketingChannelsService } from './marketing-channels.service';
import { MarketingPublicController } from './marketing-public.controller';
import { MarketingRenewalsCron } from './marketing-renewals.cron';
import { MarketingController } from './marketing.controller';
import { MarketingSummaryController } from './summary/marketing-summary.controller';
import { MarketingSummaryCron } from './summary/marketing-summary.cron';
import { MarketingSummaryService } from './summary/marketing-summary.service';
import { WebAnalyticsController, WebAnalyticsPublicController } from './web-analytics.controller';
import { WebAnalyticsService } from './web-analytics.service';

/**
 * Control de marketing: catálogo de canales/campañas de captación (portales
 * inmobiliarios, Google/Meta Ads, publicidad física...) + coste vinculado
 * (`expenses`) + rendimiento (coste↔leads↔conversión↔MRR) + enlace
 * corto/QR con contador de clics para campañas físicas + avisos de
 * renovación + sincronización automática de gasto (Google Ads/Meta Ads,
 * credenciales pegadas a mano por el tenant).
 */
@Module({
  imports: [NotificationsModule, AiModule, BullModule.registerQueue({ name: QUEUE_EMAIL })],
  controllers: [
    MarketingController,
    MarketingPublicController,
    GoogleAdsController,
    MetaAdsController,
    CatalogFeedController,
    AdCampaignDraftController,
    WebAnalyticsController,
    WebAnalyticsPublicController,
    Ga4Controller,
    MarketingSummaryController,
  ],
  providers: [
    MarketingChannelsService,
    MarketingRenewalsCron,
    GoogleAdsSettingsService,
    MetaAdsSettingsService,
    AdSpendSyncService,
    AdPerformanceService,
    CatalogFeedService,
    WebAnalyticsService,
    Ga4Client,
    Ga4Service,
    MarketingSummaryService,
    ...(WORKERS_ENABLED_IN_API ? [AdSpendSyncCron, Ga4Cron, MarketingSummaryCron] : []),
  ],
  exports: [MarketingChannelsService],
})
export class MarketingModule {}
