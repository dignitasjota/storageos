import { Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminOpsHealthService } from './admin-ops-health.service';
import { AdminUsageService } from './admin-usage.service';
import { AdminGuard } from './admin.guard';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { StorageUsageService } from './storage-usage.service';

import type { AdminBillingHealthDto, AdminCronStatusDto, AdminUsageDto } from '@storageos/shared';

/** Salud operativa: facturación de los tenants y tareas programadas. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminOpsHealthController {
  constructor(
    private readonly health: AdminOpsHealthService,
    private readonly usage: AdminUsageService,
    private readonly storage: StorageUsageService,
  ) {}

  /** Correo, IA y almacenamiento por tenant en los últimos `days` días. */
  @Get('usage')
  getUsage(@Query('days') days?: string): Promise<AdminUsageDto> {
    return this.usage.getUsage(days ? Number(days) : 30);
  }

  /** Vuelve a medir el almacenamiento de todos los tenants. */
  @Post('usage/measure-storage')
  @HttpCode(200)
  @RequireSuperadmin()
  measureStorage(): Promise<{ tenants: number; bytes: number }> {
    return this.storage.measure();
  }

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

  /** Quita de la lista una tarea que ya no existe (si existe, reaparece al arrancar). */
  @RequireSuperadmin()
  @AdminAudit('admin.cron.removed')
  @Delete('crons/:name')
  @HttpCode(200)
  removeCron(@Param('name') name: string): Promise<{ removed: number }> {
    return this.health.removeCron(name);
  }
}
