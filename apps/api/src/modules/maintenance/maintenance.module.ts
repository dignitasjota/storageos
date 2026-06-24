import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';

import { MaintenanceController } from './maintenance.controller';
import { MaintenanceCron } from './maintenance.cron';
import { MaintenanceService } from './maintenance.service';

/**
 * Mantenimiento recurrente: plantillas que generan tareas automáticamente. El
 * cron solo se monta donde corren los workers (en el worker en producción).
 */
@Module({
  imports: [AuthModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService, ...(WORKERS_ENABLED_IN_API ? [MaintenanceCron] : [])],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
