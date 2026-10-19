import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { CustomerExtrasDto, CustomerExtrasRowDto } from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Matriz inquilino × extras de los inquilinos con contrato activo. */
@Injectable()
export class CustomerExtrasService {
  constructor(private readonly prisma: PrismaService) {}

  async matrix(
    tenantId: string,
    scope: string[] | null,
    now = new Date(),
  ): Promise<CustomerExtrasDto> {
    const rows = await this.prisma.withTenant(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: {
          deletedAt: null,
          status: { in: ['active', 'ending'] },
          ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
        },
        select: {
          customerId: true,
          insurancePlanId: true,
          priceMonthly: true,
          discountAmount: true,
          insurancePrice: true,
          unit: { select: { code: true } },
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
              portalPasswordHash: true,
            },
          },
        },
      });
      const ids = [...new Set(contracts.map((c) => c.customerId))];
      if (ids.length === 0) return [];
      const [methods, mandates, credentials, sales] = await Promise.all([
        tx.paymentMethod.findMany({
          where: { customerId: { in: ids }, deletedAt: null, type: { in: ['card', 'sepa_debit'] } },
          select: { customerId: true },
        }),
        tx.sepaMandate.findMany({
          where: { customerId: { in: ids }, status: 'active' },
          select: { customerId: true },
        }),
        tx.accessCredential.findMany({
          where: { customerId: { in: ids }, status: { in: ['active', 'suspended', 'expired'] } },
          select: { customerId: true, status: true, metadata: true, createdAt: true },
        }),
        tx.productSale.groupBy({
          by: ['customerId'],
          where: {
            customerId: { in: ids },
            status: { not: 'cancelled' },
            soldAt: { gte: new Date(now.getTime() - 365 * DAY) },
          },
          _sum: { total: true },
        }),
      ]);
      const autopay = new Set([...methods, ...mandates].map((m) => m.customerId));
      const extra = new Map<string, number>();
      const night = new Map<string, number>();
      for (const c of credentials) {
        const source = (c.metadata as { source?: string } | null)?.source;
        if (source === 'portal_self_service' && c.status !== 'expired') {
          extra.set(c.customerId, (extra.get(c.customerId) ?? 0) + 1);
        }
        if (source === 'night_pass' && c.createdAt.getTime() >= now.getTime() - 90 * DAY) {
          night.set(c.customerId, (night.get(c.customerId) ?? 0) + 1);
        }
      }
      const shop = new Map(sales.map((s) => [s.customerId!, Number(s._sum.total ?? 0)]));

      const by = new Map<string, CustomerExtrasRowDto>();
      for (const c of contracts) {
        const cu = c.customer;
        const row =
          by.get(c.customerId) ??
          ({
            customerId: c.customerId,
            customerName:
              cu.customerType === 'business'
                ? (cu.companyName ?? '—')
                : [cu.firstName, cu.lastName].filter(Boolean).join(' ') || '—',
            units: [],
            monthly: 0,
            insuredContracts: 0,
            contracts: 0,
            autopay: autopay.has(c.customerId),
            extraAccesses: extra.get(c.customerId) ?? 0,
            nightPasses90d: night.get(c.customerId) ?? 0,
            shop12m: round2(shop.get(c.customerId) ?? 0),
            portalPassword: !!cu.portalPasswordHash,
          } satisfies CustomerExtrasRowDto);
        row.units.push(c.unit.code);
        row.contracts += 1;
        if (c.insurancePlanId) row.insuredContracts += 1;
        row.monthly = round2(
          row.monthly +
            Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)) +
            Number(c.insurancePrice ?? 0),
        );
        by.set(c.customerId, row);
      }
      return [...by.values()].sort((a, b) => a.customerName.localeCompare(b.customerName, 'es'));
    }, tenantId);

    return {
      rows,
      totals: {
        customers: rows.length,
        insured: rows.filter((r) => r.insuredContracts > 0).length,
        autopay: rows.filter((r) => r.autopay).length,
        extraAccesses: rows.filter((r) => r.extraAccesses > 0).length,
        nightPasses: rows.filter((r) => r.nightPasses90d > 0).length,
        shop: rows.filter((r) => r.shop12m > 0).length,
        portalPassword: rows.filter((r) => r.portalPassword).length,
      },
    };
  }
}
