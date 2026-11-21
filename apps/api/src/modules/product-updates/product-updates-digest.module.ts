import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { ProductUpdatesDigestCron } from './product-updates-digest.cron';
import { ProductUpdatesDigestService } from './product-updates-digest.service';

/**
 * Resumen mensual de «Novedades» por correo. Módulo aparte y ligero para que
 * el worker lo cargue; el cron solo se monta donde corren los workers.
 */
@Module({
  providers: [
    ProductUpdatesDigestService,
    ...(WORKERS_ENABLED_IN_API ? [ProductUpdatesDigestCron] : []),
  ],
  exports: [ProductUpdatesDigestService],
})
export class ProductUpdatesDigestModule {}
