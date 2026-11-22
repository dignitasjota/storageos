import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { TenantHealthCron } from './tenant-health.cron';
import { TenantHealthService } from './tenant-health.service';

/**
 * Salud de los clientes y activación de las pruebas. Módulo ligero para que lo
 * importen `AdminModule` (las páginas) y el worker (la foto diaria).
 */
@Module({
  providers: [TenantHealthService, ...(WORKERS_ENABLED_IN_API ? [TenantHealthCron] : [])],
  exports: [TenantHealthService],
})
export class TenantHealthModule {}
