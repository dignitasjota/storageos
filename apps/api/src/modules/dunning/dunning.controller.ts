import { Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';

import type { DunningActionDto } from '@storageos/shared';

@Controller('dunning')
export class DunningController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ): Promise<DunningActionDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.dunningAction.findMany({
          where: status
            ? { status: status as 'scheduled' | 'executed' | 'failed' | 'cancelled' }
            : {},
          orderBy: { scheduledFor: 'desc' },
          include: { invoice: { select: { invoiceNumber: true } } },
          take: 200,
        }),
      user.tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoice.invoiceNumber,
      actionType: r.actionType,
      status: r.status,
      scheduledFor: r.scheduledFor.toISOString(),
      executedAt: r.executedAt ? r.executedAt.toISOString() : null,
      notes: r.notes,
    }));
  }
}
