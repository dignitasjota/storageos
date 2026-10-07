import { Controller, Get, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminOpsHealthService } from './admin-ops-health.service';
import { AdminGuard } from './admin.guard';

import type { AdminBillingHealthDto, AdminCronStatusDto } from '@storageos/shared';

/** Salud operativa: facturación de los tenants y tareas programadas. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminOpsHealthController {
  constructor(private readonly health: AdminOpsHealthService) {}

  /** Veri*Factu y Holded por tenant + facturas con problema. */
  @Get('billing-health')
  billingHealth(): Promise<AdminBillingHealthDto> {
    return this.health.billingHealth();
  }

  /** Última ejecución y siguiente prevista de cada tarea programada. */
  @Get('crons')
  crons(): Promise<AdminCronStatusDto[]> {
    return this.health.crons();
  }
}
