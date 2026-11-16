import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PrismaService } from '../database/prisma.service';

import { ReferralsService } from './referrals.service';

import type { CustomerReferralCodeDto, ReferralDto, ReferralStatsDto } from '@storageos/shared';

/** Panel de staff: lista y métricas de referidos. */
@Controller('referrals')
export class ReferralsController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly prisma: PrismaService,
  ) {}

  @RequirePermission('referrals:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ReferralDto[]> {
    return this.referrals.list(user.tenantId, user.facilityScope ?? null);
  }

  @RequirePermission('referrals:read')
  @Get('stats')
  stats(@CurrentUser() user: AuthenticatedUser): Promise<ReferralStatsDto> {
    return this.referrals.stats(user.tenantId, user.facilityScope ?? null);
  }

  /** Código de referido de un inquilino, para dárselo en mano. */
  @RequirePermission('referrals:read')
  @UseGuards(CustomerScopeGuard)
  @Get('customers/:customerId/code')
  async customerCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<CustomerReferralCodeDto> {
    const exists = await this.prisma.withTenant(
      (tx) => tx.customer.count({ where: { id: customerId, deletedAt: null } }),
      user.tenantId,
    );
    if (exists === 0) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    return this.referrals.codeForStaff(user.tenantId, customerId);
  }
}
