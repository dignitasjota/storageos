import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDaysToDay,
  opportunityOfferStatus,
  type AdminAddonOpportunityDto,
  type AdminAddonOpportunityRowDto,
  type AdminOpportunitiesOverviewDto,
  type AdminOpportunityDismissalDto,
  type AdminOpportunityOfferStateDto,
  type AdminTenantOpportunityDto,
  type BulkProposeAddonInput,
  type BulkProposePreviewDto,
  type BulkProposeResultDto,
  type BulkProposeSkipDto,
  type DismissAddonOpportunityInput,
  type HandOffOpportunityInput,
  type HandOffOpportunityResultDto,
} from '@storageos/shared';

import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminOpportunitiesService } from './admin-opportunities.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { PlatformLeadsService } from './leads/platform-leads.service';
import { madridToday } from './sales/sales-common';
import { SalesNotifyService } from './sales/sales-notify.service';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';

const DAY = 86_400_000;
/** No se vuelve a proponer el mismo extra al mismo tenant antes de estos días. */
const OFFER_COOLDOWN_DAYS = 14;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface OpportunityActor {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Oportunidades con lo que hace falta para venderlas: ingreso posible, vista
 * por tenant, candidatos descartados, estado de cada propuesta y tasa de
 * aceptación, propuesta a varios a la vez y paso al comercial.
 */
@Injectable()
export class AdminOpportunitiesOpsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly opps: AdminOpportunitiesService,
    private readonly lifecycle: TenantLifecycleEmailsService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly leads: PlatformLeadsService,
    private readonly notify: SalesNotifyService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  /** Descartes en vigor, por `tenant:extra`. */
  private async activeDismissals(now: Date) {
    return this.admin.platformOpportunityDismissal.findMany({
      where: { OR: [{ until: null }, { until: { gt: now } }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Estado de la última propuesta de cada `tenant:extra` (180 días) y, por
   * extra, las de los últimos 90 días con cuántas acabaron contratadas o en
   * prueba.
   */
  private async offerStates(now: Date) {
    const since180 = new Date(now.getTime() - 180 * DAY);
    const since90 = new Date(now.getTime() - 90 * DAY);
    const offers = await this.admin.platformAddonOffer.findMany({
      where: { sentAt: { gte: since180 } },
      orderBy: { sentAt: 'desc' },
      select: { tenantId: true, addonId: true, sentAt: true, trialUntil: true },
    });
    const tenantIds = [...new Set(offers.map((o) => o.tenantId))];
    const [owned, trials] = tenantIds.length
      ? await Promise.all([
          this.admin.tenantSubscriptionAddon.findMany({
            where: { tenantId: { in: tenantIds }, suspendedAt: null },
            select: { tenantId: true, addonId: true, createdAt: true },
          }),
          this.admin.tenantFeatureOverride.findMany({
            where: {
              tenantId: { in: tenantIds },
              source: 'trial',
              trialAddonId: { not: null },
              expiresAt: { gt: now },
            },
            select: { tenantId: true, trialAddonId: true },
          }),
        ])
      : [[], []];
    const ownedAt = new Map(owned.map((o) => [`${o.tenantId}:${o.addonId}`, o.createdAt]));
    const trialing = new Set(trials.map((t) => `${t.tenantId}:${t.trialAddonId}`));
    const latest = new Map<string, AdminOpportunityOfferStateDto>();
    const acceptance = new Map<string, { sent: number; won: number; trialing: number }>();
    for (const o of offers) {
      const key = `${o.tenantId}:${o.addonId}`;
      const contracted = ownedAt.get(key);
      const status = opportunityOfferStatus({
        sentAt: o.sentAt,
        hasAddon: !!contracted && contracted >= o.sentAt,
        trialing: trialing.has(key),
        now,
      });
      if (!latest.has(key)) {
        latest.set(key, {
          status,
          sentAt: o.sentAt.toISOString(),
          trialUntil: o.trialUntil?.toISOString() ?? null,
        });
      }
      if (o.sentAt >= since90) {
        const a = acceptance.get(o.addonId) ?? { sent: 0, won: 0, trialing: 0 };
        a.sent += 1;
        if (status === 'won') a.won += 1;
        if (status === 'trialing') a.trialing += 1;
        acceptance.set(o.addonId, a);
      }
    }
    return { latest, acceptance };
  }

  async overview(now = new Date()): Promise<AdminOpportunitiesOverviewDto> {
    const [base, dismissals, states, pricing] = await Promise.all([
      this.opps.opportunities(now) as Promise<AdminAddonOpportunityDto[]>,
      this.activeDismissals(now),
      this.offerStates(now),
      platformPricing(this.admin),
    ]);
    const dismissed = new Set(dismissals.map((d) => `${d.tenantId}:${d.addonId}`));
    const tenantIds = [...new Set(base.flatMap((a) => a.candidates.map((c) => c.tenantId)))];
    const reps = tenantIds.length
      ? await this.admin.tenant.findMany({
          where: { id: { in: tenantIds }, salesRepId: { not: null } },
          select: { id: true, salesRepId: true, salesRep: { select: { fullName: true } } },
        })
      : [];
    const repBy = new Map(reps.map((r) => [r.id, r]));

    const addons: AdminAddonOpportunityRowDto[] = base
      .map((a) => {
        const candidates = a.candidates
          .filter((c) => !dismissed.has(`${c.tenantId}:${a.addonId}`))
          .map((c) => ({
            ...c,
            offer: states.latest.get(`${c.tenantId}:${a.addonId}`) ?? null,
            salesRepId: repBy.get(c.tenantId)?.salesRepId ?? null,
            salesRepName: repBy.get(c.tenantId)?.salesRep?.fullName ?? null,
          }));
        const acc = states.acceptance.get(a.addonId) ?? { sent: 0, won: 0, trialing: 0 };
        return {
          ...a,
          candidates,
          potentialMonthly: round2(a.priceMonthly * candidates.length),
          acceptance: {
            ...acc,
            ratePct: acc.sent > 0 ? Math.round((acc.won / acc.sent) * 100) : null,
          },
        };
      })
      .sort((x, y) => y.potentialMonthly - x.potentialMonthly);

    const byTenantMap = new Map<string, AdminTenantOpportunityDto>();
    for (const a of addons) {
      for (const c of a.candidates) {
        const t = byTenantMap.get(c.tenantId) ?? {
          tenantId: c.tenantId,
          tenantName: c.tenantName,
          tenantStatus: c.tenantStatus,
          planName: c.planName,
          salesRepId: c.salesRepId,
          salesRepName: c.salesRepName,
          addons: [],
          potentialMonthly: 0,
        };
        t.addons.push({
          addonId: a.addonId,
          addonName: a.addonName,
          feature: a.feature,
          priceMonthly: a.priceMonthly,
          reasons: c.reasons,
          interestCount: c.interestCount,
          offer: c.offer,
        });
        t.potentialMonthly = round2(t.potentialMonthly + a.priceMonthly);
        byTenantMap.set(c.tenantId, t);
      }
    }
    const byTenant = [...byTenantMap.values()].sort(
      (x, y) => y.potentialMonthly - x.potentialMonthly || x.tenantName.localeCompare(y.tenantName),
    );

    return {
      addons,
      byTenant,
      dismissals: await this.dismissalDtos(dismissals),
      totals: {
        candidates: addons.reduce((n, a) => n + a.candidates.length, 0),
        tenants: byTenant.length,
        potentialMonthly: round2(addons.reduce((n, a) => n + a.potentialMonthly, 0)),
      },
      pricesIncludeVat: pricing.includeVat,
    };
  }

  private async dismissalDtos(
    rows: {
      id: string;
      tenantId: string;
      addonId: string;
      until: Date | null;
      reason: string;
      createdById: string | null;
      createdAt: Date;
    }[],
  ): Promise<AdminOpportunityDismissalDto[]> {
    if (rows.length === 0) return [];
    const [tenants, addons, admins] = await Promise.all([
      this.admin.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } },
        select: { id: true, name: true },
      }),
      this.admin.subscriptionAddon.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.addonId))] } },
        select: { id: true, name: true },
      }),
      this.admin.superAdmin.findMany({
        where: { id: { in: rows.flatMap((r) => (r.createdById ? [r.createdById] : [])) } },
        select: { id: true, fullName: true },
      }),
    ]);
    const tName = new Map(tenants.map((t) => [t.id, t.name]));
    const aName = new Map(addons.map((a) => [a.id, a.name]));
    const who = new Map(admins.map((a) => [a.id, a.fullName]));
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      tenantName: tName.get(r.tenantId) ?? '—',
      addonId: r.addonId,
      addonName: aName.get(r.addonId) ?? '—',
      until: r.until?.toISOString() ?? null,
      reason: r.reason,
      createdByName: r.createdById ? (who.get(r.createdById) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ----------------------------------------------------------------- descartes

  async dismiss(
    input: DismissAddonOpportunityInput,
    actor: OpportunityActor,
    now = new Date(),
  ): Promise<AdminOpportunityDismissalDto> {
    const [tenant, addon] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } }),
      this.admin.subscriptionAddon.findUnique({
        where: { id: input.addonId },
        select: { id: true },
      }),
    ]);
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if (!addon) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Extra no encontrado' });
    }
    const until = input.days ? new Date(now.getTime() + input.days * DAY) : null;
    const row = await this.admin.platformOpportunityDismissal.upsert({
      where: { tenantId_addonId: { tenantId: input.tenantId, addonId: input.addonId } },
      create: {
        tenantId: input.tenantId,
        addonId: input.addonId,
        until,
        reason: input.reason,
        createdById: actor.superAdminId,
      },
      update: { until, reason: input.reason, createdById: actor.superAdminId, createdAt: now },
    });
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.opportunity.dismissed',
      targetType: 'tenant',
      targetId: input.tenantId,
      targetTenantId: input.tenantId,
      changes: { addonId: input.addonId, days: input.days, reason: input.reason },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    const [dto] = await this.dismissalDtos([row]);
    return dto!;
  }

  async undismiss(id: string, actor: OpportunityActor): Promise<void> {
    const row = await this.admin.platformOpportunityDismissal.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({
        code: 'dismissal_not_found',
        message: 'Descarte no encontrado',
      });
    }
    await this.admin.platformOpportunityDismissal.delete({ where: { id } });
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.opportunity.restored',
      targetType: 'tenant',
      targetId: row.tenantId,
      targetTenantId: row.tenantId,
      changes: { addonId: row.addonId },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  // ------------------------------------------------------ propuesta a varios

  /** A quién saldría y a quién se salta (y por qué), sin enviar nada. */
  async bulkPreview(
    input: Pick<BulkProposeAddonInput, 'addonId' | 'tenantIds'>,
    now = new Date(),
  ): Promise<BulkProposePreviewDto> {
    const addon = await this.admin.subscriptionAddon.findUnique({ where: { id: input.addonId } });
    if (!addon || !addon.isActive) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Extra no encontrado' });
    }
    const ids = [...new Set(input.tenantIds)];
    const since = new Date(now.getTime() - OFFER_COOLDOWN_DAYS * DAY);
    const [tenants, owned, dismissed, recent] = await Promise.all([
      this.admin.tenant.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, status: true, deletedAt: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId: { in: ids }, addonId: addon.id, suspendedAt: null },
        select: { tenantId: true },
      }),
      this.admin.platformOpportunityDismissal.findMany({
        where: {
          tenantId: { in: ids },
          addonId: addon.id,
          OR: [{ until: null }, { until: { gt: now } }],
        },
        select: { tenantId: true },
      }),
      this.admin.platformAddonOffer.findMany({
        where: { tenantId: { in: ids }, addonId: addon.id, sentAt: { gte: since } },
        select: { tenantId: true, sentAt: true },
      }),
    ]);
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const ownedSet = new Set(owned.map((o) => o.tenantId));
    const dismissedSet = new Set(dismissed.map((d) => d.tenantId));
    const recentBy = new Map(recent.map((r) => [r.tenantId, r.sentAt]));
    const willSend: BulkProposePreviewDto['willSend'] = [];
    const skipped: BulkProposeSkipDto[] = [];
    for (const id of ids) {
      const t = byId.get(id);
      const name = t?.name ?? '—';
      const skip = (reason: string) => skipped.push({ tenantId: id, tenantName: name, reason });
      if (!t || t.deletedAt) {
        skip('No existe');
        continue;
      }
      if (t.status !== 'active' && t.status !== 'trial') {
        skip('Está suspendido o de baja');
        continue;
      }
      if (ownedSet.has(id)) {
        skip('Ya tiene este extra');
        continue;
      }
      if (dismissedSet.has(id)) {
        skip('Descartado: no le interesa');
        continue;
      }
      const sentAt = recentBy.get(id);
      if (sentAt) {
        const days = Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / DAY));
        skip(days === 0 ? 'Se le propuso hoy' : `Se le propuso hace ${days} días`);
        continue;
      }
      const recipients = (await this.lifecycle.addonOfferRecipients(id)).length;
      if (recipients === 0) {
        skip('No tiene a quién escribir');
        continue;
      }
      willSend.push({ tenantId: id, tenantName: name, recipients });
    }
    return { willSend, skipped, emails: willSend.reduce((n, w) => n + w.recipients, 0) };
  }

  async bulkPropose(
    input: BulkProposeAddonInput,
    actor: OpportunityActor,
  ): Promise<BulkProposeResultDto> {
    const preview = await this.bulkPreview(input);
    const skipped = [...preview.skipped];
    let sent = 0;
    let emails = 0;
    for (const w of preview.willSend) {
      try {
        const res = await this.opps.propose(
          w.tenantId,
          {
            addonId: input.addonId,
            followupDays: input.followupDays,
            ...(input.message ? { message: input.message } : {}),
            ...(input.trialDays ? { trialDays: input.trialDays } : {}),
          },
          { ...actor, source: 'bulk' },
        );
        sent += 1;
        emails += res.recipients;
      } catch (err) {
        const message =
          (err as { response?: { message?: string } }).response?.message ??
          (err instanceof Error ? err.message : 'No se pudo enviar');
        skipped.push({ tenantId: w.tenantId, tenantName: w.tenantName, reason: message });
      }
    }
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.saas_addon.bulk_proposed',
      targetType: 'platform',
      targetId: input.addonId,
      targetTenantId: null,
      changes: { addonId: input.addonId, selected: input.tenantIds.length, sent, emails },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return { sent, emails, skipped };
  }

  // ------------------------------------------------------- pasar al comercial

  /**
   * Pasa la oportunidad al comercial del tenant: un seguimiento en su
   * prospecto (si el tenant viene de uno), una nota en la conversación del
   * tenant y un aviso en su campana.
   */
  async handOff(
    input: HandOffOpportunityInput,
    actor: OpportunityActor,
  ): Promise<HandOffOpportunityResultDto> {
    const [tenant, addon] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: input.tenantId },
        select: {
          id: true,
          name: true,
          deletedAt: true,
          salesRepId: true,
          salesRep: { select: { fullName: true, isActive: true } },
        },
      }),
      this.admin.subscriptionAddon.findUnique({
        where: { id: input.addonId },
        select: { id: true, name: true },
      }),
    ]);
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if (!addon) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Extra no encontrado' });
    }
    if (!tenant.salesRepId || !tenant.salesRep?.isActive) {
      throw new BadRequestException({
        code: 'no_sales_rep',
        message: 'Este tenant no tiene un comercial activo.',
      });
    }
    const repId = tenant.salesRepId;
    const title = `Ofrecer ${addon.name} a ${tenant.name}`;
    const lead = await this.admin.platformLead.findFirst({
      where: { tenantId: tenant.id, discardedAt: null },
      select: { id: true },
    });
    let followupId: string | null = null;
    if (lead) {
      const before = new Date();
      await this.leads.createFollowup(
        lead.id,
        {
          title,
          dueDate: addDaysToDay(madridToday(), 2),
          assignedToId: repId,
          ...(input.note ? { note: input.note } : {}),
        },
        actor,
      );
      const created = await this.admin.platformLeadFollowup.findFirst({
        where: { leadId: lead.id, superAdminId: actor.superAdminId, createdAt: { gte: before } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      followupId = created?.id ?? null;
      await this.admin.platformLeadActivity.create({
        data: {
          leadId: lead.id,
          superAdminId: actor.superAdminId,
          type: 'direction',
          subject: 'Oportunidad de la dirección',
          content: `${title}.${input.note ? `\n${input.note}` : ''}`,
        },
      });
    }
    await this.interactions.create({
      tenantId: tenant.id,
      superAdminId: actor.superAdminId,
      input: {
        type: 'note',
        content: `Oportunidad «${addon.name}» pasada a ${tenant.salesRep.fullName}.${
          input.note ? `\n${input.note}` : ''
        }`,
      },
    });
    await this.notify.rep(repId, {
      type: 'sales.opportunity',
      title: `Oportunidad: ${addon.name} para ${tenant.name}`,
      body: input.note ?? null,
      link: lead ? `/admin/sales/accounts/${lead.id}` : '/admin/sales/opportunities',
    });
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.opportunity.handed_off',
      targetType: 'tenant',
      targetId: tenant.id,
      targetTenantId: tenant.id,
      changes: { addonId: addon.id, salesRepId: repId, followupId },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return { salesRepName: tenant.salesRep.fullName, followupId };
  }
}
