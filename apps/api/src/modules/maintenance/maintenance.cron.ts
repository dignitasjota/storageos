import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { MaintenanceService } from './maintenance.service';

/**
 * Genera a diario las tareas de los planes de mantenimiento recurrente cuya
 * próxima ejecución ya venció. Solo se registra cuando
 * `ENABLE_WORKERS_IN_API=true` (corre en el worker en producción).
 */
@Injectable()
export class MaintenanceCron {
  constructor(private readonly service: MaintenanceService) {}

  @Cron('0 6 * * *', { name: 'maintenance.generate' })
  async run(): Promise<{ generated: number }> {
    return this.service.generateDue();
  }
}
