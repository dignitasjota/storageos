import { Injectable } from '@nestjs/common';

import { isPayingSubscription, loadMrrContext, mrrFor } from '../../common/saas-metrics';
import { lastTeamActivityByTenant } from '../../common/team-activity';
import { subscriptionDueDate } from '../billing-saas/platform-due';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantsService } from './admin-tenants.service';

import type { AdminSearchResultDto, AdminTenantOverviewDto } from '@storageos/shared';

/**
 * Visión general de los tenants para el super admin: una fila por tenant con
 * lo que aporta, sus extras, el próximo cobro, si debe algo, su salud, la
 * actividad del equipo y el siguiente seguimiento. Pocas consultas agregadas
 * (no una por tenant); la lista se filtra y ordena en el navegador.
 */
@Injectable()
export class AdminTenantsOverviewService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
  ) {}

  async overview(): Promise<AdminTenantOverviewDto[]> {
    const [rows, addons, logins, followups, facilities, units, contracts, owners, health, ctx] =
      await Promise.all([
        this.admin.tenant.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            billingExempt: true,
            createdAt: true,
            trialEndsAt: true,
            tags: true,
            ltvTier: true,
            taxId: true,
            billingEmail: true,
            subscription: {
              select: {
                status: true,
                billingMode: true,
                currentPeriodStart: true,
                currentPeriodEnd: true,
                stripeSubscriptionId: true,
                manualExtensionDays: true,
                cancelAtPeriodEnd: true,
                plan: { select: { slug: true, name: true, priceMonthly: true, priceYearly: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 5000,
        }),
        this.admin.tenantSubscriptionAddon.findMany({
          select: {
            tenantId: true,
            priceMonthly: true,
            quantity: true,
            suspendedAt: true,
            addon: { select: { slug: true, name: true } },
          },
        }),
        // Último uso real del equipo (solo usuarios activos: un ex-empleado que
        // entró ayer no tapa a un equipo que no entra).
        lastTeamActivityByTenant(this.admin),
        this.admin.tenantFollowup.findMany({
          where: { status: 'pending' },
          select: { tenantId: true, title: true, dueDate: true },
          orderBy: { dueDate: 'asc' },
        }),
        this.admin.facility.groupBy({
          by: ['tenantId'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        this.admin.unit.groupBy({ by: ['tenantId'], _count: { _all: true } }),
        this.admin.contract.groupBy({
          by: ['tenantId'],
          where: { deletedAt: null, status: { in: ['active', 'ending'] } },
          _count: { _all: true },
        }),
        this.admin.user.findMany({
          where: { role: 'owner', isActive: true },
          select: { tenantId: true, email: true, phone: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.tenants.getTenantsHealth(),
        loadMrrContext(this.admin),
      ]);

    const addonsBy = new Map<string, typeof addons>();
    for (const a of addons) {
      const list = addonsBy.get(a.tenantId) ?? [];
      list.push(a);
      addonsBy.set(a.tenantId, list);
    }
    const loginBy = logins;
    const followupBy = new Map<string, { title: string; dueDate: Date }>();
    for (const f of followups) if (!followupBy.has(f.tenantId)) followupBy.set(f.tenantId, f);
    const facilitiesBy = new Map(facilities.map((f) => [f.tenantId, f._count._all]));
    const unitsBy = new Map(units.map((u) => [u.tenantId, u._count._all]));
    const contractsBy = new Map(contracts.map((c) => [c.tenantId, c._count._all]));
    const ownerBy = new Map<string, { email: string; phone: string | null }>();
    for (const o of owners) if (!ownerBy.has(o.tenantId)) ownerBy.set(o.tenantId, o);
    const healthBy = new Map(health.map((h) => [h.tenantId, h]));

    return rows.map((t) => {
      const sub = t.subscription;
      const tenantAddons = addonsBy.get(t.id) ?? [];
      // Lo que aporta al mes sin IVA: la misma cuenta que el MRR (`tenantMrr`) y
      // el mismo criterio que Adopción y Salud: solo si paga de verdad. En prueba
      // aporta 0 y se enseña aparte lo que pagaría.
      const mrr = sub ? mrrFor(ctx, t.id, sub).total : 0;
      const contributes = isPayingSubscription(sub, t) && mrr > 0;
      const monthly = contributes ? mrr : 0;
      const wouldPay = t.status === 'trial' && !t.billingExempt && mrr > 0 ? mrr : null;
      // En solo lectura (prueba o plan gratuito terminados sin pagar) no paga.
      const paying = !t.billingExempt && t.status === 'active' && !!sub && sub.status !== 'expired';
      const followup = followupBy.get(t.id);
      const owner = ownerBy.get(t.id);
      const h = healthBy.get(t.id);
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        billingExempt: t.billingExempt,
        createdAt: t.createdAt.toISOString(),
        trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
        tags: t.tags,
        ltvTier: t.ltvTier ?? null,
        planSlug: sub?.plan?.slug ?? null,
        planName: sub?.plan?.name ?? null,
        subscriptionStatus: sub?.status ?? null,
        billingMode: sub?.billingMode ?? null,
        monthly,
        wouldPay,
        addons: tenantAddons.map((a) => ({
          slug: a.addon.slug,
          name: a.addon.name,
          suspended: !!a.suspendedAt,
        })),
        // Sin cobro que esperar: plan gratuito o a 0 €, o se da de baja al
        // acabar el periodo (entonces la fecha es la de la baja).
        nextChargeAt:
          paying && mrr > 0 && !sub?.cancelAtPeriodEnd && sub?.currentPeriodEnd
            ? sub.currentPeriodEnd.toISOString()
            : null,
        cancelsAt:
          paying && sub?.cancelAtPeriodEnd && sub.currentPeriodEnd
            ? sub.currentPeriodEnd.toISOString()
            : null,
        // Desde cuándo debe, como en Cobros pendientes (con Stripe, desde el
        // inicio del periodo del cobro que falló).
        overdueSince:
          !t.billingExempt && sub?.status === 'past_due'
            ? subscriptionDueDate(sub).toISOString()
            : null,
        healthScore: h?.score ?? null,
        healthLevel: h?.level ?? null,
        // En prueba la puntuación es de activación (otra escala).
        healthKind: h?.kind ?? null,
        lastTeamLoginAt: loginBy.get(t.id)?.toISOString() ?? null,
        nextFollowup: followup
          ? { title: followup.title, dueDate: followup.dueDate.toISOString().slice(0, 10) }
          : null,
        facilities: facilitiesBy.get(t.id) ?? 0,
        units: unitsBy.get(t.id) ?? 0,
        activeContracts: contractsBy.get(t.id) ?? 0,
        ownerEmail: owner?.email ?? null,
        ownerPhone: owner?.phone ?? null,
        taxId: t.taxId,
        billingEmail: t.billingEmail,
      };
    });
  }

  /**
   * Búsqueda global del panel (⌘K): tenants por nombre, slug, NIF, email de
   * facturación, dominio propio o email de cualquiera de sus usuarios; y
   * tickets de soporte por asunto.
   */
  async search(q: string): Promise<AdminSearchResultDto> {
    const term = q.trim();
    if (term.length < 2) return { tenants: [], tickets: [] };
    const like = { contains: term, mode: 'insensitive' as const };
    const [direct, byUser, tickets] = await Promise.all([
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: like },
            { slug: like },
            { taxId: like },
            { billingEmail: like },
            { customDomain: like },
            { billingLegalName: like },
          ],
        },
        select: { id: true, name: true, slug: true, status: true },
        orderBy: { name: 'asc' },
        take: 8,
      }),
      this.admin.user.findMany({
        where: { OR: [{ email: like }, { fullName: like }, { phone: like }] },
        select: {
          email: true,
          fullName: true,
          tenant: { select: { id: true, name: true, slug: true, status: true, deletedAt: true } },
        },
        take: 8,
      }),
      this.admin.supportTicket.findMany({
        where: { subject: like },
        select: {
          id: true,
          subject: true,
          status: true,
          tenantId: true,
          tenant: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);
    const tenants = new Map<string, AdminSearchResultDto['tenants'][number]>();
    for (const t of direct) tenants.set(t.id, { ...t, match: null });
    for (const u of byUser) {
      if (u.tenant.deletedAt || tenants.has(u.tenant.id)) continue;
      tenants.set(u.tenant.id, {
        id: u.tenant.id,
        name: u.tenant.name,
        slug: u.tenant.slug,
        status: u.tenant.status,
        match: `${u.fullName} · ${u.email}`,
      });
    }
    return {
      tenants: [...tenants.values()].slice(0, 10),
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        tenantId: t.tenantId,
        tenantName: t.tenant.name,
      })),
    };
  }
}
