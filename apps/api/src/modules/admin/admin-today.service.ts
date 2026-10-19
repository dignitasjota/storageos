import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

import { todayInTimezone } from '../../common/format';
import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { amountToCharge, platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';
import {
  QUEUE_AUTOMATIONS,
  QUEUE_BILLING,
  QUEUE_COMMUNICATIONS,
  QUEUE_DUNNING,
  QUEUE_EMAIL,
  QUEUE_PAYMENTS,
  QUEUE_REPORTS,
  QUEUE_VERIFACTU,
  QUEUE_WEBHOOKS,
} from '../queues/queue-names';

import { AdminApprovalsService } from './admin-approvals.service';
import { AdminOpsHealthService } from './admin-ops-health.service';
import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantsService } from './admin-tenants.service';
import { FeatureExpiryService } from './feature-expiry.service';

import type {
  AdminAddonChargeDueDto,
  AdminFailedWebhooksDto,
  AdminManualRenewalDueDto,
  AdminOpenTicketDto,
  AdminStaleSuspendedAddonDto,
  AdminTodayDto,
} from '@storageos/shared';

/** Suma N meses conservando el fin de mes (evita desbordes de día). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** Orden de prioridad de los tickets (mayor = antes). */
const PRIORITY_ORDER: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bandeja «Hoy» del super admin: acciones pendientes del día. Reutiliza
 * `getAtRisk` (trials/past_due) y los seguimientos vencidos, y añade los
 * **cobros de add-ons pendientes** (add-ons de tenants que pagan el plan por
 * Stripe → el add-on se cobra a mano cada mes y no lo dispara ningún vencimiento
 * de Stripe). Cobrarlo desde aquí avanza el `next_charge_at` un mes.
 */
@Injectable()
export class AdminTodayService {
  private readonly queues: Queue[];

  constructor(
    private readonly approvals: AdminApprovalsService,
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly followups: AdminTenantFollowupsService,
    private readonly billing: BillingSaasService,
    private readonly ops: AdminOpsHealthService,
    private readonly featureExpiry: FeatureExpiryService,
    @InjectQueue(QUEUE_BILLING) billingQueue: Queue,
    @InjectQueue(QUEUE_DUNNING) dunningQueue: Queue,
    @InjectQueue(QUEUE_PAYMENTS) paymentsQueue: Queue,
    @InjectQueue(QUEUE_VERIFACTU) verifactuQueue: Queue,
    @InjectQueue(QUEUE_EMAIL) emailQueue: Queue,
    @InjectQueue(QUEUE_COMMUNICATIONS) communicationsQueue: Queue,
    @InjectQueue(QUEUE_AUTOMATIONS) automationsQueue: Queue,
    @InjectQueue(QUEUE_REPORTS) reportsQueue: Queue,
    @InjectQueue(QUEUE_WEBHOOKS) webhooksQueue: Queue,
  ) {
    this.queues = [
      billingQueue,
      dunningQueue,
      paymentsQueue,
      verifactuQueue,
      emailQueue,
      communicationsQueue,
      automationsQueue,
      reportsQueue,
      webhooksQueue,
    ];
  }

  async getToday(): Promise<AdminTodayDto> {
    const now = new Date();
    const [
      addonCharges,
      manualRenewalsDue,
      staleSuspendedAddons,
      atRisk,
      pendingFollowups,
      openTickets,
      failedJobs,
      failedWebhooks,
      aeatIssues,
      certificatesExpiring,
      holdedReview,
      devicesOffline,
      crons,
      pendingApprovals,
      expiringOverrides,
    ] = await Promise.all([
      this.addonChargesDue(now),
      this.manualRenewalsDue(now),
      this.staleSuspendedAddons(now),
      this.tenants.getAtRisk(),
      this.followups.listPending(),
      this.openTickets(now),
      this.countFailedJobs(),
      this.failedWebhooks(now),
      this.ops.aeatIssues(now),
      this.ops.certificatesExpiring(now),
      this.ops.holdedReview(),
      this.ops.devicesOffline(now),
      this.ops.crons(now),
      this.approvals.pending(),
      this.featureExpiry.expiringSoon(now),
    ]);
    const overdueCrons = crons.filter((c) => c.overdue);
    // Solo los que tocan hoy o ya pasaron (antes salían todos los pendientes,
    // también los de dentro de semanas, como «vencidos» y urgentes).
    const todayIso = todayInTimezone('Europe/Madrid', now).toISOString().slice(0, 10);
    const followupsDue = pendingFollowups.filter((f) => f.dueDate <= todayIso);

    const urgentCount =
      addonCharges.length +
      manualRenewalsDue.length +
      atRisk.pastDue.length +
      followupsDue.length +
      openTickets.length +
      failedWebhooks.length +
      (failedJobs > 0 ? 1 : 0) +
      aeatIssues.length +
      certificatesExpiring.filter((c) => c.daysLeft <= 15).length +
      holdedReview.length +
      devicesOffline.length +
      overdueCrons.length +
      pendingApprovals.length +
      expiringOverrides.filter((o) => o.daysLeft <= 1).length;
    return {
      date: now.toISOString(),
      addonCharges,
      manualRenewalsDue,
      trialsExpiring: atRisk.trialExpiring,
      pastDue: atRisk.pastDue,
      followupsDue,
      staleSuspendedAddons,
      openTickets,
      failedWebhooks,
      failedJobs,
      aeatIssues,
      certificatesExpiring,
      holdedReview,
      devicesOffline,
      overdueCrons,
      pendingApprovals,
      expiringOverrides,
      urgentCount,
    };
  }

  /** Tickets de soporte esperando respuesta del admin (status open). */
  private async openTickets(now: Date): Promise<AdminOpenTicketDto[]> {
    const rows = await this.admin.supportTicket.findMany({
      where: { status: 'open' },
      select: {
        id: true,
        tenantId: true,
        subject: true,
        priority: true,
        createdAt: true,
        tenant: { select: { name: true } },
        // Lo que espera el admin cuenta desde el último mensaje del tenant
        // (`updatedAt` cambia también con un cambio de prioridad o una nota).
        messages: {
          where: { authorUserId: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    return rows
      .map((r) => {
        const since = r.messages[0]?.createdAt ?? r.createdAt;
        return {
          since,
          dto: {
            id: r.id,
            tenantId: r.tenantId,
            tenantName: r.tenant.name,
            subject: r.subject,
            priority: r.priority,
            waitingDays: Math.floor((now.getTime() - since.getTime()) / MS_PER_DAY),
          },
        };
      })
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.dto.priority] ?? 0;
        const pb = PRIORITY_ORDER[b.dto.priority] ?? 0;
        return pb - pa || a.since.getTime() - b.since.getTime();
      })
      .map((x) => x.dto);
  }

  /**
   * Tenants con entregas de webhook salientes en `failed` en los últimos 7 días
   * (agotaron los reintentos): su integración está rota y conviene avisarles.
   */
  private async failedWebhooks(now: Date): Promise<AdminFailedWebhooksDto[]> {
    const since = new Date(now.getTime() - 7 * MS_PER_DAY);
    const groups = await this.admin.webhookDelivery.groupBy({
      by: ['tenantId'],
      where: { status: 'failed', createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    if (groups.length === 0) return [];
    const tenantIds = groups.map((g) => g.tenantId);
    const [tenants, lastErrors] = await Promise.all([
      this.admin.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
      }),
      this.admin.webhookDelivery.findMany({
        where: { tenantId: { in: tenantIds }, status: 'failed', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        distinct: ['tenantId'],
        select: { tenantId: true, errorMessage: true, statusCode: true },
      }),
    ]);
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    const errors = new Map(
      lastErrors.map((e) => [
        e.tenantId,
        e.errorMessage ?? (e.statusCode != null ? `HTTP ${e.statusCode}` : null),
      ]),
    );
    return groups
      .map((g) => ({
        tenantId: g.tenantId,
        tenantName: names.get(g.tenantId) ?? '—',
        failedCount: g._count._all,
        lastFailedAt: (g._max.createdAt ?? now).toISOString(),
        lastError: errors.get(g.tenantId) ?? null,
      }))
      .sort((a, b) => b.failedCount - a.failedCount);
  }

  /** Nº total de jobs BullMQ en estado failed (colas que necesitan atención). */
  private async countFailedJobs(): Promise<number> {
    const counts = await Promise.all(this.queues.map((q) => q.getJobCounts('failed')));
    return counts.reduce((sum, c) => sum + (c.failed ?? 0), 0);
  }

  /**
   * Suscripciones de pago MANUAL (sin `stripeSubscriptionId`) cuyo periodo vence
   * en ≤7 días o ya venció: hay que cobrarlas a mano antes de que caduquen
   * (las de Stripe se renuevan solas, no necesitan recordatorio).
   */
  private async manualRenewalsDue(now: Date): Promise<AdminManualRenewalDueDto[]> {
    const cutoff = new Date(now.getTime() + 7 * MS_PER_DAY);
    const rows = await this.admin.tenantSubscription.findMany({
      where: {
        stripeSubscriptionId: null,
        status: 'active',
        currentPeriodEnd: { lte: cutoff },
        // Las cuentas exentas no se cobran nunca → no deben aparecer como
        // «renovación manual pendiente» (su fecha de fin es irrelevante).
        tenant: { deletedAt: null, billingExempt: false },
      },
      select: { tenantId: true, currentPeriodEnd: true, tenant: { select: { name: true } } },
      orderBy: { currentPeriodEnd: 'asc' },
    });
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      currentPeriodEnd: r.currentPeriodEnd.toISOString(),
      daysLeft: Math.ceil((r.currentPeriodEnd.getTime() - now.getTime()) / MS_PER_DAY),
    }));
  }

  /** Add-ons suspendidos hace >30 días: candidatos a quitar definitivamente. */
  private async staleSuspendedAddons(now: Date): Promise<AdminStaleSuspendedAddonDto[]> {
    const cutoff = new Date(now.getTime() - 30 * MS_PER_DAY);
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: { suspendedAt: { not: null, lt: cutoff }, tenant: { deletedAt: null } },
      select: {
        id: true,
        tenantId: true,
        suspendedAt: true,
        addon: { select: { name: true } },
        tenant: { select: { name: true } },
      },
      orderBy: { suspendedAt: 'asc' },
    });
    return rows.map((r) => ({
      tenantAddonId: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      addonName: r.addon.name,
      suspendedAt: (r.suspendedAt ?? now).toISOString(),
      daysSuspended: Math.floor((now.getTime() - (r.suspendedAt ?? now).getTime()) / MS_PER_DAY),
    }));
  }

  /**
   * Add-ons en modo MANUAL con `next_charge_at <= ahora` (los de Stripe los cobra
   * Stripe y tienen `next_charge_at` nulo → quedan fuera por el filtro de fecha).
   * Incluye tanto tenants de plan Stripe con add-on manual como tenants 100%
   * manuales: en ambos casos el add-on se cobra a mano desde aquí.
   */
  private async addonChargesDue(now: Date): Promise<AdminAddonChargeDueDto[]> {
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: {
        nextChargeAt: { lte: now },
        suspendedAt: null, // los suspendidos por impago no se cobran
        billingMode: { not: 'stripe' }, // manual (o legacy null); los de Stripe no
        // Con la cuota domiciliada por SEPA los extras ya van en la remesa: no
        // se cobran aparte (se cobrarían dos veces).
        tenant: {
          deletedAt: null,
          billingExempt: false,
          NOT: { subscription: { billingMode: 'sepa' } },
        },
      },
      include: {
        addon: { select: { name: true } },
        tenant: { select: { name: true, currency: true } },
      },
      orderBy: { nextChargeAt: 'asc' },
    });
    const pricing = await platformPricing(this.admin);
    return rows.map((r) => {
      const due = r.nextChargeAt ?? now;
      const overdueDays = Math.max(0, Math.floor((now.getTime() - due.getTime()) / MS_PER_DAY));
      return {
        tenantAddonId: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        addonName: r.addon.name,
        amount: amountToCharge(Number(r.priceMonthly) * r.quantity, pricing),
        currency: r.tenant.currency,
        nextChargeAt: due.toISOString(),
        overdueDays,
      };
    });
  }

  /**
   * Registra el cobro manual de un add-on (sin extender el periodo) y avanza su
   * `next_charge_at` un mes.
   */
  async chargeAddon(tenantAddonId: string, provider: string): Promise<AdminTodayDto> {
    const row = await this.admin.tenantSubscriptionAddon.findUnique({
      where: { id: tenantAddonId },
      include: {
        addon: { select: { name: true } },
        tenant: { select: { currency: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Add-on no encontrado' });
    }
    // Pudo suspenderse entre que se pintó la bandeja «Hoy» y este cobro.
    if (row.suspendedAt) {
      throw new BadRequestException({
        code: 'addon_suspended',
        message: 'El add-on está suspendido; reactívalo antes de cobrarlo.',
      });
    }
    // Con precios +IVA se cobra el precio más el IVA.
    const amount = amountToCharge(
      Number(row.priceMonthly) * row.quantity,
      await platformPricing(this.admin),
    );
    await this.billing.recordManualPayment({
      tenantId: row.tenantId,
      provider,
      amount,
      currency: row.tenant.currency,
      durationMonths: 1,
      extendsPeriod: false, // cobro del add-on: NO toca el periodo del plan
      description: `Add-on: ${row.addon.name}`,
    });
    // Programa el siguiente cobro dentro de un mes.
    await this.admin.tenantSubscriptionAddon.update({
      where: { id: tenantAddonId },
      data: { nextChargeAt: addMonths(new Date(), 1) },
    });
    return this.getToday();
  }
}
