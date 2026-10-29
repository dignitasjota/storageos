import { Injectable, NotFoundException } from '@nestjs/common';
import { NON_CASH_PAYMENT_METHODS, type AdminTenantSummaryDto } from '@storageos/shared';

import { SaasAddonsService } from '../billing-saas/saas-addons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

const DAY = 24 * 60 * 60 * 1000;
const num = (v: unknown): number => Number(v ?? 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Resumen de un tenant para la cabecera de su ficha en el panel admin: lo que
 * aporta, cómo paga, si el equipo entra, cómo factura y cobra a sus inquilinos
 * y lo pendiente con soporte. Antes había que abrir tres pestañas y dos
 * diálogos para verlo.
 */
@Injectable()
export class AdminTenantSummaryService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly addons: SaasAddonsService,
  ) {}

  async get(tenantId: string): Promise<AdminTenantSummaryDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        billingExempt: true,
        subscription: { select: { currentPeriodEnd: true, billingMode: true } },
      },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const since = new Date(Date.now() - 30 * DAY);
    const [
      billing,
      users,
      invoiced,
      collected,
      overdue,
      activeContracts,
      unitsTotal,
      unitsOccupied,
      openTickets,
      lastInteraction,
      nextFollowup,
    ] = await Promise.all([
      this.addons.billingSummary(tenantId),
      this.admin.user.aggregate({
        where: { tenantId, isActive: true },
        _count: { _all: true },
        _max: { lastLoginAt: true },
      }),
      this.admin.invoice.aggregate({
        where: {
          tenantId,
          kind: 'invoice',
          status: { notIn: ['draft', 'cancelled'] },
          issueDate: { gte: since },
        },
        _count: { _all: true },
        _sum: { total: true },
      }),
      this.admin.payment.aggregate({
        where: {
          tenantId,
          status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
          paidAt: { gte: since },
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          invoice: { kind: 'invoice' },
        },
        _sum: { amount: true, refundedAmount: true },
      }),
      this.admin.invoice.aggregate({
        where: { tenantId, kind: 'invoice', status: 'overdue' },
        _count: { _all: true },
        _sum: { total: true, amountPaid: true, amountRefunded: true },
      }),
      this.admin.contract.count({
        where: { tenantId, status: { in: ['active', 'ending'] }, deletedAt: null },
      }),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.unit.count({ where: { tenantId, status: 'occupied' } }),
      this.admin.supportTicket.count({
        where: { tenantId, status: { in: ['open', 'in_progress', 'waiting_user'] } },
      }),
      this.admin.tenantInteraction.findFirst({
        where: { tenantId },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      this.admin.tenantFollowup.findFirst({
        where: { tenantId, status: 'pending' },
        orderBy: { dueDate: 'asc' },
        select: { title: true, dueDate: true },
      }),
    ]);

    return {
      effectiveMonthly: billing.effectiveMonthly,
      planName: billing.planName,
      billingMode: tenant.subscription?.billingMode ?? null,
      billingExempt: tenant.billingExempt,
      nextChargeAt:
        tenant.billingExempt || !tenant.subscription
          ? null
          : tenant.subscription.currentPeriodEnd.toISOString(),
      lastTeamLoginAt: users._max.lastLoginAt?.toISOString() ?? null,
      activeUsers: users._count._all,
      invoiced30d: round2(num(invoiced._sum.total)),
      invoices30d: invoiced._count._all,
      collected30d: round2(num(collected._sum.amount) - num(collected._sum.refundedAmount)),
      overdueInvoices: overdue._count._all,
      overdueAmount: round2(
        Math.max(
          0,
          num(overdue._sum.total) - num(overdue._sum.amountPaid) - num(overdue._sum.amountRefunded),
        ),
      ),
      activeContracts,
      occupancyPct: unitsTotal > 0 ? Math.round((unitsOccupied / unitsTotal) * 100) : null,
      openTickets,
      lastInteractionAt: lastInteraction?.occurredAt.toISOString() ?? null,
      nextFollowup: nextFollowup
        ? { title: nextFollowup.title, dueDate: nextFollowup.dueDate.toISOString().slice(0, 10) }
        : null,
    };
  }
}
