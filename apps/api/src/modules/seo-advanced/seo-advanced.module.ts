import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { PlatformAlertLogService } from '../admin/platform-alert-log.service';
import { PlatformAlertsService } from '../admin/platform-alerts.service';
import { Ga4Client } from '../marketing/ga4/ga4.client';
import { NotificationsModule } from '../notifications/notifications.module';
import { SearchConsoleModule } from '../search-console/search-console.module';

import { SeoCrawlFetcher } from './crawler/seo-crawl-fetcher';
import { SeoCrawlCron } from './crawler/seo-crawl.cron';
import { SeoCrawlProcessor } from './crawler/seo-crawl.processor';
import { SeoCrawlerService } from './crawler/seo-crawler.service';
import { SeoDiagnosticsEngineService } from './diagnostics/seo-diagnostics-engine.service';
import { SeoGa4Cron } from './ga4/seo-ga4.cron';
import { SeoGa4Service } from './ga4/seo-ga4.service';
import { SeoAutoStartService } from './improvements/seo-auto-start.service';
import { SeoZonesService } from './improvements/seo-zones.service';
import { SeoOpportunityEngineService } from './opportunities/seo-opportunity-engine.service';
import { SeoOpportunityScheduler } from './opportunities/seo-opportunity-scheduler';
import { SeoPlanCron } from './plan/seo-plan.cron';
import { SeoSiteChangesService } from './plan/seo-site-changes.service';
import { SeoTaskNoticesService } from './plan/seo-task-notices.service';
import {
  GscSeoProvider,
  ManualImportProvider,
  SeoProviderRegistry,
  SistrixApiProvider,
  SistrixMcpProvider,
} from './providers/seo-data-provider';
import { SeoAlertsService } from './reports/seo-alerts.service';
import { SeoConversionsService } from './reports/seo-conversions.service';
import { SeoReportsCron } from './reports/seo-reports.cron';
import { SeoReportsService } from './reports/seo-reports.service';
import { SeoDomainOwnershipService } from './seo-domain-ownership.service';
import { SeoGscSyncService } from './seo-gsc-sync.service';
import { SeoGscCron } from './seo-gsc.cron';
import { SeoGscProcessor } from './seo-gsc.processor';
import { SeoProjectsService } from './seo-projects.service';
import { SeoAiVisibilityService } from './sistrix/seo-ai-visibility.service';
import { SistrixApiClient } from './sistrix/sistrix-api.client';
import { SistrixConnectionsService } from './sistrix/sistrix-connections.service';
import { SistrixFetchService } from './sistrix/sistrix-fetch.service';
import { SistrixMcpClient } from './sistrix/sistrix-mcp.client';
import {
  SISTRIX_MCP_GATEWAY,
  SdkSistrixMcpGateway,
  StubSistrixMcpGateway,
} from './sistrix/sistrix-mcp.gateway';
import { SistrixSyncService } from './sistrix/sistrix-sync.service';
import { SistrixCron } from './sistrix/sistrix.cron';
import { SistrixProcessor } from './sistrix/sistrix.processor';
import { PageSpeedClient } from './technical/pagespeed.client';
import { SeoInspectionService } from './technical/seo-inspection.service';
import { SeoPageSpeedProcessor } from './technical/seo-pagespeed.processor';
import { SeoPageSpeedService } from './technical/seo-pagespeed.service';
import { SeoTechnicalReadService } from './technical/seo-technical-read.service';
import { SeoTechnicalCron } from './technical/seo-technical.cron';

import type { Env } from '../../config/env.schema';

/**
 * SEO Avanzado, el núcleo: proyectos, dominios y descargas de Search Console de
 * la plataforma y de los tenants con el extra, y SISTRIX (MCP de la plataforma
 * y API clásica) con su arquitectura de proveedores y sus tandas, el motor
 * de oportunidades y el diagnóstico (canibalización e indexación), que se
 * recalculan tras cada descarga, los avisos de las tareas SEO del plan y, de la
 * PR 8, las conversiones de Google, las alertas y los informes, y de la PR 9
 * la inspección de URL de Google y PageSpeed, y de la PR 10 el rastreador
 * de las webs. Las colas `seo`, `seo-sistrix` y `seo-crawl` y las tareas
 * programadas corren en el worker
 * (`WORKERS_ENABLED_IN_API`). Las rutas, el panel, la importación de Excel y
 * el OAuth de SISTRIX van en `SeoAdvancedHttpModule` (solo en el API: el
 * worker no las necesita ni lleva sus dependencias de lectura de ficheros).
 */
@Module({
  imports: [SearchConsoleModule, NotificationsModule],
  providers: [
    SeoDomainOwnershipService,
    SeoProjectsService,
    SeoGscSyncService,
    PlatformAlertsService,
    PlatformAlertLogService,
    {
      provide: SISTRIX_MCP_GATEWAY,
      inject: [ConfigService],
      // En tests o con `SISTRIX_MODE=stub`, el servidor MCP simulado.
      useFactory: (config: ConfigService<Env, true>) =>
        process.env.NODE_ENV === 'test' || config.get('SISTRIX_MODE', { infer: true }) === 'stub'
          ? new StubSistrixMcpGateway()
          : new SdkSistrixMcpGateway(),
    },
    SistrixConnectionsService,
    SistrixMcpClient,
    SistrixApiClient,
    GscSeoProvider,
    SistrixMcpProvider,
    SistrixApiProvider,
    ManualImportProvider,
    SeoProviderRegistry,
    SistrixFetchService,
    SistrixSyncService,
    SeoOpportunityScheduler,
    SeoZonesService,
    SeoAutoStartService,
    SeoOpportunityEngineService,
    SeoDiagnosticsEngineService,
    SeoTaskNoticesService,
    SeoSiteChangesService,
    SeoConversionsService,
    SeoAlertsService,
    SeoReportsService,
    SeoTechnicalReadService,
    PageSpeedClient,
    SeoInspectionService,
    SeoPageSpeedService,
    SeoCrawlFetcher,
    SeoCrawlerService,
    // PR 12: GA4 del tráfico orgánico (el mismo cliente que Marketing).
    Ga4Client,
    SeoGa4Service,
    SeoAiVisibilityService,
    ...(WORKERS_ENABLED_IN_API
      ? [
          SeoGscProcessor,
          SeoGscCron,
          SistrixProcessor,
          SistrixCron,
          SeoPlanCron,
          SeoReportsCron,
          SeoTechnicalCron,
          SeoPageSpeedProcessor,
          SeoCrawlProcessor,
          SeoCrawlCron,
          SeoGa4Cron,
        ]
      : []),
  ],
  exports: [
    SeoZonesService,
    SeoDomainOwnershipService,
    SeoProjectsService,
    SeoGscSyncService,
    SeoProviderRegistry,
    SistrixConnectionsService,
    SistrixMcpClient,
    SistrixApiClient,
    SistrixFetchService,
    SistrixSyncService,
    SeoOpportunityScheduler,
    SeoOpportunityEngineService,
    SeoDiagnosticsEngineService,
    SeoTaskNoticesService,
    SeoSiteChangesService,
    SeoConversionsService,
    SeoAlertsService,
    SeoReportsService,
    SeoTechnicalReadService,
    SeoInspectionService,
    SeoPageSpeedService,
    SeoCrawlFetcher,
    SeoCrawlerService,
    SeoGa4Service,
    SeoAiVisibilityService,
  ],
})
export class SeoAdvancedModule {}
