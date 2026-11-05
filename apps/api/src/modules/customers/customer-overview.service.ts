import { Injectable, NotFoundException } from '@nestjs/common';

import { customerScopeWhere } from '../../common/customer-scope';
import {
  type FacilityScope,
  invoiceFacilityWhere,
  isFacilityAllowed,
} from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { nextContractCharge } from '../../common/next-charge';
import { isPendingPreOpening } from '../../common/pre-opening';
import { CHARGEABLE_MANDATE_WHERE } from '../../common/sepa-remittance-guard';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { CustomerAccountDto, CustomerOverviewDto, CustomerPayVia } from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const LIVE = ['active', 'ending'] as const;

const STEP_LABEL: Record<string, string> = {
  email_reminder: 'Primer recordatorio',
  email_reminder_final: 'Segundo recordatorio',
  sms_reminder: 'Recordatorio por SMS',
  late_fee: 'Recargo por mora',
  access_block: 'Corte de acceso',
  legal_notice: 'Aviso legal',
};

function scopedInvoices(scope: FacilityScope | undefined): Prisma.InvoiceWhereInput {
  return scope ? { AND: [invoiceFacilityWhere(scope) as Prisma.InvoiceWhereInput] } : {};
}

/** Vencido: marcado como tal o emitido con el vencimiento ya pasado. */
function overdueOf(today: Date): Prisma.InvoiceWhereInput {
  return {
    deletedAt: null,
    kind: 'invoice',
    OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: today } }],
  };
}

function notDueOf(today: Date): Prisma.InvoiceWhereInput {
  return {
    deletedAt: null,
    kind: 'invoice',
    status: 'issued',
    OR: [{ dueDate: null }, { dueDate: { gte: today } }],
  };
}

/** Cuota mensual de un contrato: alquiler − descuento + seguro (sin IVA). */
function contractMonthly(c: {
  priceMonthly: unknown;
  discountAmount: unknown;
  insurancePrice: unknown;
}): number {
  return round2(
    Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)) + Number(c.insurancePrice ?? 0),
  );
}

/**
 * Visión de los inquilinos del operador: una fila por inquilino con lo que
 * paga, cómo, si debe algo, qué extras tiene y cuándo se habló con él por
 * última vez; y el estado de cuenta de la ficha. Todo con RLS del tenant.
 */
@Injectable()
export class CustomerOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(
    tenantId: string,
    options: { facilityScope?: FacilityScope; moneyVisible?: boolean } = {},
  ): Promise<CustomerOverviewDto[]> {
    const scope = options.facilityScope;
    const money = options.moneyVisible ?? true;
    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const today = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
      // Como en Deudores: también lo emitido ya vencido que el cron aún no ha marcado.
      const overdueWhere = overdueOf(today);
      // Con alcance, la deuda de sus locales: la de los demás no le corresponde.
      const inScope = scopedInvoices(scope);
      const [
        customers,
        contracts,
        methods,
        mandates,
        overdue,
        notDue,
        comms,
        interactions,
        messages,
        paid12m,
        followups,
      ] = await Promise.all([
        tx.customer.findMany({
          where: { deletedAt: null, ...customerScopeWhere(scope) },
          select: {
            id: true,
            isTest: true,
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
            tags: true,
            kycVerified: true,
            portalAccessEnabled: true,
            portalLastSeenAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10_000,
        }),
        tx.contract.findMany({
          where: { deletedAt: null, status: { in: [...LIVE] } },
          select: {
            customerId: true,
            status: true,
            endDate: true,
            priceMonthly: true,
            discountAmount: true,
            insurancePrice: true,
            preOpening: true,
            preOpeningStartedAt: true,
            insurancePlan: { select: { name: true } },
            unit: {
              select: { code: true, facilityId: true, facility: { select: { name: true } } },
            },
          },
        }),
        tx.paymentMethod.findMany({
          where: { deletedAt: null, type: { in: ['card', 'sepa_debit'] } },
          select: { customerId: true, type: true, isDefault: true },
        }),
        tx.sepaMandate.findMany({
          where: CHARGEABLE_MANDATE_WHERE,
          select: { customerId: true },
        }),
        tx.invoice.groupBy({
          by: ['customerId'],
          where: { ...overdueWhere, ...inScope, customerId: { not: null } },
          _sum: { total: true, amountPaid: true },
          _min: { dueDate: true },
        }),
        tx.invoice.groupBy({
          by: ['customerId'],
          where: { ...notDueOf(today), ...inScope, customerId: { not: null } },
          _sum: { total: true, amountPaid: true },
        }),
        // Solo lo escrito por una persona: las facturas y avisos automáticos no
        // son un contacto.
        tx.communication.groupBy({
          by: ['customerId'],
          where: { customerId: { not: null }, sentAt: { not: null }, source: 'manual' },
          _max: { sentAt: true },
        }),
        tx.customerInteraction.groupBy({ by: ['customerId'], _max: { occurredAt: true } }),
        tx.customerMessage.groupBy({ by: ['customerId'], _max: { createdAt: true } }),
        tx.payment.groupBy({
          by: ['customerId'],
          where: {
            customerId: { not: null },
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: new Date(Date.now() - 365 * DAY) },
            methodType: { notIn: ['credit_note', 'withholding'] },
            ...(scope ? { invoice: inScope } : {}),
          },
          _sum: { amount: true, refundedAmount: true },
        }),
        tx.customerFollowup.findMany({
          where: { status: 'pending' },
          select: { customerId: true, title: true, dueDate: true },
          orderBy: { dueDate: 'asc' },
        }),
      ]);

      const byCustomer = <T extends { customerId: string | null }>(rows: T[]) => {
        const m = new Map<string, T[]>();
        for (const r of rows) {
          if (!r.customerId) continue;
          m.set(r.customerId, [...(m.get(r.customerId) ?? []), r]);
        }
        return m;
      };
      const contractsBy = byCustomer(contracts);
      const methodsBy = byCustomer(methods);
      const mandateSet = new Set(mandates.map((m) => m.customerId));
      const overdueBy = new Map(overdue.map((o) => [o.customerId!, o]));
      const notDueBy = new Map(notDue.map((o) => [o.customerId!, o]));
      const paidBy = new Map(paid12m.map((o) => [o.customerId!, o]));
      const lastBy = new Map<string, Date>();
      const bump = (id: string | null, d: Date | null | undefined) => {
        if (!id || !d) return;
        const prev = lastBy.get(id);
        if (!prev || d > prev) lastBy.set(id, d);
      };
      for (const c of comms) bump(c.customerId, c._max.sentAt);
      for (const i of interactions) bump(i.customerId, i._max.occurredAt);
      for (const m of messages) bump(m.customerId, m._max.createdAt);
      const followupBy = new Map<string, { title: string; dueDate: Date }>();
      for (const f of followups) if (!followupBy.has(f.customerId)) followupBy.set(f.customerId, f);

      return customers.map((c) => {
        // Con alcance, solo lo de sus locales.
        const live = (contractsBy.get(c.id) ?? []).filter(
          (l) => !scope || isFacilityAllowed(scope, l.unit.facilityId),
        );
        const ms = methodsBy.get(c.id) ?? [];
        const preferred = ms.find((m) => m.isDefault) ?? ms[0];
        const payVia: CustomerPayVia = preferred
          ? (preferred.type as 'card' | 'sepa_debit')
          : mandateSet.has(c.id)
            ? 'sepa_mandate'
            : null;
        const od = overdueBy.get(c.id);
        const nd = notDueBy.get(c.id);
        const ends = live.map((l) => l.endDate).filter((d): d is Date => !!d);
        const f = followupBy.get(c.id);
        const displayName =
          c.customerType === 'business'
            ? (c.companyName ?? '—')
            : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
        return {
          id: c.id,
          isTest: c.isTest,
          displayName,
          customerType: c.customerType as 'individual' | 'business',
          email: c.email,
          phone: c.phone,
          tags: c.tags,
          kycVerified: c.kycVerified,
          portalAccessEnabled: c.portalAccessEnabled,
          portalLastSeenAt: c.portalLastSeenAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
          units: live.map((l) => ({ code: l.unit.code, facilityName: l.unit.facility.name })),
          facilityIds: [...new Set(live.map((l) => l.unit.facilityId))],
          // Una reserva anticipada aún no paga cuota.
          monthly: money
            ? round2(
                live
                  .filter((l) => !isPendingPreOpening(l))
                  .reduce((s, l) => s + contractMonthly(l), 0),
              )
            : 0,
          contractStatus:
            live.length === 0
              ? 'none'
              : live.some((l) => l.status === 'active')
                ? 'active'
                : 'ending',
          endsOn: ends.length
            ? new Date(Math.min(...ends.map((d) => d.getTime()))).toISOString().slice(0, 10)
            : null,
          payVia,
          insurance: [
            ...new Set(live.map((l) => l.insurancePlan?.name).filter((n): n is string => !!n)),
          ],
          overdue:
            money && od
              ? round2(Math.max(0, Number(od._sum.total ?? 0) - Number(od._sum.amountPaid ?? 0)))
              : 0,
          overdueSince:
            money && od?._min.dueDate ? od._min.dueDate.toISOString().slice(0, 10) : null,
          pendingNotDue:
            money && nd
              ? round2(Math.max(0, Number(nd._sum.total ?? 0) - Number(nd._sum.amountPaid ?? 0)))
              : 0,
          paid12m: money
            ? round2(
                Number(paidBy.get(c.id)?._sum.amount ?? 0) -
                  Number(paidBy.get(c.id)?._sum.refundedAmount ?? 0),
              )
            : 0,
          moneyVisible: money,
          lastContactAt: lastBy.get(c.id)?.toISOString() ?? null,
          nextFollowup: f
            ? { title: f.title, dueDate: f.dueDate.toISOString().slice(0, 10) }
            : null,
        };
      });
    }, tenantId);
  }

  async account(
    tenantId: string,
    customerId: string,
    scope: FacilityScope = null,
    now = new Date(),
  ): Promise<CustomerAccountDto> {
    return this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      const tenantRow = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { autoChargeOnIssue: true, timezone: true },
      });
      const today = todayInTimezone(tenantRow?.timezone ?? 'Europe/Madrid', now);
      const inScope = scopedInvoices(scope);
      const [contracts, methods, mandate, overdue, notDue, paid, nightPasses] = await Promise.all([
        tx.contract.findMany({
          where: {
            customerId,
            deletedAt: null,
            status: { in: [...LIVE] },
            ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
          },
          select: {
            id: true,
            contractNumber: true,
            status: true,
            endDate: true,
            priceMonthly: true,
            discountAmount: true,
            insurancePrice: true,
            billingIntervalMonths: true,
            billingStartsOn: true,
            freeMonthsRemaining: true,
            prepayDiscountPct: true,
            preOpening: true,
            preOpeningStartedAt: true,
            depositAmount: true,
            depositStatus: true,
            insurancePlan: { select: { name: true } },
            unit: { select: { code: true, facility: { select: { name: true } } } },
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
        tx.paymentMethod.findMany({
          where: { customerId, deletedAt: null, type: { in: ['card', 'sepa_debit'] } },
          select: { type: true, isDefault: true, last4: true, brand: true },
        }),
        tx.sepaMandate.findFirst({
          where: { customerId, ...CHARGEABLE_MANDATE_WHERE },
          select: { ibanLast4: true },
        }),
        tx.invoice.findMany({
          where: { ...overdueOf(today), ...inScope, customerId },
          select: { id: true, invoiceNumber: true, dueDate: true, total: true, amountPaid: true },
          orderBy: { dueDate: 'asc' },
        }),
        tx.invoice.aggregate({
          where: { ...notDueOf(today), ...inScope, customerId },
          _sum: { total: true, amountPaid: true },
        }),
        tx.payment.aggregate({
          where: {
            customerId,
            ...(scope ? { invoice: scopedInvoices(scope) } : {}),
            status: { in: ['succeeded', 'partially_refunded'] },
            paidAt: { gte: new Date(now.getTime() - 365 * DAY) },
            methodType: { notIn: ['credit_note', 'withholding'] },
          },
          _sum: { amount: true, refundedAmount: true },
        }),
        tx.accessCredential.count({
          where: {
            customerId,
            createdAt: { gte: new Date(now.getTime() - 30 * DAY) },
            metadata: { path: ['source'], equals: 'night_pass' },
          },
        }),
      ]);

      const lines = contracts.map((c) => {
        const rent = Number(c.priceMonthly);
        const discount = Number(c.discountAmount);
        const insurance = Number(c.insurancePrice ?? 0);
        return {
          contractId: c.id,
          contractNumber: c.contractNumber,
          status: c.status,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          rent,
          discount,
          insurance,
          insuranceName: c.insurancePlan?.name ?? null,
          total: contractMonthly(c),
          billingIntervalMonths: c.billingIntervalMonths,
          endDate: c.endDate?.toISOString().slice(0, 10) ?? null,
          depositAmount: Number(c.depositAmount),
          depositStatus: c.depositStatus,
        };
      });
      const monthly = round2(lines.reduce((s, l) => s + l.total, 0));

      const pm = methods.find((m) => m.isDefault) ?? methods[0];
      const payVia: CustomerPayVia = pm
        ? (pm.type as 'card' | 'sepa_debit')
        : mandate
          ? 'sepa_mandate'
          : null;
      const payViaLabel = pm
        ? pm.type === 'card'
          ? `${pm.brand ? pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1) : 'Tarjeta'}${pm.last4 ? ` ··${pm.last4}` : ''}`
          : `Adeudo${pm.last4 ? ` ··${pm.last4}` : ''}`
        : mandate
          ? `Remesa SEPA ··${mandate.ibanLast4}`
          : null;

      // Próxima factura: el mismo cálculo que ve el inquilino en su área de clientes.
      let nextCharge: CustomerAccountDto['nextCharge'] = null;
      const charges = contracts
        .filter((c) => c.status === 'active' && !isPendingPreOpening(c))
        .map((c) =>
          nextContractCharge(
            { ...c, coveredUntil: c.invoices[0]?.periodEnd ?? null },
            {
              rent: Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)),
              insurance: Number(c.insurancePrice ?? 0),
            },
            today,
          ),
        )
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      if (charges.length) {
        const first = charges[0]!.date;
        const sameDay = charges.filter((c) => c.date.getTime() === first.getTime());
        nextCharge = {
          date: first.toISOString().slice(0, 10),
          amount: round2(sameDay.reduce((s, c) => s + c.amount, 0)),
        };
      }

      let overdueDto: CustomerAccountDto['overdue'] = null;
      if (overdue.length) {
        const oldest = overdue[0]!;
        const steps = await tx.dunningAction.findMany({
          where: { invoiceId: oldest.id, supersededAt: null },
          select: { actionType: true, scheduledFor: true, executedAt: true, status: true },
          orderBy: { scheduledFor: 'asc' },
        });
        const since = oldest.dueDate ?? now;
        overdueDto = {
          amount: round2(
            overdue.reduce((s, i) => s + Math.max(0, Number(i.total) - Number(i.amountPaid)), 0),
          ),
          since: since.toISOString().slice(0, 10),
          days: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY)),
          invoices: overdue.map((i) => ({
            id: i.id,
            number: i.invoiceNumber,
            dueDate: (i.dueDate ?? now).toISOString().slice(0, 10),
            pending: round2(Math.max(0, Number(i.total) - Number(i.amountPaid))),
          })),
          steps: steps.map((s) => ({
            type: s.actionType,
            label: STEP_LABEL[s.actionType] ?? s.actionType,
            scheduledFor: s.scheduledFor.toISOString(),
            executedAt: s.executedAt?.toISOString() ?? null,
            status: s.status,
          })),
        };
      }

      return {
        monthly,
        lines,
        payVia,
        payViaLabel,
        autoCharge: !!tenantRow?.autoChargeOnIssue && !!pm,
        nextCharge,
        overdue: overdueDto,
        pendingNotDue: round2(
          Math.max(0, Number(notDue._sum.total ?? 0) - Number(notDue._sum.amountPaid ?? 0)),
        ),
        paid12m: round2(Number(paid._sum.amount ?? 0) - Number(paid._sum.refundedAmount ?? 0)),
        nightPasses30d: nightPasses,
      };
    }, tenantId);
  }
}
