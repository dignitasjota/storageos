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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AiConnectionTestDto,
  type AiUsageDto,
  type PlatformAiSettingsDto,
  type PlatformAiUsageDto,
  TestAiPromptSchema,
  UpdatePlatformAiSettingsSchema,
  UpdateTenantAiLimitSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { currentMonth } from '../../common/format';
import { OWN_KEY_AI_FEATURES } from '../../common/saas-metrics';
import { AdminGuard } from '../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AiQuotaService } from './ai-quota.service';
import { PlatformAiSettingsService } from './platform-ai-settings.service';

import type { Env } from '../../config/env.schema';
import type { Request } from 'express';

class UpdatePlatformAiSettingsBody extends createZodDto(UpdatePlatformAiSettingsSchema) {}
class UpdateTenantAiLimitBody extends createZodDto(UpdateTenantAiLimitSchema) {}

/**
 * Asistente IA del panel (panel admin): clave, modelo y límites de la
 * plataforma, y el consumo y límite de cada tenant. Leer: super admin y
 * soporte; cambiar: rol superadmin.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AiAdminController {
  constructor(
    private readonly settings: PlatformAiSettingsService,
    private readonly quota: AiQuotaService,
    private readonly audit: SuperAdminAuditService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Uso y coste estimado del mes (hora de España) con la clave de la
   * plataforma, previsión a fin de mes y los tenants que más gastan.
   */
  @Get('ai-settings/usage')
  async platformUsage(): Promise<PlatformAiUsageDto> {
    const month = currentMonth();
    const platformCalls = {
      ownKey: false,
      feature: { notIn: OWN_KEY_AI_FEATURES },
      createdAt: { gte: month.start },
    };
    const [tokens, queries, ownKeyQueries, byTenant] = await Promise.all([
      this.admin.aiUsageEvent.aggregate({
        where: { ...platformCalls, countsAsQuery: false },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.admin.aiUsageEvent.count({
        where: { countsAsQuery: true, ownKey: false, createdAt: { gte: month.start } },
      }),
      this.admin.aiUsageEvent.count({
        where: { countsAsQuery: true, ownKey: true, createdAt: { gte: month.start } },
      }),
      this.admin.aiUsageEvent.groupBy({
        by: ['tenantId'],
        where: { ...platformCalls, countsAsQuery: false },
        _sum: { inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
    ]);
    const inPrice = this.config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true });
    const outPrice = this.config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true });
    const cost = (i: number, o: number) => (i * inPrice + o * outPrice) / 1_000_000;
    const input = tokens._sum.inputTokens ?? 0;
    const output = tokens._sum.outputTokens ?? 0;
    const costUsd = cost(input, output);
    const now = Date.now();
    const elapsedDays = Math.max((now - month.start.getTime()) / 86_400_000, 1);
    const next = new Date(month.start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const monthDays = (next.getTime() - month.start.getTime()) / 86_400_000;
    const top = byTenant
      .map((t) => ({
        tenantId: t.tenantId,
        queries: t._count._all,
        costUsd: cost(t._sum.inputTokens ?? 0, t._sum.outputTokens ?? 0),
      }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 5);
    const names = await this.admin.tenant.findMany({
      where: { id: { in: top.map((t) => t.tenantId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const alertUsd = this.settings.monthlyCostAlertUsd;
    return {
      month: month.key,
      queries,
      ownKeyQueries,
      inputTokens: input,
      outputTokens: output,
      costUsd: round2(costUsd),
      projectedCostUsd: round2((costUsd / elapsedDays) * monthDays),
      alertUsd,
      overAlert: alertUsd != null && costUsd >= alertUsd,
      topTenants: top.map((t) => ({
        ...t,
        name: nameOf.get(t.tenantId) ?? '—',
        costUsd: round2(t.costUsd),
      })),
    };
  }

  @Get('ai-settings')
  async get(): Promise<PlatformAiSettingsDto> {
    await this.settings.refresh();
    return this.settings.get();
  }

  @RequireSuperadmin()
  @Put('ai-settings')
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: UpdatePlatformAiSettingsBody,
    @Req() req: Request,
  ): Promise<PlatformAiSettingsDto> {
    const result = await this.settings.update(body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.ai_settings.updated',
      targetType: 'PlatformAiSettings',
      changes: {
        keyChanged: body.apiKey !== undefined,
        keyRemoved: body.apiKey === '',
        model: body.model,
        monthlyQueryLimit: body.monthlyQueryLimit,
        dailyUserLimit: body.dailyUserLimit,
        portalDailyLimit: body.portalDailyLimit,
        webModel: body.webModel,
        webMonthlyLimit: body.webMonthlyLimit,
        webVisitorDailyLimit: body.webVisitorDailyLimit,
        monthlyCostAlertUsd: body.monthlyCostAlertUsd,
        planLimits: body.planLimits,
      },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }

  @RequireSuperadmin()
  @Post('ai-settings/test')
  @HttpCode(HttpStatus.OK)
  test(@Body() body: unknown): Promise<AiConnectionTestDto> {
    // Cuerpo opcional: sin él, solo comprueba la conexión.
    const parsed = TestAiPromptSchema.safeParse(body ?? {});
    return this.settings.test(parsed.success ? parsed.data.prompt || undefined : undefined);
  }

  @Get('tenants/:id/ai-usage')
  usage(@Param('id', ParseUUIDPipe) id: string): Promise<AiUsageDto> {
    return this.quota.usage(id);
  }

  @RequireSuperadmin()
  @Put('tenants/:id/ai-usage')
  async setLimit(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTenantAiLimitBody,
    @Req() req: Request,
  ): Promise<AiUsageDto> {
    const result = await this.quota.setTenantLimit(id, body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.ai_limit_changed',
      targetType: 'Tenant',
      targetId: id,
      targetTenantId: id,
      changes: {
        monthlyLimit: body.monthlyLimit,
        webMonthlyLimit: body.webMonthlyLimit,
        mode: body.mode,
      },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }
}
