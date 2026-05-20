import { Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { AdminMetricsDto } from '@storageos/shared';

type TenantStatusKey = 'trial' | 'active' | 'suspended' | 'cancelled';

/**
 * Metricas globales del SaaS para el dashboard del super admin.
 *
 * En el MVP el MRR se reporta como 0: el cobro real con Stripe Billing
 * (precios por plan + descuentos + impuestos) llega como sub-fase 8B. Aqui
 * dejamos el campo en el DTO para no romper contratos del frontend.
 */
@Injectable()
export class AdminMetricsService {
  constructor(private readonly admin: PrismaAdminService) {}

  async getOverview(): Promise<AdminMetricsDto> {
    const monthStart = startOfMonthUtc(new Date());

    const [statusGroups, signupsThisMonth, cancellationsThisMonth, totalAtMonthStart] =
      await Promise.all([
        this.admin.tenant.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        this.admin.tenant.count({
          where: { deletedAt: null, createdAt: { gte: monthStart } },
        }),
        this.admin.tenant.count({
          where: {
            deletedAt: null,
            status: 'cancelled',
            updatedAt: { gte: monthStart },
          },
        }),
        this.admin.tenant.count({
          where: { deletedAt: null, createdAt: { lt: monthStart } },
        }),
      ]);

    const tenants = {
      total: 0,
      trial: 0,
      active: 0,
      suspended: 0,
      cancelled: 0,
    };
    for (const row of statusGroups) {
      const key = row.status as TenantStatusKey;
      const count = row._count._all;
      tenants[key] = count;
      tenants.total += count;
    }

    const churnRatePercent =
      totalAtMonthStart > 0 ? (cancellationsThisMonth / totalAtMonthStart) * 100 : 0;

    return {
      tenants,
      mrr: {
        total: 0,
        currency: 'EUR',
      },
      signupsThisMonth,
      cancellationsThisMonth,
      churnRatePercent: Math.round(churnRatePercent * 100) / 100,
      averageRevenuePerTenant: 0,
    };
  }
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}
