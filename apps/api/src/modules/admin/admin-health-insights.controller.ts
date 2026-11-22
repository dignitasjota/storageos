import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminBulkFollowupsSchema,
  UpdatePlatformHealthSettingsSchema,
  type AdminAdoptionInsightsDto,
  type AdminBulkFollowupsResultDto,
  type AdminPlatformHealthSettingsDto,
  type AdminTenantHealthHistoryDto,
  type AdminUpgradeCandidatesDto,
  type AdminUsageEvolutionDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { parseMonthsParam } from '../../common/saas-metrics';

import { AdminAudit } from './admin-audit.decorator';
import { AdminHealthInsightsService } from './admin-health-insights.service';
import { AdminUsageService } from './admin-usage.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { PlatformHealthSettingsService } from './health-settings.service';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { TenantHealthService } from './tenant-health.service';

import type { Request } from 'express';

class UpdatePlatformHealthSettingsDto extends createZodDto(UpdatePlatformHealthSettingsSchema) {}
class AdminBulkFollowupsDto extends createZodDto(AdminBulkFollowupsSchema) {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Salud, Adopción y Uso: ajustes (pesos, aviso de caída, consumo anómalo),
 * historial de salud, candidatos a vender, matriz y bajas por función,
 * evolución del uso y seguimientos en lote. Lectura: superadmin y soporte;
 * cambiar los ajustes, solo superadmin. El rol comercial no entra.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminHealthInsightsController {
  constructor(
    private readonly settings: PlatformHealthSettingsService,
    private readonly health: TenantHealthService,
    private readonly insights: AdminHealthInsightsService,
    private readonly usage: AdminUsageService,
  ) {}

  @Get('health-settings')
  getSettings(): Promise<AdminPlatformHealthSettingsDto> {
    return this.settings.get();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.health_settings.updated')
  @Put('health-settings')
  async updateSettings(
    @Body() body: UpdatePlatformHealthSettingsDto,
  ): Promise<AdminPlatformHealthSettingsDto> {
    const r = await this.settings.update(body);
    // Los pesos cambian la puntuación: se vuelve a calcular.
    this.health.clearCache();
    return r;
  }

  /** Evolución de la salud de un tenant (12 meses y 90 días). */
  @Get('tenants/:id/health/history')
  history(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantHealthHistoryDto> {
    return this.health.history(id);
  }

  /** Candidatos a subir de plan o contratar un extra, con el ingreso extra estimado. */
  @Get('adoption/candidates')
  candidates(): Promise<AdminUpgradeCandidatesDto> {
    return this.insights.candidates();
  }

  /** Matriz función × plan, bajas por función y funciones que casi nadie usa. */
  @Get('adoption/insights')
  adoptionInsights(): Promise<AdminAdoptionInsightsDto> {
    return this.insights.insights();
  }

  /** Evolución mensual del uso (de todos o de un tenant) y previsión del almacenamiento. */
  @Get('usage/evolution')
  evolution(
    @Query('tenantId') tenantId?: string,
    @Query('months') months?: string,
  ): Promise<AdminUsageEvolutionDto> {
    const id = tenantId && UUID_RE.test(tenantId) ? tenantId : null;
    return this.usage.evolution(id, parseMonthsParam(months, 12, 24));
  }

  /** El mismo seguimiento en varios tenants (también el rol soporte). */
  @Post('tenants/bulk-followups')
  @HttpCode(HttpStatus.OK)
  bulkFollowups(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: AdminBulkFollowupsDto,
    @Req() req: Request,
  ): Promise<AdminBulkFollowupsResultDto> {
    return this.insights.bulkFollowups(body, {
      superAdminId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
