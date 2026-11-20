import { Injectable } from '@nestjs/common';

import { CHARGEABLE_MANDATE_WHERE } from '../../common/sepa-remittance-guard';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { SavedPaymentMethodsGroupDto, SavedPaymentMethodsSummaryDto } from '@storageos/shared';

/** Contratos vivos: se facturan cada mes. */
const LIVE_CONTRACT = {
  status: { in: ['active', 'ending'] },
  deletedAt: null,
} satisfies Prisma.ContractWhereInput;

type Gateway = 'stripe' | 'redsys' | 'gocardless';

/**
 * Qué formas de pago guardadas tienen los inquilinos con cada pasarela: lo que
 * deja de funcionar si el negocio la apaga (la pantalla lo avisa antes).
 */
@Injectable()
export class SavedMethodsSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string): Promise<SavedPaymentMethodsSummaryDto> {
    return this.prisma.withTenant(async (tx) => {
      const [methods, mandates, tenant, account] = await Promise.all([
        tx.paymentMethod.findMany({
          where: {
            deletedAt: null,
            gateway: { in: ['stripe', 'redsys', 'gocardless'] },
            customer: { deletedAt: null },
          },
          select: { customerId: true, gateway: true, isDefault: true, stripeAccountId: true },
        }),
        tx.sepaMandate.findMany({
          where: { ...CHARGEABLE_MANDATE_WHERE, customer: { deletedAt: null } },
          select: { customerId: true },
        }),
        tx.tenant.findUnique({ where: { id: tenantId }, select: { autoChargeOnIssue: true } }),
        tx.tenantStripeAccount.findUnique({
          where: { tenantId },
          select: { stripeAccountId: true },
        }),
      ]);

      // Inquilinos con contratos vivos (y cuántos tienen).
      const contracts = await tx.contract.groupBy({
        by: ['customerId'],
        where: LIVE_CONTRACT,
        _count: { _all: true },
      });
      const liveByCustomer = new Map(contracts.map((c) => [c.customerId, c._count._all]));

      const group = (
        rows: { customerId: string; isDefault?: boolean }[],
        defaultOnly: boolean,
      ): SavedPaymentMethodsGroupDto => {
        const customers = new Set(rows.map((r) => r.customerId));
        const charged = new Set(
          rows.filter((r) => !defaultOnly || r.isDefault).map((r) => r.customerId),
        );
        let autoChargedContracts = 0;
        for (const id of charged) autoChargedContracts += liveByCustomer.get(id) ?? 0;
        return { customers: customers.size, methods: rows.length, autoChargedContracts };
      };
      const of = (g: Gateway) => methods.filter((m) => m.gateway === g);

      const stripe = of('stripe');
      const accounts = new Map<string | null, typeof stripe>();
      for (const m of stripe) {
        const list = accounts.get(m.stripeAccountId) ?? [];
        list.push(m);
        accounts.set(m.stripeAccountId, list);
      }
      const current = account ? (accounts.get(account.stripeAccountId) ?? []) : null;

      return {
        stripe: {
          ...group(stripe, true),
          byAccount: [...accounts.entries()].map(([stripeAccountId, rows]) => ({
            stripeAccountId,
            customers: new Set(rows.map((r) => r.customerId)).size,
            methods: rows.length,
          })),
          currentAccount: current ? group(current, true) : null,
        },
        redsys: group(of('redsys'), true),
        gocardless: group(of('gocardless'), true),
        // Las remesas cogen a todo el que tiene un mandato firmado.
        sepa: group(mandates, false),
        autoChargeOnIssue: tenant?.autoChargeOnIssue ?? false,
      };
    }, tenantId);
  }
}
