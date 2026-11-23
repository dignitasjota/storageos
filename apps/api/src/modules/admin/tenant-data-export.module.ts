import { Module } from '@nestjs/common';

import { TenantDataExportJobsService } from './tenant-data-export-jobs.service';
import { TenantDataExportService } from './tenant-data-export.service';

/**
 * Exportación de los datos de un tenant (Excel). Ligero a propósito: lo
 * importan el panel admin (pedirla e historial) y los informes (el procesador
 * de la cola `reports`, que en producción corre en el worker).
 */
@Module({
  providers: [TenantDataExportService, TenantDataExportJobsService],
  exports: [TenantDataExportService, TenantDataExportJobsService],
})
export class TenantDataExportModule {}
