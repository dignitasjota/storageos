import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  addonUnitPrice,
  parseAddonPriceTiers,
  resolvePlanFeatures,
  type TenantFeature,
} from '@storageos/shared';

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
const DAY = 86_400_000;

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
      ? await this.admin.subscriptionAddon.findMany({ where: { id: { in: ids } } })
      : [];
    if (addons.length !== ids.length) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Extra no encontrado' });
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

  /** Propuestas enviadas (las 200 últimas) y la conversión de los últimos 90 días. */
  async listOffers(tenantId?: string): Promise<PlatformQuoteOffersDto> {
    const since = new Date(Date.now() - 90 * DAY);
    const [rows, recent] = await Promise.all([
      this.admin.platformQuoteOffer.findMany({
        where: tenantId ? { tenantId } : {},
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { tenant: { select: { name: true } }, plan: { select: { name: true } } },
      }),
      this.admin.platformQuoteOffer.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since }, ...(tenantId ? { tenantId } : {}) },
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
      include: { tenant: { select: { name: true } }, plan: { select: { name: true } } },
    });
    await this.audit.record({
      superAdminId,
      action: 'admin.tenant.quote_status_changed',
      targetType: 'tenant',
      targetId: row.tenantId,
      targetTenantId: row.tenantId,
      changes: { offerId: id, status },
    });
    return this.offerDto(updated, null);
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

  private offerDto(
    r: {
      id: string;
      tenantId: string;
      planId: string;
      cycle: string;
      addons: Prisma.JsonValue;
      couponCode: string | null;
      total: Prisma.Decimal;
      status: string;
      resolvedAt: Date | null;
      createdAt: Date;
      tenant: { name: string };
      plan: { name: string };
    },
    superAdminName: string | null,
  ): PlatformQuoteOfferDto {
    return {
      id: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      planId: r.planId,
      planName: r.plan.name,
      cycle: r.cycle === 'yearly' ? 'yearly' : 'monthly',
      addons: Array.isArray(r.addons) ? (r.addons as { addonId: string; quantity: number }[]) : [],
      couponCode: r.couponCode,
      total: Number(r.total),
      status: r.status as QuoteOfferStatus,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      superAdminName,
      acceptUrl: this.acceptUrl(r),
    };
  }

  async send(
    tenantId: string,
    input: SendAdminQuoteInput,
    meta: { superAdminId: string; ipAddress?: string | null; userAgent?: string | null },
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
      },
    });
    const recipients = await this.lifecycle.sendQuoteOffer(tenantId, {
      tenantName: tenant.name,
      quote,
      message: input.message ?? null,
      acceptUrl: this.acceptUrl(offer),
    });
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
