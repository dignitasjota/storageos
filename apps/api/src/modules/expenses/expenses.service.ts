import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CreateExpenseInput,
  CreateRecurringExpenseInput,
  ExpenseCategory,
  ExpenseDto,
  ProfitLossDto,
  ProfitLossRowDto,
  RecurringExpenseDto,
  UpdateExpenseInput,
  UpdateRecurringExpenseInput,
} from '@storageos/shared';

const num = (d: Prisma.Decimal | number): number => Number(d);
const round2 = (n: number): number => Math.round(n * 100) / 100;

type ExpenseRow = {
  id: string;
  facilityId: string | null;
  category: string;
  description: string;
  amount: Prisma.Decimal;
  expenseDate: Date;
  vendor: string | null;
  notes: string | null;
  createdAt: Date;
  facility: { name: string } | null;
};

type RecurringRow = {
  id: string;
  facilityId: string | null;
  category: string;
  description: string;
  amount: Prisma.Decimal;
  dayOfMonth: number;
  active: boolean;
  lastGeneratedMonth: Date | null;
  createdAt: Date;
  facility: { name: string } | null;
};

@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  async list(
    tenantId: string,
    filters: { facilityId?: string; category?: string; from?: string; to?: string },
  ): Promise<ExpenseDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const where: Prisma.ExpenseWhereInput = {};
      if (filters.facilityId) where.facilityId = filters.facilityId;
      if (filters.category) where.category = filters.category;
      if (filters.from || filters.to) {
        where.expenseDate = {};
        if (filters.from) where.expenseDate.gte = new Date(`${filters.from}T00:00:00.000Z`);
        if (filters.to) where.expenseDate.lte = new Date(`${filters.to}T00:00:00.000Z`);
      }
      const rows = await tx.expense.findMany({
        where,
        include: { facility: { select: { name: true } } },
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      });
      return rows.map((r) => this.toDto(r));
    }, tenantId);
  }

  async create(
    tenantId: string,
    userId: string | null,
    input: CreateExpenseInput,
  ): Promise<ExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.expense.create({
        data: {
          tenantId,
          facilityId: input.facilityId ?? null,
          category: input.category,
          description: input.description,
          amount: input.amount,
          expenseDate: new Date(`${input.expenseDate}T00:00:00.000Z`),
          vendor: input.vendor?.trim() || null,
          notes: input.notes?.trim() || null,
          createdByUserId: userId,
        },
        include: { facility: { select: { name: true } } },
      });
      return this.toDto(row);
    }, tenantId);
  }

  async update(tenantId: string, id: string, input: UpdateExpenseInput): Promise<ExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await tx.expense.findFirst({ where: { id }, select: { id: true } });
      if (!existing)
        throw new NotFoundException({ code: 'expense_not_found', message: 'Gasto no encontrado' });
      const data: Prisma.ExpenseUpdateInput = {};
      if (input.facilityId !== undefined) {
        data.facility = input.facilityId
          ? { connect: { id: input.facilityId } }
          : { disconnect: true };
      }
      if (input.category !== undefined) data.category = input.category;
      if (input.description !== undefined) data.description = input.description;
      if (input.amount !== undefined) data.amount = input.amount;
      if (input.expenseDate !== undefined)
        data.expenseDate = new Date(`${input.expenseDate}T00:00:00.000Z`);
      if (input.vendor !== undefined) data.vendor = input.vendor?.trim() || null;
      if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
      const row = await tx.expense.update({
        where: { id },
        data,
        include: { facility: { select: { name: true } } },
      });
      return this.toDto(row);
    }, tenantId);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const existing = await tx.expense.findFirst({ where: { id }, select: { id: true } });
      if (!existing)
        throw new NotFoundException({ code: 'expense_not_found', message: 'Gasto no encontrado' });
      await tx.expense.delete({ where: { id } });
    }, tenantId);
  }

  /**
   * Cuenta de resultados por local: ingresos (facturado + cobrado) − gastos = neto.
   * Los ingresos se imputan al local del contrato de cada factura; las facturas sin
   * contrato (F2/producto) y los gastos sin local caen al bucket «Sin local».
   */
  async getProfitLoss(tenantId: string, from: string, to: string): Promise<ProfitLossDto> {
    return this.prisma.withTenant(async (tx) => {
      const fromD = new Date(`${from}T00:00:00.000Z`);
      const toD = new Date(`${to}T23:59:59.999Z`);
      const [invoices, payments, expenses, facilities] = await Promise.all([
        tx.invoice.findMany({
          where: {
            issueDate: { gte: fromD, lte: toD },
            status: { notIn: ['draft', 'cancelled'] },
            deletedAt: null,
          },
          select: { total: true, contract: { select: { unit: { select: { facilityId: true } } } } },
        }),
        tx.payment.findMany({
          where: { status: 'succeeded', paidAt: { gte: fromD, lte: toD } },
          select: {
            amount: true,
            invoice: {
              select: { contract: { select: { unit: { select: { facilityId: true } } } } },
            },
          },
        }),
        tx.expense.findMany({
          where: { expenseDate: { gte: fromD, lte: toD } },
          select: { facilityId: true, amount: true, category: true },
        }),
        tx.facility.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
      ]);

      const GENERAL = '__none__';
      const acc = new Map<string, { invoiced: number; collected: number; expenses: number }>();
      const bump = (key: string, field: 'invoiced' | 'collected' | 'expenses', v: number) => {
        const e = acc.get(key) ?? { invoiced: 0, collected: 0, expenses: 0 };
        e[field] += v;
        acc.set(key, e);
      };
      for (const i of invoices)
        bump(i.contract?.unit.facilityId ?? GENERAL, 'invoiced', num(i.total));
      for (const p of payments)
        bump(p.invoice?.contract?.unit.facilityId ?? GENERAL, 'collected', num(p.amount));
      for (const ex of expenses) bump(ex.facilityId ?? GENERAL, 'expenses', num(ex.amount));

      const nameById = new Map(facilities.map((f) => [f.id, f.name]));
      const rows: ProfitLossRowDto[] = [...acc.entries()]
        .map(([key, v]) => ({
          facilityId: key === GENERAL ? null : key,
          facilityName: key === GENERAL ? 'Sin local' : (nameById.get(key) ?? 'Local eliminado'),
          invoiced: round2(v.invoiced),
          collected: round2(v.collected),
          expenses: round2(v.expenses),
          net: round2(v.invoiced - v.expenses),
        }))
        .sort((a, b) => b.net - a.net);

      const totals = rows.reduce(
        (t, r) => ({
          invoiced: round2(t.invoiced + r.invoiced),
          collected: round2(t.collected + r.collected),
          expenses: round2(t.expenses + r.expenses),
          net: round2(t.net + r.net),
        }),
        { invoiced: 0, collected: 0, expenses: 0, net: 0 },
      );

      const catMap = new Map<string, number>();
      for (const ex of expenses)
        catMap.set(ex.category, (catMap.get(ex.category) ?? 0) + num(ex.amount));
      const byCategory = [...catMap.entries()]
        .map(([category, amount]) => ({
          category: category as ExpenseCategory,
          amount: round2(amount),
        }))
        .sort((a, b) => b.amount - a.amount);

      return { from, to, rows, totals, byCategory };
    }, tenantId);
  }

  // ---- gastos recurrentes (plantillas) ----

  async listRecurring(tenantId: string): Promise<RecurringExpenseDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.recurringExpense.findMany({
        include: { facility: { select: { name: true } } },
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      });
      return rows.map((r) => this.toRecurringDto(r));
    }, tenantId);
  }

  async createRecurring(
    tenantId: string,
    userId: string | null,
    input: CreateRecurringExpenseInput,
  ): Promise<RecurringExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.recurringExpense.create({
        data: {
          tenantId,
          facilityId: input.facilityId ?? null,
          category: input.category,
          description: input.description,
          amount: input.amount,
          dayOfMonth: input.dayOfMonth,
          active: input.active,
          createdByUserId: userId,
        },
        include: { facility: { select: { name: true } } },
      });
      return this.toRecurringDto(row);
    }, tenantId);
  }

  async updateRecurring(
    tenantId: string,
    id: string,
    input: UpdateRecurringExpenseInput,
  ): Promise<RecurringExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await tx.recurringExpense.findFirst({ where: { id }, select: { id: true } });
      if (!existing)
        throw new NotFoundException({ code: 'recurring_not_found', message: 'No encontrado' });
      const data: Prisma.RecurringExpenseUpdateInput = {};
      if (input.facilityId !== undefined)
        data.facility = input.facilityId
          ? { connect: { id: input.facilityId } }
          : { disconnect: true };
      if (input.category !== undefined) data.category = input.category;
      if (input.description !== undefined) data.description = input.description;
      if (input.amount !== undefined) data.amount = input.amount;
      if (input.dayOfMonth !== undefined) data.dayOfMonth = input.dayOfMonth;
      if (input.active !== undefined) data.active = input.active;
      const row = await tx.recurringExpense.update({
        where: { id },
        data,
        include: { facility: { select: { name: true } } },
      });
      return this.toRecurringDto(row);
    }, tenantId);
  }

  async removeRecurring(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const existing = await tx.recurringExpense.findFirst({ where: { id }, select: { id: true } });
      if (!existing)
        throw new NotFoundException({ code: 'recurring_not_found', message: 'No encontrado' });
      await tx.recurringExpense.delete({ where: { id } });
    }, tenantId);
  }

  /**
   * Genera los gastos de las plantillas recurrentes vencidas de un tenant: por
   * cada plantilla activa cuyo `dayOfMonth` ya llegó este mes y que no se ha
   * generado aún este mes, crea el `expense` y avanza `lastGeneratedMonth`.
   * Idempotente (dedup por `lastGeneratedMonth`).
   */
  async generateForTenant(tenantId: string, now = new Date()): Promise<{ created: number }> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const day = now.getUTCDate();
    return this.prisma.withTenant(async (tx) => {
      const due = await tx.recurringExpense.findMany({
        where: {
          active: true,
          dayOfMonth: { lte: day },
          OR: [{ lastGeneratedMonth: null }, { lastGeneratedMonth: { lt: monthStart } }],
        },
      });
      let created = 0;
      for (const r of due) {
        const expenseDate = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), r.dayOfMonth),
        );
        await tx.expense.create({
          data: {
            tenantId,
            facilityId: r.facilityId,
            category: r.category,
            description: r.description,
            amount: r.amount,
            expenseDate,
            notes: 'Generado automáticamente (gasto recurrente)',
          },
        });
        await tx.recurringExpense.update({
          where: { id: r.id },
          data: { lastGeneratedMonth: monthStart },
        });
        created += 1;
      }
      return { created };
    }, tenantId);
  }

  /** Cron: genera los gastos recurrentes vencidos de TODOS los tenants. */
  async generateDueAll(): Promise<{ tenants: number; created: number }> {
    const tenants = await this.admin.recurringExpense.findMany({
      where: { active: true },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    let created = 0;
    for (const t of tenants) {
      try {
        const res = await this.generateForTenant(t.tenantId);
        created += res.created;
      } catch (err) {
        this.logger.warn(
          `Gastos recurrentes del tenant ${t.tenantId} fallaron: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { tenants: tenants.length, created };
  }

  private toRecurringDto(r: RecurringRow): RecurringExpenseDto {
    return {
      id: r.id,
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      category: r.category as ExpenseCategory,
      description: r.description,
      amount: num(r.amount),
      dayOfMonth: r.dayOfMonth,
      active: r.active,
      lastGeneratedMonth: r.lastGeneratedMonth
        ? r.lastGeneratedMonth.toISOString().slice(0, 10)
        : null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private toDto(r: ExpenseRow): ExpenseDto {
    return {
      id: r.id,
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      category: r.category as ExpenseCategory,
      description: r.description,
      amount: num(r.amount),
      expenseDate: r.expenseDate.toISOString().slice(0, 10),
      vendor: r.vendor,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
