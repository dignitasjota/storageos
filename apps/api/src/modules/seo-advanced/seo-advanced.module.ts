import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { SearchConsoleModule } from '../search-console/search-console.module';

import { SeoGscSyncService } from './seo-gsc-sync.service';
import { SeoGscCron } from './seo-gsc.cron';
import { SeoGscProcessor } from './seo-gsc.processor';
import { SeoProjectsService } from './seo-projects.service';

/**
 * SEO Avanzado, el núcleo: proyectos, dominios y descargas de Search Console de
 * la plataforma y de los tenants con el extra. La cola `seo` y la descarga
 * diaria corren en el worker (`WORKERS_ENABLED_IN_API`). Las rutas, el panel y
 * la importación de Excel van en `SeoAdvancedHttpModule` (solo en el API: el
 * worker no las necesita ni lleva sus dependencias de lectura de ficheros).
 */
@Module({
  imports: [SearchConsoleModule],
  providers: [
    SeoProjectsService,
    SeoGscSyncService,
    ...(WORKERS_ENABLED_IN_API ? [SeoGscProcessor, SeoGscCron] : []),
  ],
  exports: [SeoProjectsService, SeoGscSyncService],
})
export class SeoAdvancedModule {}
