import { BadRequestException, Injectable } from '@nestjs/common';
import {
  expenseCategoryLabel,
  type ExpenseBudgetDto,
  type ProfitLossAllocation,
  type ProfitLossDto,
  type ProfitLossMonthlyDto,
  type ProfitLossRowDto,
  type UpdateExpenseBudgetsInput,
} from '@storageos/shared';

import { type FacilityScope } from '../../common/facility-scope';
import { zonedDayStart, zonedNextDayStart } from '../../common/format';
import { resolveAnalyticsScope, type AnalyticsScope } from '../analytics/analytics-scope';
import {
  INVOICED_SELECT,
  collectedWhere,
  invoicedBase,
  invoicedWhere,
} from '../analytics/business-metrics';
import { PrismaService } from '../database/prisma.service';

import {
  assertCategory,
  assertDay,
  assertUuidParam,
  customCategories,
  dayDate,
  num,
  round2,
} from './expense-helpers';

import type { Prisma } from '@storageos/database';

const GENERAL = '__none__';
const MAX_MONTHS = 24;

const FACILITY_OF = {
  facilityId: true,
  contract: { select: { unit: { select: { facilityId: true } } } },
  productSale: { select: { facilityId: true } },
} as const;

type WithFacility = {
  facilityId: string | null;
  contract: { unit: { facilityId: string } | null } | null;
  productSale: { facilityId: string | null } | null;
} | null;

/** Local al que se imputa una factura: el de su contrato, el suyo o el de su venta. */
const facilityKey = (i: WithFacility): string =>
  i?.contract?.unit?.facilityId ?? i?.facilityId ?? i?.productSale?.facilityId ?? GENERAL;

function shiftDays(day: string, days: number): string {
  const d = dayDate(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Meses (fracción) que abarca un periodo: cada mes cuenta por los días que entran. */
function monthsIn(from: string, to: string): number {
  let total = 0;
  let cursor = dayDate(from);
  const end = dayDate(to);
  while (cursor <= end) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const monthEnd = new Date(Date.UTC(y, m, daysInMonth));
    const last = monthEnd < end ? monthEnd : end;
    const days = Math.round((last.getTime() - cursor.getTime()) / 86_400_000) + 1;
    total += days / daysInMonth;
    cursor = new Date(Date.UTC(y, m + 1, 1));
  }
  return total;
}

interface PnlOptions {
  facilityScope?: FacilityScope;
  invoicesVisible?: boolean;
  paymentsVisible?: boolean;
}

/** Cuenta de resultados, serie mensual y presupuesto de los gastos. */
@Injectable()
export class ProfitLossService {
  constructor(private readonly prisma: PrismaService) {}

  private assertRange(from: string | undefined, to: string | undefined): void {
    if (!from || !to) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'Indica el periodo (desde y hasta)',
      });
    }
    assertDay(from, 'desde');
    assertDay(to, 'hasta');
    if (from > to) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'La fecha «desde» es posterior a «hasta»',
      });
    }
  }

  private expenseWhere(scope: AnalyticsScope, from: string, to: string): Prisma.ExpenseWhereInput {
    return {
      expenseDate: { gte: dayDate(from), lte: dayDate(to) },
      ...(scope.ids ? { OR: [{ facilityId: { in: scope.ids } }, { facilityId: null }] } : {}),
    };
  }

  /**
   * Cuenta de resultados por local con las mismas reglas que el Resumen:
   * facturado sin IVA (una sustitutiva cuenta la diferencia, los abonos restan,
   * sin fianzas) − gastos = resultado. Los gastos generales se pueden repartir
   * entre los locales por trasteros, m² o lo facturado (los pesos se calculan
   * con todos los locales: quien solo ve unos recibe su parte, no todo).
   */
  async getProfitLoss(
    tenantId: string,
    from: string | undefined,
    to: string | undefined,
    opts: PnlOptions & { allocation?: ProfitLossAllocation } = {},
  ): Promise<ProfitLossDto> {
    this.assertRange(from, to);
    const invoicesVisible = opts.invoicesVisible !== false;
    const paymentsVisible = opts.paymentsVisible !== false;
    const allocation = opts.allocation ?? 'none';
    const scope = resolveAnalyticsScope(opts.facilityScope ?? null);
    const days = Math.round((dayDate(to!).getTime() - dayDate(from!).getTime()) / 86_400_000) + 1;
    const prevTo = shiftDays(from!, -1);
    const prevFrom = shiftDays(prevTo, -(days - 1));

    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
      const tz = tenant?.timezone ?? 'Europe/Madrid';
      const toNext = dayDate(shiftDays(to!, 1));
      const [
        invoices,
        payments,
        expenses,
        facilities,
        custom,
        budgets,
        prevInvoices,
        prevExpenses,
      ] = await Promise.all([
        invoicesVisible
          ? tx.invoice.findMany({
              where: invoicedWhere(scope, dayDate(from!), toNext),
              select: { ...INVOICED_SELECT, ...FACILITY_OF },
            })
          : Promise.resolve([]),
        paymentsVisible
          ? tx.payment.findMany({
              where: collectedWhere(scope, zonedDayStart(from!, tz), zonedNextDayStart(to!, tz)),
              select: { amount: true, refundedAmount: true, invoice: { select: FACILITY_OF } },
            })
          : Promise.resolve([]),
        tx.expense.findMany({
          where: this.expenseWhere(scope, from!, to!),
          select: { facilityId: true, amount: true, category: true },
        }),
        tx.facility.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true },
        }),
        customCategories(tx),
        tx.expenseBudget.findMany(),
        invoicesVisible
          ? tx.invoice.findMany({
              where: invoicedWhere(scope, dayDate(prevFrom), dayDate(from!)),
              select: INVOICED_SELECT,
            })
          : Promise.resolve([]),
        tx.expense.aggregate({
          where: this.expenseWhere(scope, prevFrom, prevTo),
          _sum: { amount: true },
        }),
      ]);

      const acc = new Map<string, { invoiced: number; collected: number; expenses: number }>();
      const bump = (key: string, field: 'invoiced' | 'collected' | 'expenses', v: number) => {
        const e = acc.get(key) ?? { invoiced: 0, collected: 0, expenses: 0 };
        e[field] += v;
        acc.set(key, e);
      };
      for (const i of invoices) bump(facilityKey(i), 'invoiced', invoicedBase(i));
      for (const p of payments)
        bump(facilityKey(p.invoice), 'collected', num(p.amount) - num(p.refundedAmount));
      for (const ex of expenses) bump(ex.facilityId ?? GENERAL, 'expenses', num(ex.amount));

      // Reparto de los generales: pesos con todos los locales de la empresa.
      const general = acc.get(GENERAL)?.expenses ?? 0;
      const allocated = new Map<string, number>();
      if (allocation !== 'none' && general > 0) {
        const weights = await this.weights(tx, allocation, facilities, dayDate(from!), toNext);
        const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
        if (totalWeight > 0) {
          for (const [facilityId, w] of weights) {
            if (w <= 0) continue;
            if (scope.ids && !scope.ids.includes(facilityId)) continue;
            allocated.set(facilityId, (general * w) / totalWeight);
            if (!acc.has(facilityId))
              acc.set(facilityId, { invoiced: 0, collected: 0, expenses: 0 });
          }
        }
      }
      const allocatedTotal = [...allocated.values()].reduce((a, b) => a + b, 0);

      const nameById = new Map(facilities.map((f) => [f.id, f.name]));
      const rows: ProfitLossRowDto[] = [...acc.entries()]
        .map(([key, v]) => {
          const isGeneral = key === GENERAL;
          // Lo que queda sin repartir (p. ej. la parte de los locales que no ves).
          const expenses = isGeneral ? v.expenses - allocatedTotal : v.expenses;
          const share = isGeneral ? 0 : (allocated.get(key) ?? 0);
          const net = invoicesVisible ? v.invoiced - expenses - share : 0;
          return {
            facilityId: isGeneral ? null : key,
            facilityName: isGeneral
              ? allocation === 'none'
                ? 'Sin local'
                : 'Sin local (sin repartir)'
              : (nameById.get(key) ?? 'Local eliminado'),
            invoiced: round2(v.invoiced),
            collected: round2(v.collected),
            expenses: round2(expenses),
            allocatedGeneral: round2(share),
            net: round2(net),
            margin:
              invoicesVisible && v.invoiced > 0 ? Math.round((net / v.invoiced) * 1000) / 10 : null,
          };
        })
        .filter(
          (r) =>
            r.facilityId !== null ||
            r.invoiced !== 0 ||
            r.collected !== 0 ||
            Math.abs(r.expenses) >= 0.005,
        )
        .sort((a, b) => b.net - a.net || b.expenses - a.expenses);

      const totals = {
        invoiced: round2(invoices.reduce((s, i) => s + invoicedBase(i), 0)),
        collected: round2(payments.reduce((s, p) => s + num(p.amount) - num(p.refundedAmount), 0)),
        expenses: round2(expenses.reduce((s, e) => s + num(e.amount), 0)),
        net: 0,
      };
      totals.net = invoicesVisible ? round2(totals.invoiced - totals.expenses) : 0;

      const months = monthsIn(from!, to!);
      const budgetOf = new Map(budgets.map((b) => [b.category, num(b.monthlyAmount)]));
      const catMap = new Map<string, number>();
      for (const ex of expenses)
        catMap.set(ex.category, (catMap.get(ex.category) ?? 0) + num(ex.amount));
      for (const b of budgets) if (!catMap.has(b.category)) catMap.set(b.category, 0);
      const byCategory = [...catMap.entries()]
        .map(([category, amount]) => ({
          category,
          label: expenseCategoryLabel(category, custom),
          amount: round2(amount),
          budget: budgetOf.has(category) ? round2(budgetOf.get(category)! * months) : null,
        }))
        .sort((a, b) => b.amount - a.amount);

      const prevInvoiced = round2(prevInvoices.reduce((s, i) => s + invoicedBase(i), 0));
      const prevExpenseSum = round2(num(prevExpenses._sum.amount));
      return {
        from: from!,
        to: to!,
        allocation,
        rows,
        totals,
        previous: {
          from: prevFrom,
          to: prevTo,
          invoiced: prevInvoiced,
          expenses: prevExpenseSum,
          net: invoicesVisible ? round2(prevInvoiced - prevExpenseSum) : 0,
        },
        byCategory,
        invoicesVisible,
        paymentsVisible,
      };
    }, tenantId);
  }

  /** Peso de cada local para repartir los gastos generales. */
  private async weights(
    tx: Prisma.TransactionClient,
    allocation: ProfitLossAllocation,
    facilities: { id: string }[],
    from: Date,
    toNext: Date,
  ): Promise<Map<string, number>> {
    const live = new Set(facilities.map((f) => f.id));
    const out = new Map<string, number>();
    if (allocation === 'units' || allocation === 'area') {
      const units = await tx.unit.groupBy({
        by: ['facilityId'],
        _count: { _all: true },
        _sum: { areaM2: true },
      });
      for (const u of units) {
        if (!live.has(u.facilityId)) continue;
        out.set(u.facilityId, allocation === 'units' ? u._count._all : num(u._sum.areaM2));
      }
      return out;
    }
    // Por lo facturado: con toda la empresa, no solo lo que ve quien pregunta.
    const all = resolveAnalyticsScope(null);
    const invoices = await tx.invoice.findMany({
      where: invoicedWhere(all, from, toNext),
      select: { ...INVOICED_SELECT, ...FACILITY_OF },
    });
    for (const i of invoices) {
      const key = facilityKey(i);
      if (key === GENERAL || !live.has(key)) continue;
      out.set(key, (out.get(key) ?? 0) + Math.max(0, invoicedBase(i)));
    }
    return out;
  }

  /** Mes a mes: facturado sin IVA, cobrado, gastos y resultado. */
  async getMonthly(
    tenantId: string,
    from: string | undefined,
    to: string | undefined,
    opts: PnlOptions & { facilityId?: string } = {},
  ): Promise<ProfitLossMonthlyDto> {
    this.assertRange(from, to);
    assertUuidParam(opts.facilityId, 'invalid_facility_id', 'Local');
    const invoicesVisible = opts.invoicesVisible !== false;
    const paymentsVisible = opts.paymentsVisible !== false;
    const scope = resolveAnalyticsScope(opts.facilityScope ?? null);
    if (opts.facilityId && scope.ids && !scope.ids.includes(opts.facilityId)) {
      return { months: [], invoicesVisible, paymentsVisible };
    }
    // Meses del periodo (como mucho 24).
    const keys: string[] = [];
    let y = Number(from!.slice(0, 4));
    let m = Number(from!.slice(5, 7));
    const endKey = to!.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      keys.push(key);
      if (key >= endKey || keys.length >= MAX_MONTHS) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    const lastDay = keys[keys.length - 1]! < endKey ? undefined : to!;
    const periodTo =
      lastDay ??
      new Date(Date.UTC(Number(keys.at(-1)!.slice(0, 4)), Number(keys.at(-1)!.slice(5, 7)), 0))
        .toISOString()
        .slice(0, 10);

    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
      const tz = tenant?.timezone ?? 'Europe/Madrid';
      const toNext = dayDate(shiftDays(periodTo, 1));
      const onlyFacility = (i: WithFacility) =>
        !opts.facilityId || facilityKey(i) === opts.facilityId;
      const [invoices, payments, expenses] = await Promise.all([
        invoicesVisible
          ? tx.invoice.findMany({
              where: invoicedWhere(scope, dayDate(from!), toNext),
              select: { ...INVOICED_SELECT, ...FACILITY_OF },
            })
          : Promise.resolve([]),
        paymentsVisible
          ? tx.payment.findMany({
              where: collectedWhere(
                scope,
                zonedDayStart(from!, tz),
                zonedNextDayStart(periodTo, tz),
              ),
              select: {
                amount: true,
                refundedAmount: true,
                paidAt: true,
                invoice: { select: FACILITY_OF },
              },
            })
          : Promise.resolve([]),
        tx.expense.findMany({
          where: {
            ...this.expenseWhere(scope, from!, periodTo),
            ...(opts.facilityId ? { facilityId: opts.facilityId } : {}),
          },
          select: { amount: true, expenseDate: true },
        }),
      ]);
      const monthOfPaid = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
      });
      const acc = new Map(keys.map((k) => [k, { invoiced: 0, collected: 0, expenses: 0 }]));
      for (const i of invoices) {
        if (!onlyFacility(i) || !i.issueDate) continue;
        acc.get(i.issueDate.toISOString().slice(0, 7))!.invoiced += invoicedBase(i);
      }
      for (const p of payments) {
        if (!onlyFacility(p.invoice) || !p.paidAt) continue;
        const key = monthOfPaid.format(p.paidAt).slice(0, 7);
        const bucket = acc.get(key);
        if (bucket) bucket.collected += num(p.amount) - num(p.refundedAmount);
      }
      for (const e of expenses) {
        const bucket = acc.get(e.expenseDate.toISOString().slice(0, 7));
        if (bucket) bucket.expenses += num(e.amount);
      }
      return {
        months: keys.map((month) => {
          const v = acc.get(month)!;
          return {
            month,
            invoiced: round2(v.invoiced),
            collected: round2(v.collected),
            expenses: round2(v.expenses),
            net: invoicesVisible ? round2(v.invoiced - v.expenses) : 0,
          };
        }),
        invoicesVisible,
        paymentsVisible,
      };
    }, tenantId);
  }

  // ---- presupuesto ----

  async getBudgets(tenantId: string): Promise<ExpenseBudgetDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const [rows, custom] = await Promise.all([
        tx.expenseBudget.findMany({ orderBy: { category: 'asc' } }),
        customCategories(tx),
      ]);
      return rows.map((r) => ({
        category: r.category,
        label: expenseCategoryLabel(r.category, custom),
        monthlyAmount: num(r.monthlyAmount),
      }));
    }, tenantId);
  }

  /** Sustituye el presupuesto: una categoría con 0 o ausente se queda sin presupuesto. */
  async setBudgets(
    tenantId: string,
    input: UpdateExpenseBudgetsInput,
  ): Promise<ExpenseBudgetDto[]> {
    await this.prisma.withTenant(async (tx) => {
      for (const b of input.budgets) await assertCategory(tx, b.category);
      await tx.expenseBudget.deleteMany({});
      const rows = input.budgets.filter((b) => b.monthlyAmount > 0);
      const seen = new Set<string>();
      for (const b of rows) {
        if (seen.has(b.category)) continue;
        seen.add(b.category);
        await tx.expenseBudget.create({
          data: { tenantId, category: b.category, monthlyAmount: b.monthlyAmount },
        });
      }
    }, tenantId);
    return this.getBudgets(tenantId);
  }
}
