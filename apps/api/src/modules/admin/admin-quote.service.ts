import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';

import { PlatformCouponsService } from '../billing-saas/platform-coupons.service';
import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';

import type { AdminQuoteDto, AdminQuoteInput, SendAdminQuoteInput } from '@storageos/shared';

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
  ) {}

  async quote(input: AdminQuoteInput): Promise<AdminQuoteDto> {
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
    const lines: { label: string; amount: number }[] = [
      {
        label: `Plan ${plan.name}${yearly ? ' (anual)' : ''}`,
        amount: round2(Number(yearly ? plan.priceYearly : plan.priceMonthly)),
      },
    ];
    for (const a of input.addons) {
      const addon = addons.find((x) => x.id === a.addonId)!;
      const monthly = Number(addon.priceMonthly) * a.quantity;
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
        discount = (await this.coupons.validateAndComputeDiscount(input.couponCode, subtotal))
          .discount;
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
      yearlySaving: yearly
        ? Math.max(0, round2(Number(plan.priceMonthly) * 12 - Number(plan.priceYearly)))
        : null,
    };
  }

  async send(
    tenantId: string,
    input: SendAdminQuoteInput,
    meta: { superAdminId: string; ipAddress?: string | null; userAgent?: string | null },
  ): Promise<{ recipients: number; quote: AdminQuoteDto }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const quote = await this.quote(input);
    if (quote.couponError) {
      throw new BadRequestException({ code: 'coupon_invalid', message: quote.couponError });
    }
    const recipients = await this.lifecycle.sendQuoteOffer(tenantId, {
      tenantName: tenant.name,
      quote,
      message: input.message ?? null,
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
    return { recipients, quote };
  }
}
