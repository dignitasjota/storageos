import { Injectable, NotFoundException } from '@nestjs/common';

import {
  amountToCharge,
  platformPricing,
  type PlatformPricing,
} from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';
import type {
  AdminAccountEventDto,
  AdminBillingCalendarDto,
  AdminCalendarChargeDto,
  AdminChargeMethod,
  AdminDunningStepDto,
  AdminOverdueDto,
  AdminReceivableDto,
  AdminReceivablesDto,
  AdminScheduledChargeDto,
  AdminTenantAccountDto,
} from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

const SUB_INCLUDE = {
  plan: { select: { name: true, priceMonthly: true, priceYearly: true } },
  tenant: {
    select: {
      id: true,
      name: true,
      status: true,
      billingExempt: true,
      deletedAt: true,
      subscriptionAddons: {
        select: {
          id: true,
          priceMonthly: true,
          quantity: true,
          billingMode: true,
          nextChargeAt: true,
          suspendedAt: true,
          addon: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.TenantSubscriptionInclude;
type SubRow = Prisma.TenantSubscriptionGetPayload<{ include: typeof SUB_INCLUDE }>;

const STEP_LABEL: Record<AdminDunningStepDto['step'], string> = {
  reminder_1: 'Primer recordatorio',
  reminder_2: 'Segundo recordatorio',
  suspend: 'Suspensión',
};

function asMethod(mode: string | null | undefined): AdminChargeMethod {
  return mode === 'stripe' || mode === 'sepa' || mode === 'redsys' ? mode : 'manual';
}

/**
 * Pagos de los tenants a TrasterOS para el super admin: estado de cuenta de
 * un tenant, cobros pendientes de todos y calendario de cobros. Solo lectura;
 * las acciones (registrar pago, cobrar un extra, suspender) usan los
 * endpoints de siempre.
 *
 * Qué entra en cada cargo: con Stripe, la suscripción cobra el plan y los
 * extras puestos en Stripe; con SEPA, la remesa lleva el plan y los extras que
 * no van por Stripe; con pago manual, el plan va solo y cada extra tiene su
 * propia fecha.
 */
@Injectable()
export class AdminBillingOpsService {
  constructor(private readonly admin: PrismaAdminService) {}

  // ------------------------------------------------------------- cargos

  private cycleOf(sub: SubRow): 'monthly' | 'yearly' {
    const len = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
    return len > 200 * DAY ? 'yearly' : 'monthly';
  }

  /** Cuota del plan al final del periodo (con los extras que van con ella). */
  private planCharge(sub: SubRow, pricing: PlatformPricing): AdminScheduledChargeDto {
    const method = asMethod(sub.billingMode);
    const yearly = this.cycleOf(sub) === 'yearly';
    const planPrice = Number(yearly ? sub.plan.priceYearly : sub.plan.priceMonthly);
    const lines = [
      {
        label: `Plan ${sub.plan.name}${yearly ? ' (anual)' : ''}`,
        amount: amountToCharge(planPrice, pricing),
      },
    ];
    for (const a of sub.tenant.subscriptionAddons) {
      if (a.suspendedAt) continue;
      const withPlan =
        method === 'stripe'
          ? a.billingMode === 'stripe'
          : method === 'sepa' && a.billingMode !== 'stripe';
      if (!withPlan) continue;
      lines.push({
        label: a.quantity > 1 ? `${a.addon.name} × ${a.quantity}` : a.addon.name,
        amount: amountToCharge(Number(a.priceMonthly) * a.quantity, pricing),
      });
    }
    return {
      date: sub.currentPeriodEnd.toISOString(),
      method,
      lines,
      total: round2(lines.reduce((s, l) => s + l.amount, 0)),
    };
  }

  /** Extras que se cobran aparte (pago manual), con su propia fecha. */
  private separateAddonCharges(sub: SubRow, pricing: PlatformPricing): AdminScheduledChargeDto[] {
    if (sub.billingMode === 'sepa') return [];
    return sub.tenant.subscriptionAddons
      .filter((a) => !a.suspendedAt && a.billingMode !== 'stripe' && a.nextChargeAt)
      .map((a) => {
        const amount = amountToCharge(Number(a.priceMonthly) * a.quantity, pricing);
        return {
          date: a.nextChargeAt!.toISOString(),
          method: 'manual' as const,
          lines: [{ label: a.addon.name, amount }],
          total: amount,
        };
      });
  }

  // ------------------------------------------------------------- deuda

  /** Deuda de la cuota: desde el fin del periodo, con el escalado automático. */
  private async overdueFor(
    subs: SubRow[],
    pricing: PlatformPricing,
    now: Date,
  ): Promise<Map<string, AdminOverdueDto>> {
    const result = new Map<string, AdminOverdueDto>();
    const late = subs.filter(
      (s) =>
        !s.tenant.billingExempt &&
        s.tenant.status !== 'trial' &&
        s.tenant.status !== 'cancelled' &&
        (s.status === 'past_due' ||
          (s.status === 'active' && s.billingMode !== 'stripe' && s.currentPeriodEnd < now)),
    );
    if (late.length === 0) return result;
    const ids = late.map((s) => s.tenantId);
    const [settings, events, sepaItems] = await Promise.all([
      this.admin.platformDunningSettings.findFirst(),
      this.admin.platformDunningEvent.findMany({ where: { tenantId: { in: ids } } }),
      this.admin.platformSepaRemittanceItem.findMany({
        where: { tenantId: { in: ids } },
        select: { tenantId: true, itemStatus: true, bouncedAt: true, periodCovered: true },
        orderBy: { periodCovered: 'desc' },
      }),
    ]);
    for (const s of late) {
      const since = s.currentPeriodEnd;
      const days = Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY));
      const steps: AdminDunningStepDto[] = [];
      if (settings?.enabled) {
        const thresholds: [AdminDunningStepDto['step'], number][] = [
          ['reminder_1', settings.reminder1Days],
          ['reminder_2', settings.reminder2Days],
          ['suspend', settings.suspendDays],
        ];
        for (const [step, d] of thresholds) {
          const done = events.find(
            (e) =>
              e.tenantId === s.tenantId &&
              e.step === step &&
              e.periodEnd.getTime() === since.getTime(),
          );
          steps.push({
            step,
            label: STEP_LABEL[step],
            date: new Date(since.getTime() + d * DAY).toISOString(),
            doneAt: done?.sentAt.toISOString() ?? null,
          });
        }
      }
      const items = sepaItems.filter((i) => i.tenantId === s.tenantId);
      // Un plan gratuito sin extras no debe nada.
      const amount = this.planCharge(s, pricing).total;
      if (amount <= 0) continue;
      result.set(s.tenantId, {
        since: since.toISOString(),
        days,
        amount,
        steps,
        sepaBounced: items[0]?.itemStatus === 'bounced',
        sepaInProgress: items.some((i) => i.itemStatus === 'pending'),
      });
    }
    return result;
  }

  // ------------------------------------------------------------- cuenta

  async account(tenantId: string, now = new Date()): Promise<AdminTenantAccountDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, status: true, billingExempt: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const [sub, pricing, payments, invoices, bounces] = await Promise.all([
      this.admin.tenantSubscription.findUnique({ where: { tenantId }, include: SUB_INCLUDE }),
      platformPricing(this.admin),
      this.admin.tenantSubscriptionPayment.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      this.admin.platformInvoice.findMany({
        where: { tenantId },
        select: {
          fullNumber: true,
          issuedAt: true,
          total: true,
          invoiceType: true,
          concept: true,
          planName: true,
        },
        orderBy: { issuedAt: 'desc' },
        take: 40,
      }),
      this.admin.platformSepaRemittanceItem.findMany({
        where: { tenantId, itemStatus: 'bounced' },
        select: { amount: true, bouncedAt: true, bounceReason: true },
        orderBy: { bouncedAt: 'desc' },
        take: 10,
      }),
    ]);

    const charging =
      !!sub &&
      !tenant.billingExempt &&
      tenant.status !== 'trial' &&
      tenant.status !== 'cancelled' &&
      sub.status !== 'cancelled' &&
      sub.status !== 'expired';
    const overdue = sub ? (await this.overdueFor([sub], pricing, now)).get(tenantId) : undefined;

    const history: AdminAccountEventDto[] = [];
    for (const p of payments) {
      const method =
        p.provider === 'stripe' ? 'Stripe' : p.provider === 'sepa' ? 'SEPA' : p.provider;
      if (p.status === 'paid' && p.paidAt) {
        history.push({
          date: p.paidAt.toISOString(),
          kind: 'payment',
          label: p.description ?? `Pago${p.planName ? ` · ${p.planName}` : ''}`,
          amount: Number(p.amount),
          detail: [
            method,
            p.periodStart && p.periodEnd
              ? `${p.periodStart.toISOString().slice(0, 10)} → ${p.periodEnd.toISOString().slice(0, 10)}`
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
        });
      } else if (p.status === 'failed') {
        history.push({
          date: (p.firstFailedAt ?? p.createdAt).toISOString(),
          kind: 'failed',
          label: 'Cobro fallido',
          amount: Number(p.amount),
          detail: `${method}${p.failedAttempts > 1 ? ` · ${p.failedAttempts} intentos` : ''}`,
        });
      }
      if (Number(p.refundedAmount) > 0) {
        history.push({
          date: (p.refundedAt ?? p.updatedAt).toISOString(),
          kind: 'refund',
          label: p.disputedAt ? 'Contracargo' : 'Devolución',
          amount: -Number(p.refundedAmount),
          detail: p.disputeReason ?? method,
        });
      }
    }
    for (const i of invoices) {
      const credit = i.invoiceType.startsWith('R');
      history.push({
        date: i.issuedAt.toISOString(),
        kind: credit ? 'credit_note' : 'invoice',
        label: `${credit ? 'Rectificativa' : 'Factura'} ${i.fullNumber}`,
        amount: Number(i.total),
        detail: i.concept ?? (i.planName ? `Suscripción ${i.planName}` : null),
      });
    }
    for (const b of bounces) {
      if (!b.bouncedAt) continue;
      history.push({
        date: b.bouncedAt.toISOString(),
        kind: 'bounce',
        label: 'Adeudo SEPA devuelto',
        amount: -b.amount / 100,
        detail: b.bounceReason,
      });
    }
    history.sort((a, b) => b.date.localeCompare(a.date));

    const yearAgo = now.getTime() - 365 * DAY;
    const paid12m = payments
      .filter((p) => p.status === 'paid' && p.paidAt && p.paidAt.getTime() >= yearAgo)
      .reduce((s, p) => s + Number(p.amount) - Number(p.refundedAmount), 0);

    return {
      tenantStatus: tenant.status,
      subscriptionStatus: sub?.status ?? null,
      billingMode: sub ? asMethod(sub.billingMode) : null,
      billingExempt: tenant.billingExempt,
      pricesIncludeVat: pricing.includeVat,
      cycle: sub ? this.cycleOf(sub) : null,
      periodEnd: sub?.currentPeriodEnd.toISOString() ?? null,
      nextCharge: charging && sub ? this.planCharge(sub, pricing) : null,
      addonCharges: charging && sub ? this.separateAddonCharges(sub, pricing) : [],
      overdue: overdue ?? null,
      paid12m: round2(paid12m),
      history: history.slice(0, 40),
    };
  }

  // ------------------------------------------------------------- pendientes

  async receivables(now = new Date()): Promise<AdminReceivablesDto> {
    const pricing = await platformPricing(this.admin);
    const subs = await this.admin.tenantSubscription.findMany({
      where: {
        tenant: { deletedAt: null, billingExempt: false },
        OR: [
          { status: 'past_due' },
          { status: 'active', billingMode: { not: 'stripe' }, currentPeriodEnd: { lt: now } },
        ],
      },
      include: SUB_INCLUDE,
    });
    const overdue = await this.overdueFor(subs, pricing, now);
    const items: AdminReceivableDto[] = [];
    for (const s of subs) {
      const o = overdue.get(s.tenantId);
      if (!o) continue;
      items.push({
        tenantId: s.tenantId,
        tenantName: s.tenant.name,
        tenantStatus: s.tenant.status,
        kind: 'subscription',
        concept: `Cuota ${s.plan.name}`,
        amount: o.amount,
        method: asMethod(s.billingMode),
        since: o.since,
        days: o.days,
        overdue: o,
        tenantAddonId: null,
      });
    }
    const addons = await this.admin.tenantSubscriptionAddon.findMany({
      where: {
        nextChargeAt: { lte: now },
        suspendedAt: null,
        billingMode: { not: 'stripe' },
        tenant: {
          deletedAt: null,
          billingExempt: false,
          NOT: { subscription: { billingMode: 'sepa' } },
        },
      },
      include: {
        addon: { select: { name: true } },
        tenant: { select: { name: true, status: true } },
      },
    });
    for (const a of addons) {
      const since = a.nextChargeAt!;
      items.push({
        tenantId: a.tenantId,
        tenantName: a.tenant.name,
        tenantStatus: a.tenant.status,
        kind: 'addon',
        concept: `Extra ${a.addon.name}`,
        amount: amountToCharge(Number(a.priceMonthly) * a.quantity, pricing),
        method: 'manual',
        since: since.toISOString(),
        days: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY)),
        overdue: null,
        tenantAddonId: a.id,
      });
    }
    items.sort((a, b) => b.days - a.days || b.amount - a.amount);
    return { total: round2(items.reduce((s, i) => s + i.amount, 0)), items };
  }

  // ------------------------------------------------------------- calendario

  async calendar(
    days: number,
    pastDays: number,
    now = new Date(),
  ): Promise<AdminBillingCalendarDto> {
    const from = new Date(now.getTime() - pastDays * DAY);
    const to = new Date(now.getTime() + days * DAY);
    const pricing = await platformPricing(this.admin);
    const charges: AdminCalendarChargeDto[] = [];

    const subs = await this.admin.tenantSubscription.findMany({
      where: {
        status: 'active',
        tenant: { deletedAt: null, billingExempt: false, status: 'active' },
        OR: [
          { currentPeriodEnd: { gte: now, lte: to } },
          {
            tenant: {
              subscriptionAddons: {
                some: { suspendedAt: null, nextChargeAt: { gte: now, lte: to } },
              },
            },
          },
        ],
      },
      include: SUB_INCLUDE,
    });
    for (const s of subs) {
      if (s.currentPeriodEnd >= now && s.currentPeriodEnd <= to) {
        const c = this.planCharge(s, pricing);
        charges.push({
          date: c.date,
          tenantId: s.tenantId,
          tenantName: s.tenant.name,
          method: c.method,
          concept: c.lines.map((l) => l.label).join(' + '),
          amount: c.total,
          state: 'scheduled',
        });
      }
      for (const c of this.separateAddonCharges(s, pricing)) {
        const d = new Date(c.date);
        if (d < now || d > to) continue;
        charges.push({
          date: c.date,
          tenantId: s.tenantId,
          tenantName: s.tenant.name,
          method: 'manual',
          concept: c.lines[0]!.label,
          amount: c.total,
          state: 'scheduled',
        });
      }
    }

    const [payments, bounces] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          OR: [
            { status: 'paid', paidAt: { gte: from, lt: now } },
            { status: 'failed', createdAt: { gte: from, lt: now } },
          ],
        },
        include: { tenant: { select: { name: true } } },
      }),
      this.admin.platformSepaRemittanceItem.findMany({
        where: { itemStatus: 'bounced', bouncedAt: { gte: from, lt: now } },
        include: { tenant: { select: { name: true } } },
      }),
    ]);
    for (const p of payments) {
      charges.push({
        date: (p.status === 'paid' ? p.paidAt! : p.createdAt).toISOString(),
        tenantId: p.tenantId,
        tenantName: p.tenant.name,
        method: asMethod(p.provider),
        concept: p.description ?? (p.planName ? `Cuota ${p.planName}` : 'Pago'),
        amount: Number(p.amount),
        state: p.status === 'paid' ? 'paid' : 'failed',
      });
    }
    for (const b of bounces) {
      charges.push({
        date: b.bouncedAt!.toISOString(),
        tenantId: b.tenantId,
        tenantName: b.tenant.name,
        method: 'sepa',
        concept: `Adeudo devuelto${b.bounceReason ? ` (${b.bounceReason})` : ''}`,
        amount: b.amount / 100,
        state: 'bounced',
      });
    }
    charges.sort((a, b) => a.date.localeCompare(b.date));

    const scheduledByMethod: Record<AdminChargeMethod, number> = {
      stripe: 0,
      sepa: 0,
      redsys: 0,
      manual: 0,
    };
    for (const c of charges) {
      if (c.state === 'scheduled')
        scheduledByMethod[c.method] = round2(scheduledByMethod[c.method] + c.amount);
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      pricesIncludeVat: pricing.includeVat,
      charges,
      scheduledByMethod,
    };
  }
}
