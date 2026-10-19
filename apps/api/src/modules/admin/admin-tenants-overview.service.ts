import { Injectable } from '@nestjs/common';

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
    const [rows, addons, logins, followups, facilities, units, contracts, owners, health] =
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
            subscription: {
              select: {
                status: true,
                billingMode: true,
                currentPeriodEnd: true,
                plan: { select: { slug: true, name: true, priceMonthly: true } },
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
        this.admin.user.groupBy({ by: ['tenantId'], _max: { lastLoginAt: true } }),
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
      ]);

    const addonsBy = new Map<string, typeof addons>();
    for (const a of addons) {
      const list = addonsBy.get(a.tenantId) ?? [];
      list.push(a);
      addonsBy.set(a.tenantId, list);
    }
    const loginBy = new Map(logins.map((l) => [l.tenantId, l._max.lastLoginAt ?? null]));
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
      const addonsMonthly = tenantAddons
        .filter((a) => !a.suspendedAt)
        .reduce((sum, a) => sum + Number(a.priceMonthly) * a.quantity, 0);
      const planMonthly = sub?.plan ? Number(sub.plan.priceMonthly) : 0;
      const paying = !t.billingExempt && t.status !== 'trial' && t.status !== 'cancelled' && !!sub;
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
        monthly: t.billingExempt ? 0 : Math.round((planMonthly + addonsMonthly) * 100) / 100,
        addons: tenantAddons.map((a) => ({
          slug: a.addon.slug,
          name: a.addon.name,
          suspended: !!a.suspendedAt,
        })),
        nextChargeAt: paying && sub?.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
        overdueSince:
          !t.billingExempt && sub?.status === 'past_due'
            ? (sub.currentPeriodEnd?.toISOString() ?? null)
            : null,
        healthScore: h?.score ?? null,
        healthLevel: h?.level ?? null,
        lastTeamLoginAt: loginBy.get(t.id)?.toISOString() ?? null,
        nextFollowup: followup
          ? { title: followup.title, dueDate: followup.dueDate.toISOString().slice(0, 10) }
          : null,
        facilities: facilitiesBy.get(t.id) ?? 0,
        units: unitsBy.get(t.id) ?? 0,
        activeContracts: contractsBy.get(t.id) ?? 0,
        ownerEmail: owner?.email ?? null,
        ownerPhone: owner?.phone ?? null,
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
