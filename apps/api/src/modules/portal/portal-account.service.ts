import { Injectable } from '@nestjs/common';
import {
  rentTax,
  type PortalAccountDto,
  type PortalAccountLineDto,
  type PortalDunningStepDto,
} from '@storageos/shared';

import { todayInTimezone } from '../../common/format';
import { isPendingPreOpening } from '../../common/pre-opening';
import { NO_PAYMENT_IN_FLIGHT } from '../../common/sepa-remittance-guard';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const STEP_TYPES = new Set<PortalDunningStepDto['type']>([
  'email_reminder',
  'email_reminder_final',
  'late_fee',
  'access_block',
  'legal_notice',
]);

/**
 * «Mi cuenta» del inquilino en el portal: lo que paga al mes con IVA, cómo se
 * le cobra, el próximo cargo y, si debe algo, cuánto y qué pasará si no paga.
 * Lo que ya se está cobrando (adeudo en curso o en remesa) va aparte: no es
 * algo que tenga que pagar.
 */
@Injectable()
export class PortalAccountService {
  constructor(private readonly admin: PrismaAdminService) {}

  async account(
    tenantId: string,
    customerId: string,
    canSetupAutomatic: boolean,
    now = new Date(),
  ): Promise<PortalAccountDto> {
    const open: Prisma.InvoiceWhereInput = {
      tenantId,
      customerId,
      deletedAt: null,
      status: { in: ['issued', 'overdue'] },
    };
    const [tenant, contracts, methods, mandate, settled, inFlight] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { autoChargeOnIssue: true },
      }),
      this.admin.contract.findMany({
        where: { tenantId, customerId, deletedAt: null, status: { in: ['active', 'ending'] } },
        select: {
          id: true,
          status: true,
          priceMonthly: true,
          discountAmount: true,
          insurancePrice: true,
          billingIntervalMonths: true,
          billingStartsOn: true,
          freeMonthsRemaining: true,
          prepayDiscountPct: true,
          preOpening: true,
          preOpeningStartedAt: true,
          insurancePlan: { select: { name: true, taxRate: true } },
          unit: {
            select: {
              code: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          invoices: {
            where: {
              deletedAt: null,
              kind: 'invoice',
              periodEnd: { not: null },
              status: { notIn: ['draft', 'cancelled', 'rectified'] },
            },
            select: { periodEnd: true },
            orderBy: { periodEnd: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.admin.paymentMethod.findMany({
        where: { tenantId, customerId, deletedAt: null, type: { in: ['card', 'sepa_debit'] } },
        select: { type: true, isDefault: true, last4: true, brand: true },
      }),
      this.admin.sepaMandate.findFirst({
        where: { tenantId, customerId, status: 'active' },
        select: { ibanLast4: true },
      }),
      // Facturas abiertas sin un cobro en marcha: lo que de verdad tiene que pagar.
      this.admin.invoice.findMany({
        where: { ...open, ...NO_PAYMENT_IN_FLIGHT },
        select: { id: true, status: true, dueDate: true, total: true, amountPaid: true },
        orderBy: { dueDate: 'asc' },
      }),
      this.admin.invoice.findMany({
        where: { ...open, NOT: NO_PAYMENT_IN_FLIGHT },
        select: { total: true, amountPaid: true },
      }),
    ]);

    const lines: PortalAccountLineDto[] = contracts.map((c) => {
      const vat = rentTax(c.unit.unitType?.propertyKind).taxRate;
      const rent = round2(
        Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)) * (1 + vat / 100),
      );
      const insurance = round2(
        Number(c.insurancePrice ?? 0) * (1 + Number(c.insurancePlan?.taxRate ?? 21) / 100),
      );
      return {
        contractId: c.id,
        unitCode: c.unit.code,
        facilityName: c.unit.facility.name,
        rent,
        insurance,
        insuranceName: c.insurancePlan?.name ?? null,
        total: round2(rent + insurance),
        billingIntervalMonths: c.billingIntervalMonths,
        ending: c.status === 'ending',
      };
    });

    // Próximo cargo: el primer día que no está ya pagado. Mensual → el día 1
    // del mes siguiente, salvo que ya pagara meses por adelantado (cupón,
    // primer pago con el mes siguiente) o que la facturación empiece más
    // tarde; prepagado → el día siguiente al fin del último periodo. Una
    // reserva antes de la apertura aún no tiene cargos.
    const today = todayInTimezone('Europe/Madrid', now);
    const firstOfNextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const charges = contracts
      .map((c, i) => ({ c, line: lines[i]! }))
      .filter(({ c }) => c.status === 'active' && !isPendingPreOpening(c))
      .map(({ c, line }) => {
        const coveredUntil = c.invoices[0]?.periodEnd ?? null;
        const nextUncovered = coveredUntil ? new Date(coveredUntil.getTime() + DAY) : null;
        // Meses gratis: el alquiler sale a 0 (la protección se sigue cobrando).
        const rent = c.freeMonthsRemaining > 0 ? 0 : line.rent;
        if (c.billingIntervalMonths > 1) {
          const pct = Number(c.prepayDiscountPct) / 100;
          const amount = (rent * (1 - pct) + line.insurance) * c.billingIntervalMonths;
          const date = nextUncovered ?? c.billingStartsOn ?? firstOfNextMonth;
          return { date, amount };
        }
        let date = firstOfNextMonth;
        for (const d of [nextUncovered, c.billingStartsOn]) {
          if (d && startOfMonth(d) > date) date = startOfMonth(d);
        }
        // Si la facturación empieza a mitad de ese mes, se cobra la parte.
        let share = 1;
        const from = [nextUncovered, c.billingStartsOn]
          .filter((d): d is Date => !!d && startOfMonth(d).getTime() === date.getTime())
          .sort((a, b) => b.getTime() - a.getTime())[0];
        if (from && from.getUTCDate() > 1) {
          const days = new Date(
            Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
          ).getUTCDate();
          share = (days - from.getUTCDate() + 1) / days;
        }
        return { date, amount: (rent + line.insurance) * share };
      })
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    let nextCharge: PortalAccountDto['nextCharge'] = null;
    if (charges.length) {
      const first = charges[0]!.date.getTime();
      nextCharge = {
        date: charges[0]!.date.toISOString().slice(0, 10),
        amount: round2(
          charges.filter((x) => x.date.getTime() === first).reduce((s, x) => s + x.amount, 0),
        ),
      };
    }

    const pend = (i: { total: unknown; amountPaid: unknown }) =>
      Math.max(0, Number(i.total) - Number(i.amountPaid));
    const overdueRows = settled.filter((i) => i.status === 'overdue');
    let overdue: PortalAccountDto['overdue'] = null;
    if (overdueRows.length) {
      const oldest = overdueRows[0]!;
      const actions = await this.admin.dunningAction.findMany({
        where: {
          tenantId,
          invoiceId: { in: overdueRows.map((i) => i.id) },
          supersededAt: null,
        },
        select: {
          invoiceId: true,
          actionType: true,
          scheduledFor: true,
          executedAt: true,
          status: true,
        },
        orderBy: { scheduledFor: 'asc' },
      });
      const since = oldest.dueDate ?? now;
      overdue = {
        amount: round2(overdueRows.reduce((s, i) => s + pend(i), 0)),
        since: since.toISOString().slice(0, 10),
        days: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY)),
        steps: actions
          .filter(
            (a) =>
              a.invoiceId === oldest.id &&
              STEP_TYPES.has(a.actionType as PortalDunningStepDto['type']) &&
              a.status !== 'cancelled',
          )
          .map((a) => ({
            type: a.actionType as PortalDunningStepDto['type'],
            date: (a.executedAt ?? a.scheduledFor).toISOString(),
            done: !!a.executedAt,
          })),
        accessBlocked: actions.some((a) => a.actionType === 'access_block' && !!a.executedAt),
      };
    }

    const pm = methods.find((m) => m.isDefault) ?? methods[0];
    const payVia: PortalAccountDto['payVia'] = pm
      ? (pm.type as 'card' | 'sepa_debit')
      : mandate
        ? 'sepa_mandate'
        : null;
    return {
      monthly: round2(lines.reduce((s, l) => s + l.total, 0)),
      lines,
      payVia,
      payBrand: pm?.type === 'card' ? (pm.brand ?? null) : null,
      payLast4: pm?.last4 ?? mandate?.ibanLast4 ?? null,
      automatic: (!!pm && !!tenant?.autoChargeOnIssue) || (!pm && !!mandate),
      canSetupAutomatic,
      nextCharge,
      inProgress: round2(inFlight.reduce((s, i) => s + pend(i), 0)),
      overdue,
      pendingNotDue: round2(
        settled.filter((i) => i.status === 'issued').reduce((s, i) => s + pend(i), 0),
      ),
    };
  }
}
