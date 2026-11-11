import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  allocateInstallments,
  allocateOldestFirst,
  type ArrearsDto,
  type ArrearsRowDto,
  type DebtorPaymentInput,
  type DebtorPaymentResultDto,
  type ExpectedVia,
  type MonthCollectionsDto,
  type MonthCollectionsItemDto,
  NON_CASH_PAYMENT_METHODS,
  type PaymentPlanStatus,
} from '@storageos/shared';

import { accessCutApplied } from '../../common/access-cut';
import { type FacilityScope, invoiceFacilityWhere } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart } from '../../common/format';
import { toCents } from '../../common/money';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { CHARGEABLE_MANDATE_WHERE } from '../../common/sepa-remittance-guard';
import { InvoicesService } from '../billing/invoices.service';
import { REMINDER_SOURCES, SUMMARY_REMINDER_SOURCES } from '../billing/reminder-summary';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';

const DAY = 86_400_000;
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
/** Tramos de antigüedad, como Analítica (`business-metrics`). */
const AGING_LABELS = ['0-30 días', '30-60 días', '60-90 días', 'Más de 90 días'];
const agingIndex = (days: number) => (days < 30 ? 0 : days < 60 ? 1 : days < 90 ? 2 : 3);

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

/** El mes anterior a `AAAA-MM`. */
function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/** Lo que falta por cobrar de una factura (céntimos): 0 si ya no está abierta. */
function pendingOf(inv: {
  status: string;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
}): number {
  if (!(FISCAL_OPEN as readonly string[]).includes(inv.status)) return 0;
  return Math.max(0, toCents(inv.total) - toCents(inv.amountPaid));
}

/** Parte cobrada de lo vencido (0-1), o null si aún no venció nada. */
function rateOf(dueCents: number, duePendingCents: number): number | null {
  if (dueCents <= 0) return null;
  return Math.round(((dueCents - duePendingCents) / dueCents) * 10_000) / 10_000;
}

function monthBounds(month: string): { first: string; next: string; days: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, next, days };
}

/**
 * Cobros del mes (lo previsto por vía de cobro frente a lo cobrado, fallido y
 * devuelto) e impagos (un inquilino por fila con su deuda, en qué paso del
 * escalado va, si tiene plan de pago o expediente). Los días son los del
 * negocio (su zona horaria).
 */
@Injectable()
export class CollectionsOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly invoices: InvoicesService,
  ) {}

  async month(
    tenantId: string,
    month: string | undefined,
    scope: FacilityScope,
    facilityId?: string,
  ): Promise<MonthCollectionsDto> {
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { autoChargeOnIssue: true, timezone: true },
        }),
      tenantId,
    );
    const tz = tenant?.timezone ?? 'Europe/Madrid';
    const m = month ?? todayInTimezone(tz).toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes no válido (AAAA-MM).' });
    }
    const { first, next, days } = monthBounds(m);
    const prev = previousMonth(m);
    const prevBounds = monthBounds(prev);
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    const facility = invoiceFacilityWhere(scope, facilityId);
    const empty = (): MonthCollectionsDto['expected']['total'] => ({ count: 0, amount: 0 });
    // Semanas del 1, 8, 15, 22 y 29 (si el mes llega al 29).
    const weeks = [1, 8, 15, 22, 29]
      .filter((d) => d <= days)
      .map((d, k, all) => {
        const end = (all[k + 1] ?? days + 1) - 1;
        return {
          label: `${d}–${end}`,
          from: `${m}-${String(d).padStart(2, '0')}`,
          to: k + 1 < all.length ? `${m}-${String(all[k + 1]).padStart(2, '0')}` : next,
          expected: 0,
          collected: 0,
        };
      });
    if (facility === null) {
      return {
        month: m,
        expected: { auto: empty(), remittance: empty(), manual: empty(), total: empty() },
        outstanding: empty(),
        outstandingByVia: { auto: empty(), remittance: empty(), manual: empty() },
        collectionRate: null,
        previous: {
          month: prev,
          expected: empty(),
          outstanding: empty(),
          collected: empty(),
          collectionRate: null,
        },
        collected: { ...empty(), byMethod: {} },
        failed: { ...empty(), items: [] },
        returned: { ...empty(), items: [] },
        manualPending: [],
        weeks,
      };
    }
    const invWhere = facility as Prisma.InvoiceWhereInput;
    // Fianzas fuera: no son cobros de facturas (como el Resumen).
    const invoiceOnly: Prisma.InvoiceWhereInput = { kind: 'invoice', ...invWhere };
    const from = zonedDayStart(first, tz);
    const to = zonedDayStart(next, tz);
    // Intentos de cobro rechazados por la pasarela (un cobro a mano deshecho
    // también queda «fallido», pero no es un intento de cobro).
    const failedWhere: Prisma.PaymentWhereInput = {
      invoice: invoiceOnly,
      status: 'failed',
      returnedAt: null,
      gateway: { not: 'manual' },
      createdAt: { gte: from, lt: to },
    };
    const returnedWhere: Prisma.PaymentWhereInput = {
      invoice: invoiceOnly,
      returnedAt: { gte: from, lt: to },
    };
    const itemSelect = {
      amount: true,
      createdAt: true,
      returnedAt: true,
      failureReason: true,
      customerId: true,
      invoice: { select: { id: true, invoiceNumber: true, status: true } },
      customer: { select: NAME_SELECT },
    } as const;

    // Lo que vence en un mes y lo que se cobró en él (para comparar con el anterior).
    const dueIn = (a: string, b: string): Prisma.InvoiceWhereInput => ({
      ...invWhere,
      deletedAt: null,
      kind: 'invoice',
      status: { notIn: ['draft', 'cancelled', 'rectified'] },
      total: { gt: 0 },
      dueDate: { gte: new Date(a), lt: new Date(b) },
    });
    const paidIn = (a: Date, b: Date): Prisma.PaymentWhereInput => ({
      invoice: invoiceOnly,
      status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
      paidAt: { gte: a, lt: b },
      methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
    });

    return this.prisma.withTenant(async (tx) => {
      const [
        invoices,
        collected,
        failed,
        failedSum,
        returned,
        returnedSum,
        prevInvoices,
        prevCollected,
      ] = await Promise.all([
        tx.invoice.findMany({
          where: dueIn(first, next),
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
          where: paidIn(from, to),
          select: { amount: true, refundedAmount: true, methodType: true, paidAt: true },
        }),
        tx.payment.findMany({
          where: failedWhere,
          select: itemSelect,
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
        tx.payment.aggregate({
          where: failedWhere,
          _sum: { amount: true },
          _count: { _all: true },
        }),
        tx.payment.findMany({
          where: returnedWhere,
          select: itemSelect,
          orderBy: { returnedAt: 'desc' },
          take: 200,
        }),
        tx.payment.aggregate({
          where: returnedWhere,
          _sum: { amount: true },
          _count: { _all: true },
        }),
        tx.invoice.findMany({
          where: dueIn(prevBounds.first, prevBounds.next),
          select: {
            status: true,
            total: true,
            amountPaid: true,
            withholdingAmount: true,
            dueDate: true,
          },
        }),
        tx.payment.findMany({
          where: paidIn(zonedDayStart(prevBounds.first, tz), from),
          select: { amount: true, refundedAmount: true },
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
          where: { customerId: { in: customerIds }, ...CHARGEABLE_MANDATE_WHERE },
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

      // Todo en céntimos; a euros al final.
      const cents: Record<ExpectedVia | 'total' | 'outstanding', { count: number; c: number }> = {
        auto: { count: 0, c: 0 },
        remittance: { count: 0, c: 0 },
        manual: { count: 0, c: 0 },
        total: { count: 0, c: 0 },
        outstanding: { count: 0, c: 0 },
      };
      const outVia: Record<ExpectedVia, { count: number; c: number }> = {
        auto: { count: 0, c: 0 },
        remittance: { count: 0, c: 0 },
        manual: { count: 0, c: 0 },
      };
      // Lo ya vencido (antes de hoy) y lo que de eso falta: la tasa de cobro.
      let dueCents = 0;
      let duePendingCents = 0;
      const weekCents = weeks.map(() => ({ expected: 0, collected: 0 }));
      const weekOf = (day: string) => weeks.findIndex((w) => day >= w.from && day < w.to);
      const manualPending: MonthCollectionsItemDto[] = [];
      for (const inv of invoices) {
        const amount = toCents(inv.total) - toCents(inv.withholdingAmount);
        const via = viaOf(inv.customerId);
        cents[via].count++;
        cents[via].c += amount;
        cents.total.count++;
        cents.total.c += amount;
        const due = inv.dueDate!.toISOString().slice(0, 10);
        const w = weekOf(due);
        if (w >= 0) weekCents[w]!.expected += amount;
        const pendingNow = pendingOf(inv);
        if (due < today) {
          dueCents += amount;
          duePendingCents += pendingNow;
        }
        if ((FISCAL_OPEN as readonly string[]).includes(inv.status)) {
          const pending = pendingNow;
          if (pending <= 0) continue;
          cents.outstanding.count++;
          cents.outstanding.c += pending;
          outVia[via].count++;
          outVia[via].c += pending;
          if (via === 'manual') {
            manualPending.push({
              invoiceId: inv.id,
              invoiceNumber: inv.invoiceNumber,
              customerId: inv.customerId,
              customerName: nameOf(inv.customer),
              amount: pending / 100,
              date: due,
              reason: null,
              invoiceStatus: inv.status,
            });
          }
        }
      }

      const byMethodCents: Record<string, number> = {};
      let collectedCents = 0;
      for (const p of collected) {
        // Neto de lo devuelto: la misma cifra que «Cobrado» en el Resumen.
        const net = toCents(p.amount) - toCents(p.refundedAmount);
        collectedCents += net;
        byMethodCents[p.methodType] = (byMethodCents[p.methodType] ?? 0) + net;
        const day = todayInTimezone(tz, p.paidAt!).toISOString().slice(0, 10);
        const w = weekOf(day);
        if (w >= 0) weekCents[w]!.collected += net;
      }

      const item = (p: (typeof failed)[number], date: Date): MonthCollectionsItemDto => ({
        invoiceId: p.invoice?.id ?? '',
        invoiceNumber: p.invoice?.invoiceNumber ?? '—',
        customerId: p.customerId,
        customerName: nameOf(p.customer),
        amount: Number(p.amount),
        date: date.toISOString(),
        reason: p.failureReason,
        invoiceStatus: p.invoice?.status ?? null,
      });
      const bucket = (b: { count: number; c: number }) => ({ count: b.count, amount: b.c / 100 });

      // El mes anterior, con las mismas reglas.
      const prevExpected = { count: 0, c: 0 };
      const prevOutstanding = { count: 0, c: 0 };
      let prevDue = 0;
      let prevDuePending = 0;
      for (const inv of prevInvoices) {
        const amount = toCents(inv.total) - toCents(inv.withholdingAmount);
        const pending = pendingOf(inv);
        prevExpected.count++;
        prevExpected.c += amount;
        if (pending > 0) {
          prevOutstanding.count++;
          prevOutstanding.c += pending;
        }
        if (inv.dueDate!.toISOString().slice(0, 10) < today) {
          prevDue += amount;
          prevDuePending += pending;
        }
      }
      const prevCollectedCents = prevCollected.reduce(
        (sum, p) => sum + toCents(p.amount) - toCents(p.refundedAmount),
        0,
      );

      return {
        month: m,
        expected: {
          auto: bucket(cents.auto),
          remittance: bucket(cents.remittance),
          manual: bucket(cents.manual),
          total: bucket(cents.total),
        },
        outstanding: bucket(cents.outstanding),
        outstandingByVia: {
          auto: bucket(outVia.auto),
          remittance: bucket(outVia.remittance),
          manual: bucket(outVia.manual),
        },
        collectionRate: rateOf(dueCents, duePendingCents),
        previous: {
          month: prev,
          expected: bucket(prevExpected),
          outstanding: bucket(prevOutstanding),
          collected: { count: prevCollected.length, amount: prevCollectedCents / 100 },
          collectionRate: rateOf(prevDue, prevDuePending),
        },
        collected: {
          count: collected.length,
          amount: collectedCents / 100,
          byMethod: Object.fromEntries(Object.entries(byMethodCents).map(([k, v]) => [k, v / 100])),
        },
        failed: {
          count: failedSum._count._all,
          amount: toCents(failedSum._sum.amount ?? 0) / 100,
          items: failed.map((p) => item(p, p.createdAt)),
        },
        returned: {
          count: returnedSum._count._all,
          amount: toCents(returnedSum._sum.amount ?? 0) / 100,
          items: returned.map((p) => item(p, p.returnedAt!)),
        },
        manualPending: manualPending.sort((a, b) => a.date.localeCompare(b.date)),
        weeks: weeks.map((w, k) => ({
          ...w,
          expected: weekCents[k]!.expected / 100,
          collected: weekCents[k]!.collected / 100,
        })),
      };
    }, tenantId);
  }

  async arrears(tenantId: string, scope: FacilityScope, facilityId?: string): Promise<ArrearsDto> {
    const facility = invoiceFacilityWhere(scope, facilityId);
    const emptyAging = AGING_LABELS.map((label) => ({ label, amount: 0, count: 0 }));
    const now = new Date();

    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { timezone: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
      });
      // El área de clientes, para el enlace de pago que se le manda al reclamar.
      const portalUrl = tenant
        ? tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant)
        : '';
      if (facility === null) {
        return {
          totalAmount: 0,
          customers: 0,
          actionable: 0,
          portalUrl,
          aging: emptyAging,
          rows: [],
        };
      }
      const tz = tenant?.timezone ?? 'Europe/Madrid';
      const startOfToday = todayInTimezone(tz, now);
      const today = startOfToday.toISOString().slice(0, 10);
      // Como en «Hoy»: también las emitidas ya vencidas que el cron aún no ha marcado.
      const overdue = await tx.invoice.findMany({
        where: {
          ...(facility as Prisma.InvoiceWhereInput),
          deletedAt: null,
          kind: 'invoice',
          AND: [
            { OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: startOfToday } }] },
          ],
          customerId: { not: null },
        },
        select: {
          id: true,
          invoiceNumber: true,
          customerId: true,
          total: true,
          amountPaid: true,
          dueDate: true,
          lateFeeInvoice: { select: { id: true } },
          contract: {
            select: {
              id: true,
              status: true,
              deletedAt: true,
              unit: { select: { code: true, facilityId: true } },
            },
          },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      });
      const byCustomer = new Map<string, typeof overdue>();
      for (const inv of overdue) {
        if (toCents(inv.total) - toCents(inv.amountPaid) <= 0) continue;
        byCustomer.set(inv.customerId!, [...(byCustomer.get(inv.customerId!) ?? []), inv]);
      }
      const customerIds = [...byCustomer.keys()];
      const invoiceIds = [...byCustomer.values()].flat().map((i) => i.id);
      // Contratos vivos de la fila, dentro del alcance de quien mira.
      const contractScope: Prisma.ContractWhereInput = facilityId
        ? { unit: { facilityId } }
        : scope
          ? { unit: { facilityId: { in: scope } } }
          : {};
      const [
        customers,
        actions,
        methods,
        mandates,
        plans,
        cases,
        contracts,
        inFlightCharges,
        inRemittance,
        reminders,
        snoozes,
      ] = await Promise.all([
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
            result: true,
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
          where: { customerId: { in: customerIds }, ...CHARGEABLE_MANDATE_WHERE },
          select: { customerId: true },
        }),
        tx.paymentPlan.findMany({
          where: { customerId: { in: customerIds }, status: { in: ['active', 'broken'] } },
          select: {
            id: true,
            customerId: true,
            status: true,
            invoiceIds: true,
            paidAtStart: true,
            installments: true,
            graceDays: true,
            createdAt: true,
          },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
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
            ...contractScope,
          },
          select: { id: true, customerId: true, unit: { select: { code: true } } },
        }),
        tx.payment.findMany({
          where: { invoiceId: { in: invoiceIds }, status: { in: ['pending', 'processing'] } },
          select: { invoiceId: true },
        }),
        tx.sepaRemittanceItem.findMany({
          where: { invoiceId: { in: invoiceIds }, status: 'pending' },
          select: { invoiceId: true },
        }),
        // Recordatorios enviados (automáticos o desde el panel), como el estado
        // de cobro de las facturas.
        tx.communication.findMany({
          where: {
            customerId: { in: customerIds },
            status: { notIn: ['failed', 'skipped'] },
            OR: [
              { invoiceId: { in: invoiceIds }, source: { in: REMINDER_SOURCES } },
              { source: { in: SUMMARY_REMINDER_SOURCES } },
            ],
          },
          select: { customerId: true, sentAt: true, createdAt: true },
        }),
        // Deudores apartados (aquí o en «Hoy»): no cuentan como por reclamar.
        tx.todaySnooze.findMany({
          where: { kind: 'customer_debt', refId: { in: customerIds }, until: { gt: now } },
          select: { id: true, refId: true, until: true },
        }),
      ]);
      const snoozeOf = new Map(snoozes.map((x) => [x.refId, x]));
      const planInvoiceIds = [...new Set(plans.flatMap((p) => p.invoiceIds))];
      const planInvoices = planInvoiceIds.length
        ? await tx.invoice.findMany({
            where: { id: { in: planInvoiceIds } },
            select: { id: true, amountPaid: true },
          })
        : [];
      const paidOf = new Map(planInvoices.map((i) => [i.id, toCents(i.amountPaid)]));

      const invToCustomer = new Map(overdue.map((i) => [i.id, i.customerId!]));
      const actionsBy = new Map<string, typeof actions>();
      for (const a of actions) {
        const c = invToCustomer.get(a.invoiceId);
        if (c) actionsBy.set(c, [...(actionsBy.get(c) ?? []), a]);
      }
      const lastReminderBy = new Map<string, number>();
      for (const r of reminders) {
        if (!r.customerId) continue;
        const at = (r.sentAt ?? r.createdAt).getTime();
        lastReminderBy.set(r.customerId, Math.max(lastReminderBy.get(r.customerId) ?? 0, at));
      }
      const charging = new Set(inFlightCharges.map((p) => p.invoiceId));
      const remitted = new Set(inRemittance.map((i) => i.invoiceId));
      const chargeable = new Set(methods.map((m) => m.customerId));
      const mandate = new Set(mandates.map((m) => m.customerId));
      const agingCents = emptyAging.map(() => ({ c: 0, count: 0 }));
      let actionable = 0;

      const rows: ArrearsRowDto[] = customers.map((c) => {
        const invs = byCustomer.get(c.id) ?? [];
        let amountCents = 0;
        for (const i of invs) {
          const pending = toCents(i.total) - toCents(i.amountPaid);
          amountCents += pending;
          // Antigüedad por factura, como Analítica.
          const daysLate = Math.max(
            0,
            Math.floor((startOfToday.getTime() - (i.dueDate ?? startOfToday).getTime()) / DAY),
          );
          const b = agingCents[agingIndex(daysLate)]!;
          b.c += pending;
          b.count++;
        }
        const since = invs[0]?.dueDate ?? startOfToday;
        const days = Math.max(0, Math.floor((startOfToday.getTime() - since.getTime()) / DAY));
        const acts = actionsBy.get(c.id) ?? [];
        const executed = acts.filter((a) => a.executedAt && a.status !== 'cancelled');
        const dunningReminders = executed
          .filter(
            (a) => a.actionType.startsWith('email_reminder') || a.actionType === 'sms_reminder',
          )
          .map((a) => a.executedAt!.getTime());
        const lastReminder = Math.max(0, lastReminderBy.get(c.id) ?? 0, ...dunningReminders);
        const next = acts
          .filter((a) => a.status === 'scheduled')
          .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0];
        const plan = plans.find((p) => p.customerId === c.id);
        let nextDue: string | null = null;
        if (plan) {
          const paidCents =
            plan.invoiceIds.reduce((s, id) => s + (paidOf.get(id) ?? 0), 0) -
            toCents(plan.paidAtStart);
          nextDue =
            allocateInstallments(
              plan.installments as { dueDate: string; amount: number }[],
              Math.max(0, paidCents) / 100,
              today,
              plan.graceDays,
            ).find((i) => i.status !== 'paid')?.dueDate ?? null;
        }
        const inFlight: ArrearsRowDto['paymentInFlight'] = invs.some((i) => charging.has(i.id))
          ? 'charge'
          : invs.some((i) => remitted.has(i.id))
            ? 'remittance'
            : null;
        const snooze = snoozeOf.get(c.id);
        if (!inFlight && plan?.status !== 'active' && !snooze) actionable++;
        const caseRow = cases.find((k) => k.customerId === c.id);
        const myContracts = contracts.filter((k) => k.customerId === c.id);
        // El contrato con la deuda más antigua (aunque haya terminado), para
        // abrir el expediente sobre él; si no, el primero en marcha.
        const debtContract = invs.find(
          (i) =>
            i.contract &&
            !i.contract.deletedAt &&
            (!scope || scope.includes(i.contract.unit.facilityId)),
        )?.contract;
        const units = myContracts.length
          ? myContracts.map((k) => k.unit.code)
          : [...new Set(invs.flatMap((i) => (i.contract ? [i.contract.unit.code] : [])))];
        return {
          customerId: c.id,
          customerName: nameOf(c),
          email: c.email,
          phone: c.phone,
          amount: amountCents / 100,
          since: since.toISOString().slice(0, 10),
          days,
          invoiceIds: invs.map((i) => i.id),
          invoiceCount: invs.length,
          invoices: invs.map((i) => ({
            id: i.id,
            invoiceNumber: i.invoiceNumber,
            pending: (toCents(i.total) - toCents(i.amountPaid)) / 100,
            dueDate: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : null,
          })),
          snoozed: snooze ? { id: snooze.id, until: snooze.until.toISOString() } : null,
          chargeable: chargeable.has(c.id),
          sepaMandate: mandate.has(c.id),
          lastReminderAt: lastReminder > 0 ? new Date(lastReminder).toISOString() : null,
          lateFeeApplied: invs.some((i) => !!i.lateFeeInvoice),
          accessBlocked: executed.some(accessCutApplied),
          paymentInFlight: inFlight,
          nextStep: next
            ? {
                label: STEP_LABEL[next.actionType] ?? next.actionType,
                date: (next.scheduledFor < startOfToday
                  ? startOfToday
                  : next.scheduledFor
                ).toISOString(),
                postponed: next.scheduledFor < startOfToday,
              }
            : null,
          plan: plan ? { id: plan.id, status: plan.status as PaymentPlanStatus, nextDue } : null,
          collectionsCase: caseRow ? { id: caseRow.id, status: caseRow.status } : null,
          contractId: debtContract?.id ?? myContracts[0]?.id ?? null,
          units,
        };
      });
      rows.sort((a, b) => b.amount - a.amount);
      return {
        totalAmount: rows.reduce((s, r) => s + toCents(r.amount), 0) / 100,
        customers: rows.length,
        actionable,
        portalUrl,
        aging: emptyAging.map((a, k) => ({
          ...a,
          amount: agingCents[k]!.c / 100,
          count: agingCents[k]!.count,
        })),
        rows,
      };
    }, tenantId);
  }

  /**
   * Pago recibido de un deudor: se reparte entre sus facturas vencidas, de la
   * más antigua a la más nueva, y se registra en cada una como el cobro a mano
   * de su ficha (mismas comprobaciones: caja cerrada, doble clic…).
   */
  async registerDebtorPayment(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: DebtorPaymentInput;
    scope: FacilityScope;
    meta: RequestMeta;
  }): Promise<DebtorPaymentResultDto> {
    const { tenantId, customerId, input, scope } = args;
    const facility = invoiceFacilityWhere(scope, undefined);
    if (facility === null) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    const overdue = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const startOfToday = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
      const rows = await tx.invoice.findMany({
        where: {
          ...(facility as Prisma.InvoiceWhereInput),
          customerId,
          deletedAt: null,
          kind: 'invoice',
          AND: [
            { OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: startOfToday } }] },
          ],
        },
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          amountPaid: true,
          payments: {
            where: { status: { in: ['pending', 'processing'] } },
            select: { id: true },
            take: 1,
          },
          sepaRemittanceItems: { where: { status: 'pending' }, select: { id: true }, take: 1 },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      });
      return rows
        .map((r) => ({ ...r, pendingCents: toCents(r.total) - toCents(r.amountPaid) }))
        .filter((r) => r.pendingCents > 0);
    }, tenantId);
    if (overdue.length === 0) {
      throw new BadRequestException({
        code: 'no_overdue_debt',
        message: 'Este inquilino no tiene facturas vencidas por cobrar',
      });
    }
    const debtCents = overdue.reduce((sum, r) => sum + r.pendingCents, 0);
    const amountCents = toCents(input.amount);
    if (amountCents > debtCents) {
      throw new BadRequestException({
        code: 'amount_exceeds_debt',
        message: `El importe supera lo que debe (${(debtCents / 100).toFixed(2).replace('.', ',')} €)`,
      });
    }
    const plan = allocateOldestFirst(overdue, amountCents);
    // Ya se está cobrando por la pasarela o por una remesa: no se registra otro cobro.
    if (
      plan.some(
        ({ invoice }) => invoice.payments.length > 0 || invoice.sepaRemittanceItems.length > 0,
      )
    ) {
      throw new ConflictException({
        code: 'payment_in_progress',
        message:
          'Alguna de esas facturas ya se está cobrando (tarjeta, domiciliación o remesa SEPA). Regístralo desde la factura si sabes que ese cobro no va a entrar.',
      });
    }
    if (input.methodType !== 'cash' && plan.some((x) => x.cents < x.invoice.pendingCents)) {
      throw new BadRequestException({
        code: 'partial_only_cash',
        message:
          'Solo en efectivo se admite pagar una parte de una factura. Por otra vía, el importe debe cubrir facturas enteras.',
      });
    }

    const applied: DebtorPaymentResultDto['applied'] = [];
    let failed: DebtorPaymentResultDto['failed'] = null;
    for (const { invoice, cents } of plan) {
      try {
        const dto = await this.invoices.markPaidManually({
          tenantId,
          userId: args.userId,
          invoiceId: invoice.id,
          facilityScope: scope ?? null,
          input: {
            amount: cents / 100,
            methodType: input.methodType,
            ...(input.notes ? { notes: input.notes } : {}),
          },
          meta: args.meta,
          rejectDuplicate: true,
        });
        applied.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          amount: cents / 100,
          status: dto.status,
        });
      } catch (err) {
        const body = (err as { response?: { message?: unknown } }).response;
        failed = {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          error:
            typeof body?.message === 'string'
              ? body.message
              : err instanceof Error
                ? err.message
                : 'No se pudo registrar',
        };
        break;
      }
    }
    const paidCents = applied.reduce((sum, a) => sum + toCents(a.amount), 0);
    return { applied, failed, remaining: (debtCents - paidCents) / 100 };
  }
}
