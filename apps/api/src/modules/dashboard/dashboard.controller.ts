import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateTenantTodaySnoozeSchema,
  DailySummaryPrefsSchema,
  permissionsForRole,
  SkipOnboardingStepSchema,
  UpdateOnboardingStateSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AccessCredentialsService } from '../access/access-credentials.service';
import { AuditService } from '../auth/audit.service';

import { DailySummaryService } from './daily-summary.service';
import { OnboardingTestRunService } from './onboarding-test-run.service';
import { OnboardingService } from './onboarding.service';
import { TodayExtrasService } from './today-extras.service';
import { TodaySummaryService } from './today-summary.service';
import { TodayService } from './today.service';

import type {
  DailySummaryPrefs,
  OnboardingDto,
  OnboardingTestRunDto,
  TenantTodaySnoozeDto,
  TodayDeskAccessDto,
  TodayDto,
  TodayExtrasDto,
  TodaySummaryDto,
} from '@storageos/shared';
import type { Request } from 'express';

class CreateTodaySnoozeDto extends createZodDto(CreateTenantTodaySnoozeSchema) {}
class UpdateDailySummaryPrefsDto extends createZodDto(DailySummaryPrefsSchema) {}
class SkipOnboardingStepDto extends createZodDto(SkipOnboardingStepSchema) {}
class UpdateOnboardingStateDto extends createZodDto(UpdateOnboardingStateSchema) {}

function testRunMeta(req: Request) {
  return {
    ...(req.ip ? { ipAddress: req.ip } : {}),
    ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bandeja operativa del día para el panel del tenant. */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly today: TodayService,
    private readonly onboarding: OnboardingService,
    private readonly testRun: OnboardingTestRunService,
    private readonly summary: TodaySummaryService,
    private readonly dailySummary: DailySummaryService,
    private readonly extras: TodayExtrasService,
    private readonly credentials: AccessCredentialsService,
    private readonly audit: AuditService,
  ) {}

  /** Envía ahora el resumen del día al usuario que lo pide (prueba desde el perfil). */
  @RequirePermission('contracts:read')
  @Post('today/daily-summary/test')
  @HttpCode(200)
  async sendDailySummaryTest(@CurrentUser() user: AuthenticatedUser): Promise<{ sent: boolean }> {
    const n = await this.dailySummary.sendForTenant(user.tenantId, user.sub);
    return { sent: n > 0 };
  }

  @RequirePermission('contracts:read')
  @Get('today')
  async getToday(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('mine') mine?: string,
    @Query('full') full?: string,
  ): Promise<TodayDto> {
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.today.getToday(user.tenantId, {
      facilityId: facilityId || undefined,
      facilityScope: user.facilityScope ?? null,
      userId: user.sub,
      mine: mine === '1' || mine === 'true',
      full: full === '1',
      permissions: user.permissions ?? permissionsForRole(user.role),
    });
  }

  /** Cifras del mes y actividad de las últimas 48 h (cabecera de «Hoy»). */
  @RequirePermission('contracts:read')
  @Get('today/summary')
  async getTodaySummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<TodaySummaryDto> {
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.summary.summary(
      user.tenantId,
      facilityId || undefined,
      user.facilityScope ?? null,
      user.permissions ?? permissionsForRole(user.role),
    );
  }

  /** Checklist de primeros pasos del operador. */
  @RequirePermission('facilities:manage')
  @Get('onboarding')
  async getOnboarding(@CurrentUser() user: AuthenticatedUser): Promise<OnboardingDto> {
    return this.onboarding.getOnboarding(user.tenantId);
  }

  /** Punto de partida y paso por el asistente de primer acceso. */
  @RequirePermission('facilities:manage')
  @Put('onboarding/state')
  async updateOnboardingState(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateOnboardingStateDto,
  ): Promise<OnboardingDto> {
    return this.onboarding.setState(user.tenantId, body);
  }

  /** Crea el inquilino de prueba con el email de quien lo pide. */
  @RequirePermission('facilities:manage')
  @Post('onboarding/test-run')
  async startTestRun(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<OnboardingTestRunDto> {
    return this.testRun.start(user.tenantId, user.sub, testRunMeta(req));
  }

  /** Borra el inquilino de prueba y libera su trastero. */
  @RequirePermission('facilities:manage')
  @Delete('onboarding/test-run')
  @HttpCode(204)
  async removeTestRun(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    await this.testRun.remove(user.tenantId, user.sub, testRunMeta(req));
  }

  /** Marca un paso como «no aplica» (o lo devuelve a pendiente). */
  @RequirePermission('facilities:manage')
  @Put('onboarding/steps/:key')
  async skipOnboardingStep(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() body: SkipOnboardingStepDto,
  ): Promise<OnboardingDto> {
    return this.onboarding.setSkipped(user.tenantId, key, body.skipped);
  }

  /** Lo que completa la bandeja: avisos, deuda por inquilino, mañana, la semana y lo hecho hoy. */
  @Get('today/extras')
  @RequirePermission('contracts:read')
  async getTodayExtras(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('mine') mine?: string,
  ): Promise<TodayExtrasDto> {
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({
        code: 'invalid_facility_id',
        message: 'Local no válido',
      });
    }
    return this.extras.extras(user.tenantId, {
      facilityId: facilityId || undefined,
      facilityScope: user.facilityScope ?? null,
      userId: user.sub,
      mine: mine === '1' || mine === 'true',
      permissions: user.permissions ?? permissionsForRole(user.role),
    });
  }

  @Post('today/snoozes')
  @RequirePermission('tasks:write')
  snooze(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTodaySnoozeDto,
  ): Promise<TenantTodaySnoozeDto> {
    return this.extras.snooze(user.tenantId, user.sub, body);
  }

  @Delete('today/snoozes/:id')
  @HttpCode(204)
  @RequirePermission('tasks:write')
  unsnooze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.extras.unsnooze(user.tenantId, id);
  }

  /** El código de acceso de un inquilino para dárselo en el mostrador (queda registrado). */
  @Get('today/desk/customers/:customerId/access')
  @RequirePermission('access:manage')
  @RequireFeature('access_control')
  async deskAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Req() req: Request,
  ): Promise<TodayDeskAccessDto> {
    const rows = await this.credentials.listForCustomer(user.tenantId, customerId);
    await this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action: 'access.code_viewed',
      entityType: 'Customer',
      entityId: customerId,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return {
      credentials: rows.map((r) => ({
        id: r.id,
        method: r.method,
        label: r.label,
        value: r.value,
      })),
    };
  }

  @Get('me/daily-summary')
  async dailySummaryPrefs(@CurrentUser() user: AuthenticatedUser): Promise<DailySummaryPrefs> {
    return this.dailySummary.getPrefs(user.tenantId, user.sub);
  }

  @Put('me/daily-summary')
  async setDailySummaryPrefs(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateDailySummaryPrefsDto,
  ): Promise<DailySummaryPrefs> {
    return this.dailySummary.setPrefs(user.tenantId, user.sub, body);
  }
}
