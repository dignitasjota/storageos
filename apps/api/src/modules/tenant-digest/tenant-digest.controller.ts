import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { UpdateMonthlyDigestSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { TenantMonthlyDigestService } from './tenant-monthly-digest.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  TenantMonthlyDigestResultDto,
  TenantMonthlyDigestSettingsResponse,
} from '@storageos/shared';

class UpdateMonthlyDigestDto extends createZodDto(UpdateMonthlyDigestSchema) {}

@Controller('settings/tenant/monthly-digest')
export class TenantDigestController {
  constructor(private readonly digest: TenantMonthlyDigestService) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<TenantMonthlyDigestSettingsResponse> {
    return this.digest.getSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateMonthlyDigestDto,
  ): Promise<TenantMonthlyDigestSettingsResponse> {
    return this.digest.updateSettings(user.tenantId, body.enabled);
  }

  /** Envía el informe del mes pasado ahora mismo (no espera al cron). */
  @RequirePermission('settings:manage')
  @Post('run')
  run(@CurrentUser() user: AuthenticatedUser): Promise<TenantMonthlyDigestResultDto> {
    return this.digest.sendForTenant(user.tenantId);
  }
}
