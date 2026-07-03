import { Injectable, NotFoundException } from '@nestjs/common';

import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantsService } from './admin-tenants.service';

import type { AdminAddonChargeDueDto, AdminTodayDto } from '@storageos/shared';

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
    const [addonCharges, atRisk, followupsDue] = await Promise.all([
      this.addonChargesDue(now),
      this.tenants.getAtRisk(),
      this.followups.listPending(),
    ]);

    const urgentCount = addonCharges.length + atRisk.pastDue.length + followupsDue.length;
    return {
      date: now.toISOString(),
      addonCharges,
      trialsExpiring: atRisk.trialExpiring,
      pastDue: atRisk.pastDue,
      followupsDue,
      urgentCount,
    };
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
