import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { PlatformAlertLogService } from '../admin/platform-alert-log.service';
import { PlatformAlertsService } from '../admin/platform-alerts.service';
import { SearchConsoleModule } from '../search-console/search-console.module';

import { SeoOpportunityEngineService } from './opportunities/seo-opportunity-engine.service';
import { SeoOpportunityScheduler } from './opportunities/seo-opportunity-scheduler';
import {
  GscSeoProvider,
  ManualImportProvider,
  SeoProviderRegistry,
  SistrixApiProvider,
  SistrixMcpProvider,
} from './providers/seo-data-provider';
import { SeoGscSyncService } from './seo-gsc-sync.service';
import { SeoGscCron } from './seo-gsc.cron';
import { SeoGscProcessor } from './seo-gsc.processor';
import { SeoProjectsService } from './seo-projects.service';
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

import type { Env } from '../../config/env.schema';

/**
 * SEO Avanzado, el núcleo: proyectos, dominios y descargas de Search Console de
 * la plataforma y de los tenants con el extra, y SISTRIX (MCP de la plataforma
 * y API clásica) con su arquitectura de proveedores y sus tandas, y el motor
 * de oportunidades (se recalcula tras cada descarga). Las colas
 * `seo` y `seo-sistrix` y las tareas programadas corren en el worker
 * (`WORKERS_ENABLED_IN_API`). Las rutas, el panel, la importación de Excel y
 * el OAuth de SISTRIX van en `SeoAdvancedHttpModule` (solo en el API: el
 * worker no las necesita ni lleva sus dependencias de lectura de ficheros).
 */
@Module({
  imports: [SearchConsoleModule],
  providers: [
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
    SeoOpportunityEngineService,
    ...(WORKERS_ENABLED_IN_API ? [SeoGscProcessor, SeoGscCron, SistrixProcessor, SistrixCron] : []),
  ],
  exports: [
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
  ],
})
export class SeoAdvancedModule {}
