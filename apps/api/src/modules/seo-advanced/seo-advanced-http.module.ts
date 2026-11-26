import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';

import { AdminSeoController } from './admin-seo.controller';
import {
  AdminSeoDiagnosticsController,
  SeoAdvancedDiagnosticsController,
} from './diagnostics/seo-diagnostics.controller';
import { SeoDiagnosticsService } from './diagnostics/seo-diagnostics.service';
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
import { SeoSiteChangesService } from './plan/seo-site-changes.service';
import { SeoTasksService } from './plan/seo-tasks.service';
import { SeoAdvancedController } from './seo-advanced.controller';
import { SeoAdvancedModule } from './seo-advanced.module';
import { SeoImportsService } from './seo-imports.service';
import { SeoPanelService } from './seo-panel.service';
import {
  AdminSeoSistrixController,
  SistrixCallbackController,
} from './sistrix/admin-seo-sistrix.controller';
import { SeoAdvancedSistrixController } from './sistrix/seo-advanced-sistrix.controller';
import { SeoSistrixDataService } from './sistrix/seo-sistrix-data.service';
import { SeoSistrixService } from './sistrix/seo-sistrix.service';
import { SistrixOAuthService } from './sistrix/sistrix-oauth.service';

/**
 * SEO Avanzado en el API: las rutas del tenant (`/seo-advanced`) y del panel
 * admin (`/admin/seo`), el panel con sus agregaciones, la importación de los
 * Excel históricos de Search Console, SISTRIX (integraciones, OAuth y sus
 * datos por proyecto), las oportunidades y el diagnóstico (palabras seguidas,
 * canibalización e indexación), el plan (actuaciones con su antes y después
 * y tareas SEO) y la importación de los Excel maestros.
 */
@Module({
  imports: [JwtModule.register({}), SeoAdvancedModule],
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
    SeoSiteChangesService,
    SeoTasksService,
    SeoMasterImportService,
  ],
})
export class SeoAdvancedHttpModule {}
