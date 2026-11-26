import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';
import { AiModule } from '../ai/ai.module';
import { BlogModule } from '../blog/blog.module';
import { LandingModule } from '../landing/landing.module';
import { PlatformBlogModule } from '../platform-blog/platform-blog.module';

import { AdminSeoController } from './admin-seo.controller';
import { SeoAssistantActionsService } from './assistant/seo-assistant-actions.service';
import { SeoAssistantToolsService } from './assistant/seo-assistant-tools.service';
import {
  AdminSeoAssistantController,
  AdminSeoBriefsController,
  SeoAdvancedAssistantController,
  SeoAdvancedBriefsController,
} from './assistant/seo-assistant.controller';
import { SeoAssistantService } from './assistant/seo-assistant.service';
import { SeoBriefsService } from './assistant/seo-briefs.service';
import { SeoCrawlViewsService } from './crawler/seo-crawl-views.service';
import {
  AdminSeoCrawlController,
  SeoAdvancedCrawlController,
} from './crawler/seo-crawl.controller';
import {
  AdminSeoDiagnosticsController,
  SeoAdvancedDiagnosticsController,
} from './diagnostics/seo-diagnostics.controller';
import { SeoDiagnosticsService } from './diagnostics/seo-diagnostics.service';
import { AdminSeoGa4Controller, SeoAdvancedGa4Controller } from './ga4/seo-ga4.controller';
import {
  AdminSeoMasterImportController,
  SeoAdvancedMasterImportController,
} from './master/seo-master-import.controller';
import { SeoMasterImportService } from './master/seo-master-import.service';
import {
  AdminSeoOpportunitiesController,
  SeoAdvancedOpportunitiesController,
} from './opportunities/seo-opportunities.controller';
import { SeoOpportunitiesService } from './opportunities/seo-opportunities.service';
import { AdminSeoPlanController, SeoAdvancedPlanController } from './plan/seo-plan.controller';
import { SeoTasksService } from './plan/seo-tasks.service';
import { SeoAlertsCron } from './reports/seo-alerts.cron';
import {
  AdminSeoReportsController,
  SeoAdvancedReportsController,
} from './reports/seo-reports.controller';
import { SeoAdvancedController } from './seo-advanced.controller';
import { SeoAdvancedModule } from './seo-advanced.module';
import { SeoImportsService } from './seo-imports.service';
import { SeoPanelService } from './seo-panel.service';
import {
  AdminSeoSistrixController,
  SistrixCallbackController,
} from './sistrix/admin-seo-sistrix.controller';
import { SeoAdvancedSistrixController } from './sistrix/seo-advanced-sistrix.controller';
import {
  AdminSeoAiVisibilityController,
  SeoAdvancedAiVisibilityController,
} from './sistrix/seo-ai-visibility.controller';
import { SeoSistrixDataService } from './sistrix/seo-sistrix-data.service';
import { SeoSistrixService } from './sistrix/seo-sistrix.service';
import { SistrixOAuthService } from './sistrix/sistrix-oauth.service';
import {
  AdminSeoTechnicalController,
  SeoAdvancedTechnicalController,
} from './technical/seo-technical.controller';

/**
 * SEO Avanzado en el API: las rutas del tenant (`/seo-advanced`) y del panel
 * admin (`/admin/seo`), el panel con sus agregaciones, la importación de los
 * Excel históricos de Search Console, SISTRIX (integraciones, OAuth y sus
 * datos por proyecto), las oportunidades y el diagnóstico (palabras seguidas,
 * canibalización e indexación), el plan (actuaciones con su antes y después
 * y tareas SEO), la importación de los Excel maestros y, de la PR 8, lo que
 * trae Google, las alertas y los informes, y de la PR 9 la inspección de URL
 * de Google y PageSpeed, de la PR 10 el rastreador de las webs y, de la PR 11,
 * el asistente de SEO y los borradores de contenido.
 */
@Module({
  imports: [
    JwtModule.register({}),
    SeoAdvancedModule,
    // PR 11: el asistente (bucle con el modelo y cuota), el blog del tenant y
    // el de la plataforma (borradores desde un brief) y los datos públicos del negocio.
    AiModule,
    BlogModule,
    PlatformBlogModule,
    LandingModule,
  ],
  controllers: [
    SeoAdvancedController,
    AdminSeoController,
    SeoAdvancedSistrixController,
    AdminSeoSistrixController,
    SistrixCallbackController,
    SeoAdvancedOpportunitiesController,
    AdminSeoOpportunitiesController,
    SeoAdvancedDiagnosticsController,
    AdminSeoDiagnosticsController,
    SeoAdvancedPlanController,
    AdminSeoPlanController,
    SeoAdvancedMasterImportController,
    AdminSeoMasterImportController,
    SeoAdvancedReportsController,
    AdminSeoReportsController,
    SeoAdvancedTechnicalController,
    AdminSeoTechnicalController,
    SeoAdvancedCrawlController,
    AdminSeoCrawlController,
    SeoAdvancedAssistantController,
    AdminSeoAssistantController,
    SeoAdvancedBriefsController,
    AdminSeoBriefsController,
    SeoAdvancedGa4Controller,
    AdminSeoGa4Controller,
    SeoAdvancedAiVisibilityController,
    AdminSeoAiVisibilityController,
  ],
  providers: [
    AdminGuard,
    SeoPanelService,
    SeoImportsService,
    SistrixOAuthService,
    SeoSistrixService,
    SeoSistrixDataService,
    SeoOpportunitiesService,
    SeoDiagnosticsService,
    SeoTasksService,
    SeoMasterImportService,
    SeoCrawlViewsService,
    SeoAssistantActionsService,
    SeoAssistantToolsService,
    SeoAssistantService,
    SeoBriefsService,
    // Alertas cada hora: en el API (los avisos por chat de la plataforma salen del panel admin).
    SeoAlertsCron,
  ],
})
export class SeoAdvancedHttpModule {}
