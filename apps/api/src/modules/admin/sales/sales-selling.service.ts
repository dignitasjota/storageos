import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  ApprovalRequestBodySchema,
  type AdminAddonOpportunityDto,
  type AdminApprovalRequestDto,
  type AdminQuoteDto,
  type AdminQuoteInput,
  type SalesAccountDto,
  type SalesAddonClaimDto,
  type SalesAddonOfferInput,
  type SalesApprovalRequestInput,
  type SalesExtendTrialInput,
  type SalesOfferDto,
  type SendAdminQuoteInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { AdminApprovalsService } from '../admin-approvals.service';
import { AdminOpportunitiesService } from '../admin-opportunities.service';
import { AdminQuoteService } from '../admin-quote.service';
import { AdminTenantsService } from '../admin-tenants.service';
import { PlatformLeadsService } from '../leads/platform-leads.service';

import { SalesAccountsService } from './sales-accounts.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesCommissionsService } from './sales-commissions.service';
import { addDaysIso, madridToday, type SalesActor } from './sales-common';

import type { Prisma } from '@storageos/database';

export interface SalesCatalogDto {
  plans: {
    id: string;
    slug: string;
    name: string;
    priceMonthly: number;
    priceYearly: number | null;
  }[];
  addons: { id: string; name: string; description: string | null; priceMonthly: number }[];
  coupons: {
    code: string;
    discountType: string;
    discountValue: number;
    validUntil: string | null;
    durationMonths: number | null;
  }[];
}

/**
 * Lo que puede vender un comercial a su cartera: propuestas de plan y extras
 * (solo con los cupones que la dirección marca), un extra en prueba por
 * cliente, una ampliación de prueba limitada y, para lo demás, pedir
 * aprobación a la dirección.
 */
@Injectable()
export class SalesSellingService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly accounts: SalesAccountsService,
    private readonly assignment: SalesAssignmentService,
    private readonly commissions: SalesCommissionsService,
    private readonly quotes: AdminQuoteService,
    private readonly leads: PlatformLeadsService,
    private readonly opportunitiesSvc: AdminOpportunitiesService,
    private readonly approvals: AdminApprovalsService,
    private readonly tenants: AdminTenantsService,
  ) {}

  private actor(a: SalesActor) {
    return {
      superAdminId: a.repId,
      ipAddress: a.ipAddress ?? null,
      userAgent: a.userAgent ?? null,
    };
  }

  /** Planes, extras y cupones para preparar una propuesta. */
  async catalog(): Promise<SalesCatalogDto> {
    const now = new Date();
    const [plans, addons, coupons] = await Promise.all([
      this.admin.subscriptionPlan.findMany({
        where: { isActive: true, isPublic: true },
        orderBy: { priceMonthly: 'asc' },
        select: { id: true, slug: true, name: true, priceMonthly: true, priceYearly: true },
      }),
      this.admin.subscriptionAddon.findMany({
        where: { isActive: true, isSystem: false },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, description: true, priceMonthly: true },
      }),
      this.admin.platformCoupon.findMany({
        where: {
          salesAllowed: true,
          isActive: true,
          OR: [{ validUntil: null }, { validUntil: { gt: now } }],
        },
        orderBy: { code: 'asc' },
      }),
    ]);
    return {
      plans: plans.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        priceMonthly: Number(p.priceMonthly),
        priceYearly: p.priceYearly != null ? Number(p.priceYearly) : null,
      })),
      addons: addons.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        priceMonthly: Number(a.priceMonthly),
      })),
      coupons: coupons
        .filter((c) => c.maxUses == null || c.usedCount < c.maxUses)
        .map((c) => ({
          code: c.code,
          discountType: c.discountType,
          discountValue: Number(c.discountValue),
          validUntil: c.validUntil?.toISOString() ?? null,
          durationMonths: c.durationMonths,
        })),
    };
  }

  /** Solo los cupones que la dirección deja usar a los comerciales. */
  private async assertCoupon(code: string | undefined): Promise<void> {
    if (!code?.trim()) return;
    const coupon = await this.admin.platformCoupon.findUnique({
      where: { code: code.trim().toUpperCase() },
      select: { salesAllowed: true },
    });
    if (!coupon?.salesAllowed) {
      throw new ForbiddenException({
        code: 'coupon_not_allowed',
        message: 'Ese cupón no lo pueden usar los comerciales',
      });
    }
  }

  async simulate(input: AdminQuoteInput, tenantId: string | null): Promise<AdminQuoteDto> {
    await this.assertCoupon(input.couponCode);
    return this.quotes.quote(input, tenantId);
  }

  async offers(repId: string): Promise<SalesOfferDto[]> {
    return this.quotes.listOffersWhere({ superAdminId: repId });
  }

  async sendQuote(
    repId: string,
    leadId: string,
    input: SendAdminQuoteInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const lead = await this.assignment.leadOf(repId, leadId);
    if (lead.tenantId) await this.assignment.clientOf(repId, lead.tenantId);
    await this.assertCoupon(input.couponCode);
    const sender = await this.accounts.sender(repId);
    // El seguimiento lo lleva su cartera (no el de la ficha del tenant).
    await this.leads.sendQuote(leadId, { ...input, followupDays: 0 }, this.actor(actor), sender);
    await this.accounts.touchContact(leadId, repId, null);
    if (input.followupDays > 0) {
      await this.leads.createFollowup(
        leadId,
        {
          title: 'Llamar por la propuesta',
          note: '',
          dueDate: addDaysIso(madridToday(), input.followupDays),
          assignedToId: repId,
        },
        this.actor(actor),
      );
    }
    return this.accounts.account(repId, leadId);
  }

  async opportunities(repId: string): Promise<AdminAddonOpportunityDto[]> {
    const mine = new Set(
      (
        await this.admin.tenant.findMany({
          where: { salesRepId: repId, deletedAt: null },
          select: { id: true },
        })
      ).map((t) => t.id),
    );
    if (mine.size === 0) return [];
    const all = await this.opportunitiesSvc.opportunities(new Date(), [...mine]);
    return all
      .map((o) => ({ ...o, candidates: o.candidates.filter((c) => mine.has(c.tenantId)) }))
      .filter((o) => o.candidates.length > 0);
  }

  /** Propone un extra (con prueba si aún no ha usado la suya). */
  async addonOffer(
    repId: string,
    tenantId: string,
    input: SalesAddonOfferInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    await this.assignment.clientOf(repId, tenantId);
    const leadId = await this.assignment.ensureLeadForTenant(tenantId);
    const settings = await this.assignment.settings();
    if (input.trial) {
      // Se reserva antes de darla: dos peticiones a la vez no dan dos pruebas.
      const reserved =
        settings.repAddonTrialDays > 0 &&
        (await this.reserveProfile(
          leadId,
          repId,
          { addonTrials: { lt: 1 } },
          {
            addonTrials: { increment: 1 },
          },
        ));
      if (!reserved) {
        throw new ForbiddenException({
          code: 'addon_trial_limit',
          message:
            'Este cliente ya ha tenido un extra en prueba. Para otro, pídeselo a la dirección.',
        });
      }
    }
    let res: Awaited<ReturnType<typeof this.opportunitiesSvc.propose>>;
    try {
      res = await this.opportunitiesSvc.propose(
        tenantId,
        {
          addonId: input.addonId,
          ...(input.message ? { message: input.message } : {}),
          ...(input.trial ? { trialDays: settings.repAddonTrialDays } : {}),
          followupDays: 0,
        },
        this.actor(actor),
      );
    } catch (err) {
      if (input.trial) {
        await this.admin.salesAccountProfile.update({
          where: { leadId },
          data: { addonTrials: { decrement: 1 } },
        });
      }
      throw err;
    }
    const addon = await this.admin.subscriptionAddon.findUnique({
      where: { id: input.addonId },
      select: { name: true },
    });
    await this.admin.platformLeadActivity.create({
      data: {
        leadId,
        type: 'email_out',
        superAdminId: repId,
        subject: `Propuesta del extra ${addon?.name ?? ''}`.trim(),
        content: `Propuesta del extra «${addon?.name ?? ''}»${
          res.trialExpiresAt ? ` con prueba gratis hasta el ${res.trialExpiresAt.slice(0, 10)}` : ''
        }.${input.message ? `\n\n${input.message}` : ''}`,
      },
    });
    await this.accounts.touchContact(leadId, repId, null);
    if (input.followupDays > 0) {
      await this.leads.createFollowup(
        leadId,
        {
          title: `Llamar por la propuesta de ${addon?.name ?? 'un extra'}`,
          note: '',
          dueDate: addDaysIso(madridToday(), input.followupDays),
          assignedToId: repId,
        },
        this.actor(actor),
      );
    }
    return this.accounts.account(repId, leadId);
  }

  /** Suma al contador de la ficha solo si se cumple la condición (sin carreras). */
  private async reserveProfile(
    leadId: string,
    repId: string,
    where: Prisma.SalesAccountProfileWhereInput,
    data: Prisma.SalesAccountProfileUpdateManyMutationInput,
  ): Promise<boolean> {
    await this.admin.salesAccountProfile.upsert({
      where: { leadId },
      create: { leadId, updatedById: repId },
      update: {},
    });
    const { count } = await this.admin.salesAccountProfile.updateMany({
      where: { leadId, ...where },
      data: { ...data, updatedById: repId },
    });
    return count > 0;
  }

  /** Amplía la prueba hasta el tope de la dirección (contando lo ya ampliado). */
  async extendTrial(
    repId: string,
    tenantId: string,
    input: SalesExtendTrialInput,
    actor: SalesActor,
  ): Promise<SalesAccountDto> {
    const tenant = await this.assignment.clientOf(repId, tenantId);
    if (tenant.status !== 'trial') {
      throw new BadRequestException({
        code: 'tenant_not_in_trial',
        message: 'Solo se puede ampliar la prueba de un cliente que está en prueba',
      });
    }
    const leadId = await this.assignment.ensureLeadForTenant(tenantId);
    const settings = await this.assignment.settings();
    // Se reserva antes de ampliar: dos peticiones a la vez no se saltan el tope.
    const reserved =
      input.days <= settings.repTrialExtensionDays &&
      (await this.reserveProfile(
        leadId,
        repId,
        { trialExtensionDays: { lte: settings.repTrialExtensionDays - input.days } },
        { trialExtensionDays: { increment: input.days } },
      ));
    if (!reserved) {
      const used =
        (await this.admin.salesAccountProfile.findUnique({ where: { leadId } }))
          ?.trialExtensionDays ?? 0;
      const remaining = Math.max(0, settings.repTrialExtensionDays - used);
      throw new ForbiddenException({
        code: 'trial_extension_limit',
        message:
          remaining > 0
            ? `Puedes ampliarla ${remaining} días más. Para más, pídeselo a la dirección.`
            : 'Ya has ampliado todo lo que puedes. Para más, pídeselo a la dirección.',
        details: { remaining },
      });
    }
    try {
      await this.tenants.extendTrial(tenantId, {
        superAdminId: repId,
        reason: input.reason,
        days: input.days,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
    } catch (err) {
      await this.admin.salesAccountProfile.update({
        where: { leadId },
        data: { trialExtensionDays: { decrement: input.days } },
      });
      throw err;
    }
    await this.admin.platformLeadActivity.create({
      data: {
        leadId,
        type: 'system',
        superAdminId: repId,
        content: `Prueba ampliada ${input.days} días: ${input.reason}`,
      },
    });
    return this.accounts.account(repId, leadId);
  }

  /** Pide a la dirección lo que pasa de sus topes (más prueba, cambio de plan, un extra). */
  async requestApproval(
    repId: string,
    input: SalesApprovalRequestInput,
    actor: SalesActor,
  ): Promise<AdminApprovalRequestDto> {
    await this.assignment.clientOf(repId, input.tenantId);
    const request = ApprovalRequestBodySchema.parse(input.request);
    const dto = await this.approvals.create(
      { tenantId: input.tenantId, reason: input.reason, request },
      this.actor(actor),
    );
    const leadId = await this.assignment.ensureLeadForTenant(input.tenantId);
    await this.admin.platformLeadActivity.create({
      data: {
        leadId,
        type: 'system',
        superAdminId: repId,
        content: `Pedida aprobación a la dirección: ${dto.summary} — ${input.reason}`,
      },
    });
    return dto;
  }

  async myApprovals(repId: string): Promise<AdminApprovalRequestDto[]> {
    return this.approvals.list({ requestedById: repId });
  }

  async claims(repId: string): Promise<SalesAddonClaimDto[]> {
    await this.commissions.syncClaims();
    return this.commissions.claims({ repId });
  }
}
