import { Injectable, NotFoundException } from '@nestjs/common';
import { type AdminTenantSummaryDto } from '@storageos/shared';

import { isPayingSubscription, loadMrrContext, mrrFor } from '../../common/saas-metrics';
import { UNANSWERED_ADMIN_MESSAGE } from '../../common/support-ticket-filters';
import { lastTeamActivity } from '../../common/team-activity';
import { ALL_FACILITIES, LIVE_CONTRACT_WHERE } from '../analytics/analytics-scope';
import {
  collectedBetween,
  invoicedAmount,
  INVOICED_SELECT,
  invoicedWhere,
  receivables,
  unitCounts,
} from '../analytics/business-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

const DAY = 24 * 60 * 60 * 1000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Resumen de un tenant para la cabecera de su ficha en el panel admin: lo que
 * aporta, cómo paga, si el equipo entra, cómo factura y cobra a sus inquilinos
 * y lo pendiente con soporte. Las cifras de su negocio son las mismas que ve él
 * en su Resumen (`business-metrics`); lo que aporta, el mismo MRR que la lista.
 */
@Injectable()
export class AdminTenantSummaryService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
  ) {}

  async get(tenantId: string): Promise<AdminTenantSummaryDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        status: true,
        billingExempt: true,
        deletedAt: true,
        trialEndsAt: true,
        subscription: {
          select: {
            status: true,
            billingMode: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
            plan: { select: { name: true, priceMonthly: true, priceYearly: true } },
          },
        },
      },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const now = new Date();
    const since = new Date(now.getTime() - 30 * DAY);
    const sub = tenant.subscription;
    const [ctx, users, business, openTickets, lastInteraction, nextFollowup, lastActivity] =
      await Promise.all([
        loadMrrContext(this.admin, [tenantId]),
        this.admin.user.aggregate({
          where: { tenantId, isActive: true },
          _count: { _all: true },
        }),
        // Su negocio con sus propias reglas (RLS de su tenant).
        this.prisma.withTenant(async (tx) => {
          const [invoiced, collected, owed, activeContracts, units] = await Promise.all([
            tx.invoice.findMany({
              where: invoicedWhere(ALL_FACILITIES, since, now),
              select: INVOICED_SELECT,
            }),
            collectedBetween(tx, ALL_FACILITIES, since, now),
            receivables(tx, ALL_FACILITIES, now),
            tx.contract.count({ where: LIVE_CONTRACT_WHERE }),
            unitCounts(tx, ALL_FACILITIES),
          ]);
          return { invoiced, collected, owed, activeContracts, units };
        }, tenantId),
        this.admin.supportTicket.count({
          where: {
            tenantId,
            status: { in: ['open', 'in_progress', 'waiting_user'] },
            NOT: UNANSWERED_ADMIN_MESSAGE,
          },
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
        lastTeamActivity(this.admin, tenantId),
      ]);

    // Lo que aporta: el MRR sin IVA, 0 si no paga (prueba, exenta, solo
    // lectura, suspendida). En prueba, aparte lo que pagaría.
    const mrr = sub ? mrrFor(ctx, tenantId, sub).total : 0;
    const paying = isPayingSubscription(sub, tenant) && mrr > 0;
    const inTrial = tenant.status === 'trial';
    const { invoiced, collected, owed, activeContracts, units } = business;
    return {
      effectiveMonthly: paying ? round2(mrr) : 0,
      wouldPay: inTrial && !tenant.billingExempt && mrr > 0 ? round2(mrr) : null,
      trialEndsAt: inTrial ? (tenant.trialEndsAt?.toISOString() ?? null) : null,
      planName: sub?.plan.name ?? null,
      billingMode: sub?.billingMode ?? null,
      billingExempt: tenant.billingExempt,
      nextChargeAt:
        paying && !sub?.cancelAtPeriodEnd && sub ? sub.currentPeriodEnd.toISOString() : null,
      lastTeamLoginAt: lastActivity?.toISOString() ?? null,
      activeUsers: users._count._all,
      invoiced30d: round2(invoiced.reduce((sum, r) => sum + invoicedAmount(r), 0)),
      // Facturas, sin los abonos que las anulan.
      invoices30d: invoiced.filter((r) => Number(r.total) > 0).length,
      collected30d: collected,
      overdueInvoices: owed.overdueInvoices,
      overdueAmount: owed.overdue,
      activeContracts,
      // Como en su Resumen: ocupados sobre el total (sin locales borrados ni el
      // trastero del inquilino de prueba).
      occupancyPct: units.total > 0 ? Math.round((units.occupied / units.total) * 100) : null,
      openTickets,
      lastInteractionAt: lastInteraction?.occurredAt.toISOString() ?? null,
      nextFollowup: nextFollowup
        ? { title: nextFollowup.title, dueDate: nextFollowup.dueDate.toISOString().slice(0, 10) }
        : null,
    };
  }
}
