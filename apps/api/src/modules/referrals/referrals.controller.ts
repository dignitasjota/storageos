import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ReferralsService } from './referrals.service';

import type { ReferralDto, ReferralStatsDto } from '@storageos/shared';

/** Panel de staff: lista y métricas de referidos. */
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @RequirePermission('referrals:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ReferralDto[]> {
    return this.referrals.list(user.tenantId);
  }

  @RequirePermission('referrals:read')
  @Get('stats')
  stats(@CurrentUser() user: AuthenticatedUser): Promise<ReferralStatsDto> {
    return this.referrals.stats(user.tenantId);
  }
}
