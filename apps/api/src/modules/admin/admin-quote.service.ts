import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  addonUnitPrice,
  EXTRA_UNITS_ADDON_SLUG,
  extraUnitsFor,
  parseAddonPriceTiers,
  platformLeadName,
  resolvePlanFeatures,
  SALES_CODE_PARAM,
  type TenantFeature,
} from '@storageos/shared';

import { offerKey, signOffer, verifyOffer } from '../../common/sales/offer-token';
import { billableUnits } from '../billing-saas/billable-units';
import { PlatformCouponsService } from '../billing-saas/platform-coupons.service';
import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';
import type {
  AdminQuoteDto,
  AdminQuoteInput,
  PlatformQuoteOfferDto,
  PlatformQuoteOffersDto,
  QuoteOfferStatus,
  SendAdminQuoteInput,
} from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;

const OFFER_INCLUDE = {
  tenant: { select: { name: true } },
  plan: { select: { name: true } },
  lead: {
    select: {
      email: true,
      companyName: true,
      contactName: true,
      salesRep: { select: { salesCode: true, isActive: true } },
    },
  },
} satisfies Prisma.PlatformQuoteOfferInclude;
const DAY = 86_400_000;
/** Lo que vale una propuesta desde que se envía. */
export const QUOTE_OFFER_VALID_DAYS = 15;

/** Remitente de la propuesta: el comercial que la envía. */
export interface QuoteOfferSender {
  fromName: string;
  replyTo: { email: string; name?: string };
  signature?: string;
}

/**
 * Simulador de cuota: plan + extras + ciclo (mensual o anual) + cupón, con el
 * IVA según cómo vayan los precios de la plataforma; y envío al tenant como
 * propuesta (correo, conversación, seguimiento).
 */
@Injectable()
export class AdminQuoteService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly coupons: PlatformCouponsService,
    private readonly lifecycle: TenantLifecycleEmailsService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly followups: AdminTenantFollowupsService,
    private readonly audit: SuperAdminAuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async quote(input: AdminQuoteInput, tenantId: string | null = null): Promise<AdminQuoteDto> {
    const plan = await this.admin.subscriptionPlan.findUnique({ where: { id: input.planId } });
    if (!plan)
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    const ids = [...new Set(input.addons.map((a) => a.addonId))];
    const addons = ids.length
      ? await this.admin.subscriptionAddon.findMany({ where: { id: { in: ids }, isSystem: false } })
      : [];
    if (addons.length !== ids.length) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Extra no encontrado' });
    }
    const notForPlan = addons.find(
      (a) => a.planSlugs.length > 0 && !a.planSlugs.includes(plan.slug),
    );
    if (notForPlan) {
      throw new BadRequestException({
        code: 'addon_not_for_plan',
        message: `«${notForPlan.name}» no está disponible en el plan ${plan.name}.`,
      });
    }
    if (input.cycle === 'yearly' && plan.includedUnits != null) {
      throw new BadRequestException({
        code: 'yearly_not_available',
        message: 'Este plan se paga por trastero cada mes: no tiene pago anual.',
      });
    }
    const yearly = input.cycle === 'yearly';
    const months = yearly ? 12 : 1;
    // Un plan sin precio anual (0) se cobra al año como 12 cuotas mensuales.
    const monthlyPrice = Number(plan.priceMonthly);
    const hasYearlyPrice = Number(plan.priceYearly) > 0;
    const planYearly = hasYearlyPrice ? Number(plan.priceYearly) : monthlyPrice * 12;
    const lines: { label: string; amount: number }[] = [
      {
        label: `Plan ${plan.name}${yearly ? (hasYearlyPrice ? ' (anual)' : ' (12 meses)') : ''}`,
        amount: round2(yearly ? planYearly : monthlyPrice),
      },
    ];
    // Plan por trastero: los que pasan de los incluidos, a su precio.
    if (plan.includedUnits != null) {
      const units = input.units ?? (tenantId ? await billableUnits(this.admin, tenantId) : 0);
      const extra = extraUnitsFor(units, plan.includedUnits);
      const unitAddon = extra
        ? await this.admin.subscriptionAddon.findUnique({
            where: { slug: EXTRA_UNITS_ADDON_SLUG },
            select: { priceMonthly: true },
          })
        : null;
      if (unitAddon) {
        const price = Number(unitAddon.priceMonthly);
        lines.push({
          label: `Trasteros de más (${extra} × ${price.toLocaleString('es-ES')} €)${yearly ? ' (12 meses)' : ''}`,
          amount: round2(extra * price * months),
        });
      }
    }
    const planFeatures = resolvePlanFeatures(plan);
    const includedAddonIds: string[] = [];
    for (const a of input.addons) {
      const addon = addons.find((x) => x.id === a.addonId)!;
      if (addon.feature && planFeatures.includes(addon.feature as TenantFeature)) {
        includedAddonIds.push(addon.id);
      }
      // Precio del tramo que alcanza la cantidad.
      const unit = addonUnitPrice(
        Number(addon.priceMonthly),
        parseAddonPriceTiers(addon.priceTiers),
        a.quantity,
      );
      const monthly = unit * a.quantity;
      lines.push({
        label: `${addon.name}${a.quantity > 1 ? ` × ${a.quantity}` : ''}${yearly ? ' (12 meses)' : ''}`,
        amount: round2(monthly * months),
      });
    }
    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));

    let discount = 0;
    let couponCode: string | null = null;
    let couponError: string | null = null;
    if (input.couponCode) {
      try {
        discount = (
          await this.coupons.validateAndComputeDiscount(input.couponCode, subtotal, {
            tenantId,
            planId: plan.id,
          })
        ).discount;
        couponCode = input.couponCode.trim().toUpperCase();
      } catch (err) {
        couponError =
          err instanceof HttpException
            ? ((err.getResponse() as { message?: string }).message ?? 'Cupón no válido')
            : 'Cupón no válido';
      }
    }

    const pricing = await platformPricing(this.admin);
    const net = round2(subtotal - discount);
    const rate = pricing.taxRate / 100;
    const base = pricing.includeVat ? round2(net / (1 + rate)) : net;
    const total = pricing.includeVat ? net : round2(net * (1 + rate));
    const vat = round2(total - base);
    return {
      cycle: input.cycle,
      lines,
      subtotal,
      couponCode,
      discount: round2(discount),
      couponError,
      base,
      vat,
      total,
      pricesIncludeVat: pricing.includeVat,
      taxRate: pricing.taxRate,
      monthlyEquivalent: round2(total / months),
      // Los extras no tienen precio anual: el ahorro es solo el del plan.
      yearlySaving: yearly ? Math.max(0, round2(monthlyPrice * 12 - planYearly)) : null,
      includedAddonIds,
    };
  }

  /**
   * Propuestas enviadas (las 200 últimas) y la conversión de los últimos 90
   * días. Con `leadId`, las de ese lead (y las de su tenant si ya lo tiene).
   */
  async listOffers(
    f: { tenantId?: string | null; leadId?: string | null } = {},
  ): Promise<PlatformQuoteOffersDto> {
    const since = new Date(Date.now() - 90 * DAY);
    const where: Prisma.PlatformQuoteOfferWhereInput = f.leadId
      ? { OR: [{ leadId: f.leadId }, ...(f.tenantId ? [{ tenantId: f.tenantId }] : [])] }
      : f.tenantId
        ? { tenantId: f.tenantId }
        : {};
    const [rows, recent] = await Promise.all([
      this.admin.platformQuoteOffer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: OFFER_INCLUDE,
      }),
      this.admin.platformQuoteOffer.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since }, ...where },
        _count: { _all: true },
      }),
    ]);
    const adminIds = [...new Set(rows.map((r) => r.superAdminId).filter((x): x is string => !!x))];
    const admins = adminIds.length
      ? await this.admin.superAdmin.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const names = new Map(admins.map((a) => [a.id, a.fullName]));
    const count = (st: string) => recent.find((g) => g.status === st)?._count._all ?? 0;
    const sent = count('sent') + count('accepted') + count('rejected');
    return {
      items: rows.map((r) => this.offerDto(r, names.get(r.superAdminId ?? '') ?? null)),
      stats: {
        sent,
        accepted: count('accepted'),
        rejected: count('rejected'),
        conversionPct: sent > 0 ? Math.round((count('accepted') / sent) * 1000) / 10 : null,
      },
    };
  }

  async setOfferStatus(
    id: string,
    status: QuoteOfferStatus,
    superAdminId: string,
  ): Promise<PlatformQuoteOfferDto> {
    const row = await this.admin.platformQuoteOffer.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'offer_not_found', message: 'Propuesta no encontrada' });
    }
    const updated = await this.admin.platformQuoteOffer.update({
      where: { id },
      data: { status, resolvedAt: status === 'sent' ? null : new Date() },
      include: OFFER_INCLUDE,
    });
    await this.audit.record({
      superAdminId,
      action: 'admin.tenant.quote_status_changed',
      targetType: row.tenantId ? 'tenant' : 'platform_lead',
      targetId: row.tenantId ?? row.leadId,
      targetTenantId: row.tenantId,
      changes: { offerId: id, status },
    });
    return this.offerDto(updated, null);
  }

  /** Enlace del correo: anota que la ha abierto y lleva a aceptarla. */
  trackedUrl(offerId: string): string {
    const key = offerKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    return `${this.config.get('API_BASE_URL', { infer: true })}/v1/public/offers/${offerId}/open?sig=${signOffer(key, offerId)}`;
  }

  /**
   * Abre una propuesta desde su correo: anota la primera vez y devuelve a dónde
   * llevarle. Con la firma mal o una propuesta que ya no existe, a la web.
   */
  async openOffer(offerId: string, sig: string | undefined): Promise<string> {
    const web = this.config.get('WEB_BASE_URL', { infer: true });
    const key = offerKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    if (!/^[0-9a-f-]{36}$/i.test(offerId) || !verifyOffer(key, offerId, sig)) return web;
    const row = await this.admin.platformQuoteOffer.findUnique({
      where: { id: offerId },
      include: OFFER_INCLUDE,
    });
    if (!row) return web;
    const now = new Date();
    // Cada apertura cuenta (veces y la última); la primera, además, la fecha.
    await this.admin.platformQuoteOffer.update({
      where: { id: offerId },
      data: { openCount: { increment: 1 }, lastOpenedAt: now },
    });
    await this.admin.platformQuoteOffer.updateMany({
      where: { id: offerId, openedAt: null },
      data: { openedAt: now },
    });
    // Aviso a quien lleva el lead (o a quien la envió), una vez por propuesta.
    const { count } = await this.admin.platformQuoteOffer.updateMany({
      where: { id: offerId, openNotifiedAt: null },
      data: { openNotifiedAt: now },
    });
    if (count > 0) await this.notifyOfferOpened(row);
    return row.tenantId || !row.lead ? this.acceptUrl(row) : this.registerUrl(row.lead);
  }

  private async notifyOfferOpened(row: {
    id: string;
    leadId: string | null;
    tenantId: string | null;
    superAdminId: string | null;
    tenant: { name: string } | null;
    lead: { email: string | null; companyName: string | null; contactName: string | null } | null;
  }): Promise<void> {
    const name = row.tenant?.name ?? (row.lead ? platformLeadName(row.lead) : 'Un cliente');
    const lead = row.leadId
      ? await this.admin.platformLead.findUnique({
          where: { id: row.leadId },
          select: { assignedToId: true },
        })
      : null;
    const recipientId = lead?.assignedToId ?? row.superAdminId;
    if (row.leadId) {
      await this.admin.platformLeadActivity
        .create({
          data: { leadId: row.leadId, type: 'system', content: 'Ha abierto la propuesta' },
        })
        .catch(() => undefined);
    }
    if (!recipientId) return;
    const recipient = await this.admin.superAdmin.findUnique({
      where: { id: recipientId },
      select: { role: true },
    });
    const link = row.leadId
      ? recipient?.role === 'sales'
        ? `/admin/sales/accounts/${row.leadId}`
        : `/admin/leads?lead=${row.leadId}`
      : row.tenantId
        ? `/admin/tenants/${row.tenantId}`
        : null;
    await this.admin.superAdminNotification
      .create({
        data: {
          type: 'sales.offer_opened',
          title:
            recipientId === row.superAdminId
              ? `${name} ha abierto tu propuesta`
              : `${name} ha abierto la propuesta`,
          body: 'Buen momento para llamarle.',
          link,
          recipientId,
        },
      })
      .catch(() => undefined);
  }

  private acceptUrl(r: {
    id: string;
    planId: string;
    cycle: string;
    couponCode: string | null;
  }): string {
    const params = new URLSearchParams({ offer: r.id, plan: r.planId, cycle: r.cycle });
    if (r.couponCode) params.set('coupon', r.couponCode);
    return `${this.config.get('WEB_BASE_URL', { infer: true })}/settings/saas-billing?${params.toString()}`;
  }

  /**
   * Registro con los datos del lead puestos (la propuesta le espera en
   * Suscripción). Si es de un comercial, lleva su código: la cuenta será suya.
   */
  private registerUrl(lead: {
    email: string | null;
    companyName: string | null;
    contactName: string | null;
    salesRep?: { salesCode: string | null; isActive: boolean } | null;
  }): string {
    const params = new URLSearchParams();
    if (lead.email) params.set('email', lead.email);
    if (lead.companyName) params.set('company', lead.companyName);
    if (lead.contactName) params.set('name', lead.contactName);
    if (lead.salesRep?.isActive && lead.salesRep.salesCode) {
      params.set(SALES_CODE_PARAM, lead.salesRep.salesCode);
    }
    const qs = params.toString();
    return `${this.config.get('WEB_BASE_URL', { infer: true })}/register${qs ? `?${qs}` : ''}`;
  }

  /**
   * Guarda la propuesta a un lead que aún no tiene cuenta (al vincularse a su
   * tenant pasa a ser suya). El correo lo manda el servicio de leads.
   */
  async createLeadOffer(
    lead: { id: string; email: string; companyName: string | null; contactName: string | null },
    input: SendAdminQuoteInput,
    superAdminId: string,
  ): Promise<{ quote: AdminQuoteDto; registerUrl: string; trackedUrl: string; offerId: string }> {
    const quote = await this.quote(input, null);
    if (quote.couponError) {
      throw new BadRequestException({ code: 'coupon_invalid', message: quote.couponError });
    }
    const offer = await this.admin.platformQuoteOffer.create({
      data: {
        leadId: lead.id,
        superAdminId,
        planId: input.planId,
        cycle: input.cycle,
        addons: input.addons as unknown as Prisma.InputJsonValue,
        couponCode: quote.couponCode,
        total: quote.total,
        expiresAt: new Date(Date.now() + QUOTE_OFFER_VALID_DAYS * DAY),
      },
    });
    const withRep = await this.admin.platformLead.findUnique({
      where: { id: lead.id },
      select: { salesRep: { select: { salesCode: true, isActive: true } } },
    });
    // El registro de acciones lo deja quien la envía, una vez enviado el correo.
    return {
      quote,
      registerUrl: this.registerUrl({ ...lead, salesRep: withRep?.salesRep ?? null }),
      trackedUrl: this.trackedUrl(offer.id),
      offerId: offer.id,
    };
  }

  private offerDto(
    r: {
      id: string;
      tenantId: string | null;
      leadId: string | null;
      planId: string;
      cycle: string;
      addons: Prisma.JsonValue;
      couponCode: string | null;
      total: Prisma.Decimal;
      status: string;
      resolvedAt: Date | null;
      createdAt: Date;
      openedAt: Date | null;
      openCount: number;
      lastOpenedAt: Date | null;
      expiresAt: Date | null;
      tenant: { name: string } | null;
      lead: {
        email: string | null;
        companyName: string | null;
        contactName: string | null;
        salesRep: { salesCode: string | null; isActive: boolean } | null;
      } | null;
      plan: { name: string };
    },
    superAdminName: string | null,
  ): PlatformQuoteOfferDto {
    return {
      id: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant?.name ?? null,
      leadId: r.leadId,
      leadName: r.lead ? platformLeadName(r.lead) : null,
      planId: r.planId,
      planName: r.plan.name,
      cycle: r.cycle === 'yearly' ? 'yearly' : 'monthly',
      addons: Array.isArray(r.addons) ? (r.addons as { addonId: string; quantity: number }[]) : [],
      couponCode: r.couponCode,
      total: Number(r.total),
      status: r.status as QuoteOfferStatus,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      openedAt: r.openedAt?.toISOString() ?? null,
      openCount: r.openCount,
      lastOpenedAt: r.lastOpenedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      expired: r.status === 'sent' && !!r.expiresAt && r.expiresAt.getTime() < Date.now(),
      superAdminName,
      acceptUrl: r.tenantId || !r.lead ? this.acceptUrl(r) : this.registerUrl(r.lead),
    };
  }

  /** Propuestas de un filtro (las de un comercial, por ejemplo). */
  async listOffersWhere(
    where: Prisma.PlatformQuoteOfferWhereInput,
    take = 200,
  ): Promise<PlatformQuoteOfferDto[]> {
    const rows = await this.admin.platformQuoteOffer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: OFFER_INCLUDE,
    });
    const adminIds = [...new Set(rows.map((r) => r.superAdminId).filter((x): x is string => !!x))];
    const admins = adminIds.length
      ? await this.admin.superAdmin.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const names = new Map(admins.map((a) => [a.id, a.fullName]));
    return rows.map((r) => this.offerDto(r, names.get(r.superAdminId ?? '') ?? null));
  }

  async send(
    tenantId: string,
    input: SendAdminQuoteInput,
    meta: { superAdminId: string; ipAddress?: string | null; userAgent?: string | null },
    sender?: QuoteOfferSender,
  ): Promise<{ recipients: number; quote: AdminQuoteDto; offerId: string }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const quote = await this.quote(input, tenantId);
    if (quote.couponError) {
      throw new BadRequestException({ code: 'coupon_invalid', message: quote.couponError });
    }
    const offer = await this.admin.platformQuoteOffer.create({
      data: {
        tenantId,
        superAdminId: meta.superAdminId,
        planId: input.planId,
        cycle: input.cycle,
        addons: input.addons as unknown as Prisma.InputJsonValue,
        couponCode: quote.couponCode,
        total: quote.total,
        expiresAt: new Date(Date.now() + QUOTE_OFFER_VALID_DAYS * DAY),
      },
    });
    let recipients: number;
    try {
      recipients = await this.lifecycle.sendQuoteOffer(tenantId, {
        tenantName: tenant.name,
        quote,
        message: input.message ?? null,
        acceptUrl: this.trackedUrl(offer.id),
        ...(sender ? { sender } : {}),
      });
    } catch (err) {
      // Si el correo no sale, la oferta no se queda a medias (nadie la ha recibido).
      await this.admin.platformQuoteOffer.deleteMany({ where: { id: offer.id } });
      throw err;
    }
    const summary = `${quote.lines.map((l) => l.label).join(' + ')} → ${quote.total.toFixed(2).replace('.', ',')} € ${
      quote.cycle === 'yearly' ? 'al año' : 'al mes'
    }`;
    await this.interactions.create({
      tenantId,
      superAdminId: meta.superAdminId,
      input: {
        type: 'email',
        content: `Propuesta de cuota: ${summary}.${input.message ? `\n\n${input.message}` : ''}`,
      },
    });
    if (input.followupDays > 0) {
      await this.followups.create({
        tenantId,
        superAdminId: meta.superAdminId,
        input: {
          title: 'Llamar por la propuesta de cuota',
          dueDate: new Date(Date.now() + input.followupDays * DAY).toLocaleDateString('sv-SE', {
            timeZone: 'Europe/Madrid',
          }),
        },
      });
    }
    await this.audit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.quote_sent',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { planId: input.planId, cycle: input.cycle, total: quote.total },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { recipients, quote, offerId: offer.id };
  }
}
