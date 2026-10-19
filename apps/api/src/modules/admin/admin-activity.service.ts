import { Injectable } from '@nestjs/common';
import { FEATURE_LABELS, type TenantFeature } from '@storageos/shared';

import { amountToCharge, platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { AdminActivityItemDto, AdminTodayKpisDto } from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const CHURN_LABEL: Record<string, string> = {
  price: 'precio',
  missing_features: 'le faltan funciones',
  business_closure: 'cierre del negocio',
  competitor: 'se va a la competencia',
  nonpayment: 'impago',
  other: 'otro motivo',
};

/**
 * Actividad reciente de los tenants (altas, bajas, cambios de plan, extras,
 * primer contrato en prueba, cobros e interés) y cifras del día para «Hoy» y
 * los avisos comerciales por chat.
 */
@Injectable()
export class AdminActivityService {
  constructor(private readonly admin: PrismaAdminService) {}

  async activity(since: Date, now = new Date()): Promise<AdminActivityItemDto[]> {
    const window = { gte: since, lt: now };
    const [
      signups,
      churns,
      planAudits,
      addonsAdded,
      removedAdmin,
      removedSelf,
      trials,
      contracts,
      payments,
      interest,
    ] = await Promise.all([
      this.admin.tenant.findMany({
        where: { createdAt: window, deletedAt: null },
        select: { id: true, name: true, createdAt: true },
      }),
      this.admin.tenant.findMany({
        where: { canceledAt: window, status: { in: ['suspended', 'cancelled'] } },
        select: { id: true, name: true, canceledAt: true, churnReason: true, status: true },
      }),
      this.admin.auditLog.findMany({
        where: {
          occurredAt: window,
          action: { in: ['admin.tenant.plan_changed', 'saas_billing.plan_changed'] },
        },
        select: {
          tenantId: true,
          occurredAt: true,
          changes: true,
          tenant: { select: { name: true } },
        },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { createdAt: window },
        select: {
          tenantId: true,
          createdAt: true,
          priceMonthly: true,
          quantity: true,
          addon: { select: { name: true } },
          tenant: { select: { name: true } },
        },
      }),
      this.admin.superAdminAuditLog.findMany({
        where: { occurredAt: window, action: 'admin.saas_addon.removed' },
        select: { targetTenantId: true, occurredAt: true, changes: true },
      }),
      this.admin.auditLog.findMany({
        where: { occurredAt: window, action: 'saas_billing.addon_removed' },
        select: {
          tenantId: true,
          occurredAt: true,
          changes: true,
          tenant: { select: { name: true } },
        },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { source: 'trial', createdAt: window },
        select: {
          tenantId: true,
          createdAt: true,
          feature: true,
          trialAddon: { select: { name: true } },
          tenant: { select: { name: true } },
        },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { signedAt: window, deletedAt: null, tenant: { status: 'trial' } },
        _min: { signedAt: true },
      }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: { status: 'paid', paidAt: window },
        select: {
          tenantId: true,
          paidAt: true,
          amount: true,
          description: true,
          tenant: { select: { name: true } },
        },
      }),
      this.admin.featureInterestEvent.groupBy({
        by: ['tenantId', 'feature'],
        where: { createdAt: window },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
    ]);

    const items: AdminActivityItemDto[] = [];
    for (const t of signups) {
      items.push({
        at: t.createdAt.toISOString(),
        kind: 'signup',
        tenantId: t.id,
        tenantName: t.name,
        text: 'Nueva alta',
        amount: null,
      });
    }
    for (const t of churns) {
      items.push({
        at: t.canceledAt!.toISOString(),
        kind: 'churn',
        tenantId: t.id,
        tenantName: t.name,
        text: `${t.status === 'cancelled' ? 'Baja' : 'Suspendido'}${
          t.churnReason ? ` (${CHURN_LABEL[t.churnReason] ?? t.churnReason})` : ''
        }`,
        amount: null,
      });
    }
    for (const a of planAudits) {
      const c = (a.changes ?? {}) as { newPlan?: string; toSlug?: string };
      const to = c.newPlan ?? c.toSlug;
      items.push({
        at: a.occurredAt.toISOString(),
        kind: 'plan_changed',
        tenantId: a.tenantId,
        tenantName: a.tenant.name,
        text: to ? `Cambia al plan ${to}` : 'Cambia de plan',
        amount: null,
      });
    }
    for (const a of addonsAdded) {
      items.push({
        at: a.createdAt.toISOString(),
        kind: 'addon_added',
        tenantId: a.tenantId,
        tenantName: a.tenant.name,
        text: `Contrata ${a.addon.name}`,
        amount: round2(Number(a.priceMonthly) * a.quantity),
      });
    }
    const removedIds = new Set(
      removedAdmin.map((r) => r.targetTenantId).filter(Boolean) as string[],
    );
    const removedNames = removedIds.size
      ? new Map(
          (
            await this.admin.tenant.findMany({
              where: { id: { in: [...removedIds] }, deletedAt: null },
              select: { id: true, name: true },
            })
          ).map((t) => [t.id, t.name]),
        )
      : new Map<string, string>();
    for (const r of removedAdmin) {
      // Sin tenant (ya borrado): no se muestra.
      if (!r.targetTenantId || !removedNames.has(r.targetTenantId)) continue;
      const name = (r.changes as { addonName?: string } | null)?.addonName;
      items.push({
        at: r.occurredAt.toISOString(),
        kind: 'addon_removed',
        tenantId: r.targetTenantId,
        tenantName: removedNames.get(r.targetTenantId)!,
        text: `Se le quita ${name ?? 'un extra'}`,
        amount: null,
      });
    }
    for (const r of removedSelf) {
      const name = (r.changes as { addonName?: string } | null)?.addonName;
      items.push({
        at: r.occurredAt.toISOString(),
        kind: 'addon_removed',
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        text: `Cancela ${name ?? 'un extra'}`,
        amount: null,
      });
    }
    for (const t of trials) {
      items.push({
        at: t.createdAt.toISOString(),
        kind: 'addon_trial',
        tenantId: t.tenantId,
        tenantName: t.tenant.name,
        text: `Empieza la prueba gratis de ${t.trialAddon?.name ?? FEATURE_LABELS[t.feature as TenantFeature] ?? t.feature}`,
        amount: null,
      });
    }
    // Primer contrato firmado de un tenant en prueba: el momento de llamarle.
    if (contracts.length > 0) {
      const firsts = await this.admin.contract.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: contracts.map((c) => c.tenantId) },
          signedAt: { not: null },
          deletedAt: null,
        },
        _min: { signedAt: true },
      });
      const firstBy = new Map(firsts.map((f) => [f.tenantId, f._min.signedAt]));
      const names = new Map(
        (
          await this.admin.tenant.findMany({
            where: { id: { in: contracts.map((c) => c.tenantId) } },
            select: { id: true, name: true },
          })
        ).map((t) => [t.id, t.name]),
      );
      for (const c of contracts) {
        const first = firstBy.get(c.tenantId);
        if (!first || first < since) continue;
        items.push({
          at: first.toISOString(),
          kind: 'first_contract',
          tenantId: c.tenantId,
          tenantName: names.get(c.tenantId) ?? '—',
          text: 'Firma su primer contrato estando en prueba',
          amount: null,
        });
      }
    }
    for (const p of payments) {
      items.push({
        at: p.paidAt!.toISOString(),
        kind: 'payment',
        tenantId: p.tenantId,
        tenantName: p.tenant.name,
        text: p.description ?? 'Pago de la suscripción',
        amount: Number(p.amount),
      });
    }
    if (interest.length > 0) {
      const names = new Map(
        (
          await this.admin.tenant.findMany({
            where: { id: { in: [...new Set(interest.map((i) => i.tenantId))] } },
            select: { id: true, name: true },
          })
        ).map((t) => [t.id, t.name]),
      );
      for (const i of interest) {
        const n = i._count._all;
        items.push({
          at: i._max.createdAt!.toISOString(),
          kind: 'interest',
          tenantId: i.tenantId,
          tenantName: names.get(i.tenantId) ?? '—',
          text: `Entra en ${FEATURE_LABELS[i.feature as TenantFeature] ?? i.feature} sin tenerla${n > 1 ? ` (${n} veces)` : ''}`,
          amount: null,
        });
      }
    }
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }

  async kpis(now = new Date()): Promise<AdminTodayKpisDto> {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const pricing = await platformPricing(this.admin);
    const [paying, addons, collected, pastDue, manualAddons, trials, suspended, newThisMonth] =
      await Promise.all([
        this.admin.tenantSubscription.findMany({
          where: {
            status: { in: ['active', 'past_due'] },
            tenant: { deletedAt: null, billingExempt: false, status: 'active' },
          },
          select: { tenantId: true, status: true, plan: { select: { priceMonthly: true } } },
        }),
        this.admin.tenantSubscriptionAddon.findMany({
          where: {
            suspendedAt: null,
            tenant: { deletedAt: null, billingExempt: false, status: 'active' },
          },
          select: { tenantId: true, priceMonthly: true, quantity: true },
        }),
        this.admin.tenantSubscriptionPayment.aggregate({
          where: { status: 'paid', paidAt: { gte: new Date(now.getTime() - 7 * DAY) } },
          _sum: { amount: true, refundedAmount: true },
        }),
        this.admin.tenantSubscription.findMany({
          where: { status: 'past_due', tenant: { deletedAt: null, billingExempt: false } },
          select: { plan: { select: { priceMonthly: true } } },
        }),
        this.admin.tenantSubscriptionAddon.findMany({
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
          select: { priceMonthly: true, quantity: true },
        }),
        this.admin.tenant.count({ where: { deletedAt: null, status: 'trial' } }),
        this.admin.tenant.count({ where: { deletedAt: null, status: 'suspended' } }),
        this.admin.tenant.count({ where: { deletedAt: null, createdAt: { gte: monthStart } } }),
      ]);
    const addonsBy = new Map<string, number>();
    for (const a of addons) {
      addonsBy.set(
        a.tenantId,
        (addonsBy.get(a.tenantId) ?? 0) + Number(a.priceMonthly) * a.quantity,
      );
    }
    const mrr = paying.reduce(
      (s, p) => s + Number(p.plan.priceMonthly) + (addonsBy.get(p.tenantId) ?? 0),
      0,
    );
    const pending =
      pastDue.reduce((s, p) => s + amountToCharge(Number(p.plan.priceMonthly), pricing), 0) +
      manualAddons.reduce(
        (s, a) => s + amountToCharge(Number(a.priceMonthly) * a.quantity, pricing),
        0,
      );
    return {
      mrr: round2(mrr),
      collected7d: round2(
        Number(collected._sum.amount ?? 0) - Number(collected._sum.refundedAmount ?? 0),
      ),
      pending: round2(pending),
      trials,
      suspended,
      newThisMonth,
    };
  }

  /** Texto del aviso comercial por chat con la actividad indicada (sin cobros). */
  commercialText(items: AdminActivityItemDto[], webBase: string): string | null {
    const relevant = items.filter((i) => i.kind !== 'payment');
    if (relevant.length === 0) return null;
    const lines = relevant
      .slice(0, 15)
      .map(
        (i) => `• ${i.tenantName}: ${i.text}${i.amount !== null ? ` (${eur(i.amount)}/mes)` : ''}`,
      );
    if (relevant.length > 15) lines.push(`… y ${relevant.length - 15} más`);
    return [`Novedades de los tenants`, ...lines, '', `${webBase}/admin/today`].join('\n');
  }
}
