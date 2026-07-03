import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantsService } from './admin-tenants.service';

import type {
  AdminAddonChargeDueDto,
  AdminManualRenewalDueDto,
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
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly followups: AdminTenantFollowupsService,
    private readonly billing: BillingSaasService,
  ) {}

  async getToday(): Promise<AdminTodayDto> {
    const now = new Date();
    const [addonCharges, manualRenewalsDue, staleSuspendedAddons, atRisk, followupsDue] =
      await Promise.all([
        this.addonChargesDue(now),
        this.manualRenewalsDue(now),
        this.staleSuspendedAddons(now),
        this.tenants.getAtRisk(),
        this.followups.listPending(),
      ]);

    const urgentCount =
      addonCharges.length + manualRenewalsDue.length + atRisk.pastDue.length + followupsDue.length;
    return {
      date: now.toISOString(),
      addonCharges,
      manualRenewalsDue,
      trialsExpiring: atRisk.trialExpiring,
      pastDue: atRisk.pastDue,
      followupsDue,
      staleSuspendedAddons,
      urgentCount,
    };
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
        tenant: { deletedAt: null },
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
   * Add-ons con `next_charge_at <= ahora` de tenants que pagan el plan por
   * Stripe (los de pago 100% manual cobran el add-on junto con el plan, así que
   * no necesitan recordatorio separado).
   */
  private async addonChargesDue(now: Date): Promise<AdminAddonChargeDueDto[]> {
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: {
        nextChargeAt: { lte: now },
        suspendedAt: null, // los suspendidos por impago no se cobran
        tenant: { subscription: { stripeSubscriptionId: { not: null } } },
      },
      include: {
        addon: { select: { name: true } },
        tenant: { select: { name: true, currency: true } },
      },
      orderBy: { nextChargeAt: 'asc' },
    });
    return rows.map((r) => {
      const due = r.nextChargeAt ?? now;
      const overdueDays = Math.max(0, Math.floor((now.getTime() - due.getTime()) / MS_PER_DAY));
      return {
        tenantAddonId: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        addonName: r.addon.name,
        amount: Number(r.priceMonthly) * r.quantity,
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
    const amount = Number(row.priceMonthly) * row.quantity;
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
