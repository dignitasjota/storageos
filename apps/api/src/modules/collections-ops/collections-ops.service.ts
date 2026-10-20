import { BadRequestException, Injectable } from '@nestjs/common';
import {
  type ArrearsDto,
  type ArrearsRowDto,
  type ExpectedVia,
  type MonthCollectionsDto,
  type MonthCollectionsItemDto,
  NON_CASH_PAYMENT_METHODS,
  type PaymentPlanStatus,
} from '@storageos/shared';

import { type FacilityScope, invoiceFacilityWhere } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const FISCAL_OPEN = ['issued', 'overdue'] as const;
const CASE_CLOSED = ['closed_paid', 'closed_cancelled', 'closed_disposed'];
const STEP_LABEL: Record<string, string> = {
  email_reminder: 'Primer recordatorio',
  email_reminder_final: 'Segundo recordatorio',
  sms_reminder: 'Recordatorio por SMS',
  late_fee: 'Recargo por mora',
  access_block: 'Corte de acceso',
  legal_notice: 'Aviso legal',
};

type NameRow = {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  customerType: string;
} | null;
const nameOf = (c: NameRow) =>
  !c
    ? 'Sin identificar'
    : c.customerType === 'business'
      ? (c.companyName ?? '—')
      : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
const NAME_SELECT = {
  firstName: true,
  lastName: true,
  companyName: true,
  customerType: true,
} as const;

function monthBounds(month: string): { first: string; next: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { first: `${month}-01`, next };
}

/**
 * Cobros del mes (lo previsto por vía de cobro frente a lo cobrado, fallido y
 * devuelto) e impagos (un inquilino por fila con su deuda, en qué paso del
 * escalado va, si tiene plan de pago o expediente).
 */
@Injectable()
export class CollectionsOpsService {
  constructor(private readonly prisma: PrismaService) {}

  async month(
    tenantId: string,
    month: string | undefined,
    scope: FacilityScope,
    facilityId?: string,
  ): Promise<MonthCollectionsDto> {
    const m = month ?? todayInTimezone().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes no válido (AAAA-MM).' });
    }
    const { first, next } = monthBounds(m);
    const facility = invoiceFacilityWhere(scope, facilityId);
    const empty = (): MonthCollectionsDto['expected']['total'] => ({ count: 0, amount: 0 });
    const weeks = [1, 8, 15, 22, 29]
      .map((d) => ({ from: `${m}-${String(d).padStart(2, '0')}`, d }))
      .filter((w) => w.from < next)
      .map((w, k, all) => {
        const to = all[k + 1]?.from ?? next;
        return {
          label: `${w.d}–${new Date(new Date(`${to}T00:00:00Z`).getTime() - DAY).getUTCDate()}`,
          from: w.from,
          to,
          expected: 0,
          collected: 0,
        };
      });
    if (facility === null) {
      return {
        month: m,
        expected: { auto: empty(), remittance: empty(), manual: empty(), total: empty() },
        outstanding: empty(),
        collected: { ...empty(), byMethod: {} },
        failed: { ...empty(), items: [] },
        returned: { ...empty(), items: [] },
        manualPending: [],
        weeks,
      };
    }
    const invWhere = facility as Prisma.InvoiceWhereInput;
    const from = zonedDayStart(first);
    const to = zonedDayStart(next);

    return this.prisma.withTenant(async (tx) => {
      const [tenant, invoices, collected, failed, returned] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { autoChargeOnIssue: true } }),
        tx.invoice.findMany({
          where: {
            ...invWhere,
            deletedAt: null,
            kind: 'invoice',
            status: { notIn: ['draft', 'cancelled', 'rectified'] },
            total: { gt: 0 },
            dueDate: { gte: new Date(first), lt: new Date(next) },
          },
          select: {
            id: true,
            invoiceNumber: true,
            customerId: true,
            status: true,
            total: true,
            amountPaid: true,
            withholdingAmount: true,
            dueDate: true,
            customer: { select: NAME_SELECT },
          },
        }),
        tx.payment.findMany({
          where: {
            invoice: invWhere,
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: from, lt: to },
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          select: { amount: true, methodType: true, paidAt: true },
        }),
        tx.payment.findMany({
          where: {
            invoice: invWhere,
            status: 'failed',
            returnedAt: null,
            createdAt: { gte: from, lt: to },
          },
          select: {
            amount: true,
            createdAt: true,
            failureReason: true,
            customerId: true,
            invoice: { select: { id: true, invoiceNumber: true } },
            customer: { select: NAME_SELECT },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
        tx.payment.findMany({
          where: { invoice: invWhere, returnedAt: { gte: from, lt: to } },
          select: {
            amount: true,
            returnedAt: true,
            failureReason: true,
            customerId: true,
            invoice: { select: { id: true, invoiceNumber: true } },
            customer: { select: NAME_SELECT },
          },
          orderBy: { returnedAt: 'desc' },
          take: 200,
        }),
      ]);

      const customerIds = [
        ...new Set(invoices.map((i) => i.customerId).filter((c): c is string => !!c)),
      ];
      const [methods, mandates] = await Promise.all([
        tx.paymentMethod.findMany({
          where: {
            customerId: { in: customerIds },
            deletedAt: null,
            type: { in: ['card', 'sepa_debit'] },
          },
          select: { customerId: true },
        }),
        tx.sepaMandate.findMany({
          where: { customerId: { in: customerIds }, status: 'active' },
          select: { customerId: true },
        }),
      ]);
      const chargeable = new Set(methods.map((p) => p.customerId));
      const mandate = new Set(mandates.map((p) => p.customerId));
      const viaOf = (customerId: string | null): ExpectedVia =>
        customerId && tenant?.autoChargeOnIssue && chargeable.has(customerId)
          ? 'auto'
          : customerId && mandate.has(customerId)
            ? 'remittance'
            : 'manual';

      const expected: MonthCollectionsDto['expected'] = {
        auto: empty(),
        remittance: empty(),
        manual: empty(),
        total: empty(),
      };
      const outstanding = empty();
      const manualPending: MonthCollectionsItemDto[] = [];
      for (const inv of invoices) {
        const amount = round2(Number(inv.total) - Number(inv.withholdingAmount));
        const via = viaOf(inv.customerId);
        expected[via].count++;
        expected[via].amount = round2(expected[via].amount + amount);
        expected.total.count++;
        expected.total.amount = round2(expected.total.amount + amount);
        const due = inv.dueDate!.toISOString().slice(0, 10);
        const week = weeks.find((w) => due >= w.from && due < w.to);
        if (week) week.expected = round2(week.expected + amount);
        if ((FISCAL_OPEN as readonly string[]).includes(inv.status)) {
          const pending = round2(Math.max(0, Number(inv.total) - Number(inv.amountPaid)));
          if (pending <= 0) continue;
          outstanding.count++;
          outstanding.amount = round2(outstanding.amount + pending);
          if (via === 'manual') {
            manualPending.push({
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              customerId: inv.customerId,
              customerName: nameOf(inv.customer),
              amount: pending,
              date: due,
              reason: null,
            });
          }
        }
      }

      const byMethod: Record<string, number> = {};
      let collectedAmount = 0;
      for (const p of collected) {
        const a = Number(p.amount);
        collectedAmount += a;
        byMethod[p.methodType] = round2((byMethod[p.methodType] ?? 0) + a);
        const day = todayInTimezone('Europe/Madrid', p.paidAt!).toISOString().slice(0, 10);
        const week = weeks.find((w) => day >= w.from && day < w.to);
        if (week) week.collected = round2(week.collected + a);
      }

      const item = (
        p: (typeof failed)[number] | (typeof returned)[number],
        date: Date,
      ): MonthCollectionsItemDto => ({
        invoiceId: p.invoice?.id ?? '',
        invoiceNumber: p.invoice?.invoiceNumber ?? '—',
        customerId: p.customerId,
        customerName: nameOf(p.customer),
        amount: Number(p.amount),
        date: date.toISOString(),
        reason: p.failureReason,
      });

      return {
        month: m,
        expected,
        outstanding,
        collected: { count: collected.length, amount: round2(collectedAmount), byMethod },
        failed: {
          count: failed.length,
          amount: round2(failed.reduce((s, p) => s + Number(p.amount), 0)),
          items: failed.map((p) => item(p, p.createdAt)),
        },
        returned: {
          count: returned.length,
          amount: round2(returned.reduce((s, p) => s + Number(p.amount), 0)),
          items: returned.map((p) => item(p, p.returnedAt!)),
        },
        manualPending: manualPending.sort((a, b) => a.date.localeCompare(b.date)),
        weeks,
      };
    }, tenantId);
  }

  async arrears(tenantId: string, scope: FacilityScope, facilityId?: string): Promise<ArrearsDto> {
    const facility = invoiceFacilityWhere(scope, facilityId);
    const emptyAging = [
      { label: '0-30 días', amount: 0, count: 0 },
      { label: '31-60 días', amount: 0, count: 0 },
      { label: '61-90 días', amount: 0, count: 0 },
      { label: 'Más de 90 días', amount: 0, count: 0 },
    ];
    if (facility === null) return { totalAmount: 0, customers: 0, aging: emptyAging, rows: [] };
    const now = new Date();

    return this.prisma.withTenant(async (tx) => {
      const overdue = await tx.invoice.findMany({
        where: {
          ...(facility as Prisma.InvoiceWhereInput),
          deletedAt: null,
          kind: 'invoice',
          status: 'overdue',
          customerId: { not: null },
        },
        select: {
          id: true,
          customerId: true,
          total: true,
          amountPaid: true,
          dueDate: true,
          lateFeeInvoice: { select: { id: true } },
        },
      });
      const byCustomer = new Map<string, typeof overdue>();
      for (const inv of overdue) {
        if (Number(inv.total) - Number(inv.amountPaid) <= 0) continue;
        byCustomer.set(inv.customerId!, [...(byCustomer.get(inv.customerId!) ?? []), inv]);
      }
      const customerIds = [...byCustomer.keys()];
      const invoiceIds = [...byCustomer.values()].flat().map((i) => i.id);
      const [customers, actions, methods, mandates, plans, cases, contracts] = await Promise.all([
        tx.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, email: true, phone: true, ...NAME_SELECT },
        }),
        tx.dunningAction.findMany({
          where: { invoiceId: { in: invoiceIds }, supersededAt: null },
          select: {
            invoiceId: true,
            actionType: true,
            status: true,
            scheduledFor: true,
            executedAt: true,
          },
        }),
        tx.paymentMethod.findMany({
          where: {
            customerId: { in: customerIds },
            deletedAt: null,
            type: { in: ['card', 'sepa_debit'] },
          },
          select: { customerId: true },
        }),
        tx.sepaMandate.findMany({
          where: { customerId: { in: customerIds }, status: 'active' },
          select: { customerId: true },
        }),
        tx.paymentPlan.findMany({
          where: { customerId: { in: customerIds }, status: { in: ['active', 'broken'] } },
          select: { id: true, customerId: true, status: true, installments: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        tx.delinquencyCase.findMany({
          where: { customerId: { in: customerIds }, status: { notIn: CASE_CLOSED as never } },
          select: { id: true, customerId: true, status: true },
        }),
        tx.contract.findMany({
          where: {
            customerId: { in: customerIds },
            deletedAt: null,
            status: { in: ['active', 'ending'] },
          },
          select: { id: true, customerId: true, unit: { select: { code: true } } },
        }),
      ]);
      const invToCustomer = new Map(overdue.map((i) => [i.id, i.customerId!]));
      const actionsBy = new Map<string, typeof actions>();
      for (const a of actions) {
        const c = invToCustomer.get(a.invoiceId);
        if (c) actionsBy.set(c, [...(actionsBy.get(c) ?? []), a]);
      }
      const chargeable = new Set(methods.map((m) => m.customerId));
      const mandate = new Set(mandates.map((m) => m.customerId));
      const today = todayInTimezone().toISOString().slice(0, 10);
      const aging = emptyAging.map((a) => ({ ...a }));

      const rows: ArrearsRowDto[] = customers.map((c) => {
        const invs = byCustomer.get(c.id) ?? [];
        const amount = round2(invs.reduce((s, i) => s + Number(i.total) - Number(i.amountPaid), 0));
        const since = invs.map((i) => i.dueDate ?? now).reduce((a, b) => (a < b ? a : b), now);
        const days = Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY));
        const bucket = aging[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3]!;
        bucket.amount = round2(bucket.amount + amount);
        bucket.count++;
        const acts = actionsBy.get(c.id) ?? [];
        const executed = acts.filter((a) => a.executedAt && a.status !== 'cancelled');
        const reminders = executed
          .filter(
            (a) => a.actionType.startsWith('email_reminder') || a.actionType === 'sms_reminder',
          )
          .map((a) => a.executedAt!.getTime());
        const next = acts
          .filter((a) => a.status === 'scheduled')
          .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0];
        const plan = plans.find((p) => p.customerId === c.id);
        const nextDue = plan
          ? ((plan.installments as { dueDate: string }[]).find((i) => i.dueDate >= today)
              ?.dueDate ?? null)
          : null;
        const caseRow = cases.find((k) => k.customerId === c.id);
        const myContracts = contracts.filter((k) => k.customerId === c.id);
        return {
          customerId: c.id,
          customerName: nameOf(c),
          email: c.email,
          phone: c.phone,
          amount,
          since: since.toISOString().slice(0, 10),
          days,
          invoiceIds: invs.map((i) => i.id),
          invoiceCount: invs.length,
          chargeable: chargeable.has(c.id),
          sepaMandate: mandate.has(c.id),
          lastReminderAt: reminders.length ? new Date(Math.max(...reminders)).toISOString() : null,
          lateFeeApplied: invs.some((i) => !!i.lateFeeInvoice),
          accessBlocked: executed.some((a) => a.actionType === 'access_block'),
          nextStep: next
            ? {
                label: STEP_LABEL[next.actionType] ?? next.actionType,
                date: next.scheduledFor.toISOString(),
              }
            : null,
          plan: plan ? { id: plan.id, status: plan.status as PaymentPlanStatus, nextDue } : null,
          collectionsCase: caseRow ? { id: caseRow.id, status: caseRow.status } : null,
          contractId: myContracts[0]?.id ?? null,
          units: myContracts.map((k) => k.unit.code),
        };
      });
      rows.sort((a, b) => b.amount - a.amount);
      return {
        totalAmount: round2(rows.reduce((s, r) => s + r.amount, 0)),
        customers: rows.length,
        aging,
        rows,
      };
    }, tenantId);
  }
}
