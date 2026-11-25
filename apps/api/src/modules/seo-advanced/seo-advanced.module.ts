import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AdminGuard } from '../admin/admin.guard';
import { SearchConsoleModule } from '../search-console/search-console.module';

import { AdminSeoController } from './admin-seo.controller';
import { SeoAdvancedController } from './seo-advanced.controller';
import { SeoGscSyncService } from './seo-gsc-sync.service';
import { SeoGscCron } from './seo-gsc.cron';
import { SeoGscProcessor } from './seo-gsc.processor';
import { SeoProjectsService } from './seo-projects.service';

/**
 * SEO Avanzado: proyectos, dominios y descargas de Search Console de la
 * plataforma (panel admin) y de los tenants con el extra. La cola `seo` y la
 * descarga diaria corren en el worker (`WORKERS_ENABLED_IN_API`).
 */
@Module({
  imports: [JwtModule.register({}), SearchConsoleModule],
  controllers: [SeoAdvancedController, AdminSeoController],
  providers: [
    SeoProjectsService,
    SeoGscSyncService,
    AdminGuard,
    ...(WORKERS_ENABLED_IN_API ? [SeoGscProcessor, SeoGscCron] : []),
  ],
  exports: [SeoGscSyncService],
})
export class SeoAdvancedModule {}
