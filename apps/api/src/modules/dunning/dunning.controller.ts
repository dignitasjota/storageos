import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { invoiceFacilityWhere } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';

import type { DunningActionDto } from '@storageos/shared';

const STATUSES = ['scheduled', 'executed', 'failed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

@Controller('dunning')
export class DunningController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermission('invoices:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ): Promise<DunningActionDto[]> {
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
    }
    // Solo los avisos de facturas de los locales del usuario.
    const invoice = invoiceFacilityWhere(user.facilityScope ?? null) ?? {};
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.dunningAction.findMany({
          where: {
            ...(status ? { status: status as Status } : {}),
            ...(Object.keys(invoice).length ? { invoice } : {}),
          },
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
