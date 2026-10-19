import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { OnboardingService } from './onboarding.service';
import { TodaySummaryService } from './today-summary.service';
import { TodayService } from './today.service';

import type { OnboardingDto, TodayDto, TodaySummaryDto } from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bandeja operativa del día para el panel del tenant. */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly today: TodayService,
    private readonly onboarding: OnboardingService,
    private readonly summary: TodaySummaryService,
  ) {}

  @RequirePermission('contracts:read')
  @Get('today')
  async getToday(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<TodayDto> {
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.today.getToday(user.tenantId, facilityId || undefined, user.facilityScope ?? null);
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
    return this.summary.summary(user.tenantId, facilityId || undefined, user.facilityScope ?? null);
  }

  /** Checklist de primeros pasos del operador. */
  @RequirePermission('settings:read')
  @Get('onboarding')
  async getOnboarding(@CurrentUser() user: AuthenticatedUser): Promise<OnboardingDto> {
    return this.onboarding.getOnboarding(user.tenantId);
  }
}
