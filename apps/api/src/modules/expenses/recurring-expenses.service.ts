import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ExpensePaymentMethodEnum,
  expenseCategoryLabel,
  monthStartOf,
  nextRecurrenceDate,
  recurrencePending,
  type CreateRecurringExpenseInput,
  type ExpenseFrequency,
  type ExpensePaymentMethod,
  type ExpenseWithholdingModel,
  type RecurrenceRule,
  type RecurringExpenseDto,
  type UpdateRecurringExpenseInput,
} from '@storageos/shared';

import { optionalFacilityWhere, type FacilityScope } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import {
  assertCategory,
  assertDay,
  assertTargetAllowed,
  breakdownColumns,
  customCategories,
  dayDate,
  dayString,
  normalizeTaxId,
  num,
  numOrNull,
} from './expense-helpers';

import type { Prisma } from '@storageos/database';

const RECURRING_INCLUDE = {
  facility: { select: { name: true, deletedAt: true } },
  marketingChannel: { select: { name: true } },
  supplier: { select: { name: true } },
} satisfies Prisma.RecurringExpenseInclude;

type RecurringRow = Prisma.RecurringExpenseGetPayload<{ include: typeof RECURRING_INCLUDE }>;

/**
 * Con domiciliación o tarjeta (o sin forma de pago, como hasta ahora) el gasto
 * generado nace pagado; con transferencia, efectivo u otra, pendiente de pagar.
 */
const PENDING_METHODS = new Set(['bank_transfer', 'cash', 'other']);

/**
 * Gastos recurrentes: plantillas que generan un gasto cada mes, trimestre o
 * año, desde el mes de inicio hasta la fecha de fin.
 */
@Injectable()
export class RecurringExpensesService {
  private readonly logger = new Logger(RecurringExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  private rule(r: {
    frequency: string;
    dayOfMonth: number;
    startDate: Date | null;
    endDate: Date | null;
    createdAt: Date;
  }): RecurrenceRule {
    return {
      frequency: (['monthly', 'quarterly', 'yearly'].includes(r.frequency)
        ? r.frequency
        : 'monthly') as ExpenseFrequency,
      dayOfMonth: r.dayOfMonth,
      startDate: dayString(r.startDate) ?? monthStartOf(r.createdAt.toISOString().slice(0, 10)),
      endDate: dayString(r.endDate),
    };
  }

  private async today(tx: Prisma.TransactionClient): Promise<string> {
    const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
    return todayInTimezone(tenant?.timezone ?? 'Europe/Madrid')
      .toISOString()
      .slice(0, 10);
  }

  async list(tenantId: string, scope: FacilityScope = null): Promise<RecurringExpenseDto[]> {
    const facility = optionalFacilityWhere(scope);
    if (!facility) return [];
    return this.prisma.withTenant(async (tx) => {
      const [rows, custom, today] = await Promise.all([
        tx.recurringExpense.findMany({
          where: facility,
          include: RECURRING_INCLUDE,
          orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
        }),
        customCategories(tx),
        this.today(tx),
      ]);
      return rows.map((r) => this.toDto(r, custom, today));
    }, tenantId);
  }

  private async assertRefs(
    tx: Prisma.TransactionClient,
    refs: {
      facilityId?: string | null;
      category?: string;
      marketingChannelId?: string | null;
      supplierId?: string | null;
    },
  ): Promise<void> {
    if (refs.facilityId) {
      const f = await tx.facility.findFirst({
        where: { id: refs.facilityId, deletedAt: null },
        select: { id: true },
      });
      if (!f) {
        throw new BadRequestException({
          code: 'facility_not_found',
          message: 'Local no encontrado',
        });
      }
    }
    if (refs.category !== undefined) await assertCategory(tx, refs.category);
    if (refs.marketingChannelId && refs.category === 'marketing') {
      const c = await tx.marketingChannel.findFirst({
        where: { id: refs.marketingChannelId },
        select: { id: true },
      });
      if (!c) {
        throw new BadRequestException({
          code: 'marketing_channel_not_found',
          message: 'Canal de marketing no encontrado',
        });
      }
    }
    if (refs.supplierId) {
      const s = await tx.expenseSupplier.findFirst({
        where: { id: refs.supplierId },
        select: { id: true },
      });
      if (!s) {
        throw new BadRequestException({
          code: 'supplier_not_found',
          message: 'Proveedor no encontrado',
        });
      }
    }
  }

  private assertDates(startDate?: string | null, endDate?: string | null): void {
    assertDay(startDate, 'inicio');
    assertDay(endDate, 'fin');
    if (startDate && endDate && endDate < startDate) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'La fecha de fin es anterior al inicio',
      });
    }
  }

  async create(
    tenantId: string,
    userId: string | null,
    input: CreateRecurringExpenseInput,
    scope: FacilityScope = null,
  ): Promise<RecurringExpenseDto> {
    const facilityId = input.facilityId ?? null;
    assertTargetAllowed(scope, facilityId);
    this.assertDates(input.startDate, input.endDate);
    const amounts = breakdownColumns(input);
    const channelId = input.category === 'marketing' ? (input.marketingChannelId ?? null) : null;
    return this.prisma.withTenant(async (tx) => {
      await this.assertRefs(tx, {
        facilityId,
        category: input.category,
        marketingChannelId: channelId,
        supplierId: input.supplierId ?? null,
      });
      const today = await this.today(tx);
      const supplier = input.supplierId
        ? await tx.expenseSupplier.findFirst({ where: { id: input.supplierId } })
        : null;
      const row = await tx.recurringExpense.create({
        data: {
          tenantId,
          facilityId,
          category: input.category,
          description: input.description,
          amount: amounts.amount,
          baseAmount: amounts.baseAmount,
          vatRate: amounts.vatRate,
          vatDeductible: amounts.vatDeductible,
          withholdingRate: amounts.withholdingRate,
          withholdingModel: amounts.withholdingModel,
          dayOfMonth: input.dayOfMonth,
          active: input.active,
          frequency: input.frequency,
          startDate: dayDate(monthStartOf(input.startDate ?? today)),
          endDate: input.endDate ? dayDate(input.endDate) : null,
          supplierId: supplier?.id ?? null,
          vendor: input.vendor?.trim() || supplier?.name || null,
          vendorTaxId: normalizeTaxId(input.vendorTaxId) ?? supplier?.taxId ?? null,
          paymentMethod: input.paymentMethod ?? null,
          createdByUserId: userId,
          marketingChannelId: channelId,
        },
        include: RECURRING_INCLUDE,
      });
      return this.toDto(row, await customCategories(tx), today);
    }, tenantId);
  }

  private async editable(
    tx: Prisma.TransactionClient,
    id: string,
    scope: FacilityScope,
  ): Promise<RecurringRow> {
    const existing = await tx.recurringExpense.findFirst({
      where: { id },
      include: RECURRING_INCLUDE,
    });
    if (!existing || (existing.facilityId && scope && !scope.includes(existing.facilityId))) {
      throw new NotFoundException({ code: 'recurring_not_found', message: 'No encontrado' });
    }
    assertTargetAllowed(scope, existing.facilityId);
    return existing;
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateRecurringExpenseInput,
    scope: FacilityScope = null,
  ): Promise<RecurringExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await this.editable(tx, id, scope);
      const facilityId =
        input.facilityId !== undefined ? (input.facilityId ?? null) : existing.facilityId;
      if (input.facilityId !== undefined) assertTargetAllowed(scope, facilityId);
      const category = input.category ?? existing.category;
      const channelId =
        category !== 'marketing'
          ? null
          : input.marketingChannelId !== undefined
            ? (input.marketingChannelId ?? null)
            : existing.marketingChannelId;
      await this.assertRefs(tx, {
        facilityId: input.facilityId !== undefined ? facilityId : null,
        ...(input.category !== undefined ? { category } : {}),
        marketingChannelId: input.marketingChannelId !== undefined ? channelId : null,
        supplierId: input.supplierId ?? null,
      });
      const start =
        input.startDate !== undefined
          ? monthStartOf(input.startDate)
          : dayString(existing.startDate);
      const end =
        input.endDate !== undefined ? (input.endDate ?? null) : dayString(existing.endDate);
      this.assertDates(start, end);

      const data: Prisma.RecurringExpenseUpdateInput = {};
      if (input.facilityId !== undefined)
        data.facility = facilityId ? { connect: { id: facilityId } } : { disconnect: true };
      if (input.category !== undefined) data.category = input.category;
      if (input.description !== undefined) data.description = input.description;
      if (input.dayOfMonth !== undefined) data.dayOfMonth = input.dayOfMonth;
      if (input.frequency !== undefined) data.frequency = input.frequency;
      if (input.startDate !== undefined) data.startDate = dayDate(start!);
      if (input.endDate !== undefined) data.endDate = end ? dayDate(end) : null;
      if (input.vendor !== undefined) data.vendor = input.vendor?.trim() || null;
      if (input.vendorTaxId !== undefined) data.vendorTaxId = normalizeTaxId(input.vendorTaxId);
      if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod ?? null;
      if (input.supplierId !== undefined)
        data.supplier = input.supplierId
          ? { connect: { id: input.supplierId } }
          : { disconnect: true };
      if (channelId !== existing.marketingChannelId) {
        data.marketingChannel = channelId ? { connect: { id: channelId } } : { disconnect: true };
      }
      const touchesAmount =
        input.amount !== undefined ||
        input.baseAmount !== undefined ||
        input.vatRate !== undefined ||
        input.vatDeductible !== undefined ||
        input.withholdingRate !== undefined ||
        input.withholdingModel !== undefined;
      if (touchesAmount) {
        const a = breakdownColumns({
          amount: input.amount ?? num(existing.amount),
          baseAmount:
            input.baseAmount !== undefined ? input.baseAmount : numOrNull(existing.baseAmount),
          vatRate: input.vatRate !== undefined ? input.vatRate : numOrNull(existing.vatRate),
          vatDeductible: input.vatDeductible ?? existing.vatDeductible,
          withholdingRate:
            input.withholdingRate !== undefined
              ? input.withholdingRate
              : numOrNull(existing.withholdingRate),
          withholdingModel:
            input.withholdingModel !== undefined
              ? input.withholdingModel
              : existing.withholdingModel,
        });
        Object.assign(data, {
          amount: a.amount,
          baseAmount: a.baseAmount,
          vatRate: a.vatRate,
          vatDeductible: a.vatDeductible,
          withholdingRate: a.withholdingRate,
          withholdingModel: a.withholdingModel,
        });
      }
      const today = await this.today(tx);
      if (input.active !== undefined) {
        data.active = input.active;
        // Al reactivarla, lo que no se generó mientras estaba pausada no cuenta
        // como «sin generar»; la fecha actual sí se genera.
        if (input.active && !existing.active) {
          const { current, missed } = recurrencePending(
            this.rule({
              ...existing,
              frequency: input.frequency ?? existing.frequency,
              dayOfMonth: input.dayOfMonth ?? existing.dayOfMonth,
              startDate: start ? dayDate(start) : existing.startDate,
              endDate: end ? dayDate(end) : null,
            }),
            today,
            dayString(existing.lastGeneratedMonth),
          );
          const skipped = missed[missed.length - 1];
          if (current && skipped) data.lastGeneratedMonth = dayDate(monthStartOf(skipped));
        }
      }
      const row = await tx.recurringExpense.update({
        where: { id },
        data,
        include: RECURRING_INCLUDE,
      });
      return this.toDto(row, await customCategories(tx), today);
    }, tenantId);
  }

  async remove(tenantId: string, id: string, scope: FacilityScope = null): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      await this.editable(tx, id, scope);
      await tx.recurringExpense.delete({ where: { id } });
    }, tenantId);
  }

  /** El gasto de una fecha de la plantilla. */
  private async createFrom(
    tx: Prisma.TransactionClient,
    tenantId: string,
    r: RecurringRow,
    date: string,
  ): Promise<void> {
    const paid = !r.paymentMethod || !PENDING_METHODS.has(r.paymentMethod);
    const a = breakdownColumns({
      amount: num(r.amount),
      baseAmount: numOrNull(r.baseAmount),
      vatRate: numOrNull(r.vatRate),
      vatDeductible: r.vatDeductible,
      withholdingRate: numOrNull(r.withholdingRate),
      withholdingModel: r.withholdingModel,
    });
    await tx.expense.create({
      data: {
        tenantId,
        facilityId: r.facilityId,
        category: r.category,
        description: r.description,
        expenseDate: dayDate(date),
        notes: 'Generado automáticamente (gasto recurrente)',
        marketingChannelId: r.category === 'marketing' ? r.marketingChannelId : null,
        recurringExpenseId: r.id,
        supplierId: r.supplierId,
        vendor: r.vendor,
        vendorTaxId: r.vendorTaxId,
        ...a,
        paymentStatus: paid ? 'paid' : 'pending',
        paidAt: paid ? dayDate(date) : null,
        paymentMethod: r.paymentMethod,
        dueDate: paid ? null : dayDate(date),
      },
    });
  }

  /**
   * Genera los gastos de las plantillas cuya fecha ya llegó (en la hora del
   * negocio) y no se generó. Cada plantilla se reserva antes de crear su gasto:
   * dos «Generar ahora» a la vez (o con la tarea de las 06:00) no lo duplican.
   * Las fechas anteriores que se quedaron sin generar no se crean solas: se
   * avisan y se generan con `catchUp`.
   */
  async generateForTenant(tenantId: string): Promise<{ created: number }> {
    return this.prisma.withTenant(async (tx) => {
      const today = await this.today(tx);
      const templates = await tx.recurringExpense.findMany({
        where: { active: true, OR: [{ facilityId: null }, { facility: { deletedAt: null } }] },
        include: RECURRING_INCLUDE,
      });
      let created = 0;
      for (const r of templates) {
        const { current } = recurrencePending(this.rule(r), today, dayString(r.lastGeneratedMonth));
        if (!current) continue;
        const month = dayDate(monthStartOf(current));
        // Reserva: solo quien la pasa a esta fecha crea el gasto.
        const claimed = await tx.recurringExpense.updateMany({
          where: {
            id: r.id,
            OR: [{ lastGeneratedMonth: null }, { lastGeneratedMonth: { lt: month } }],
          },
          data: { lastGeneratedMonth: month },
        });
        if (claimed.count === 0) continue;
        await this.createFrom(tx, tenantId, r, current);
        created += 1;
      }
      return { created };
    }, tenantId);
  }

  /** Genera las fechas que se quedaron sin generar de una plantilla. */
  async catchUp(
    tenantId: string,
    id: string,
    scope: FacilityScope = null,
  ): Promise<{ created: number }> {
    return this.prisma.withTenant(async (tx) => {
      const r = await this.editable(tx, id, scope);
      const today = await this.today(tx);
      const { current, missed } = recurrencePending(
        this.rule(r),
        today,
        dayString(r.lastGeneratedMonth),
      );
      const dates = [...missed, ...(current ? [current] : [])];
      if (dates.length === 0) return { created: 0 };
      const last = dayDate(monthStartOf(dates[dates.length - 1]!));
      const claimed = await tx.recurringExpense.updateMany({
        where: {
          id: r.id,
          lastGeneratedMonth: r.lastGeneratedMonth,
        },
        data: { lastGeneratedMonth: last },
      });
      if (claimed.count === 0) return { created: 0 };
      for (const d of dates) await this.createFrom(tx, tenantId, r, d);
      return { created: dates.length };
    }, tenantId);
  }

  /** Cron: genera los gastos recurrentes vencidos de TODOS los tenants. */
  async generateDueAll(): Promise<{ tenants: number; created: number }> {
    const tenants = await this.admin.recurringExpense.findMany({
      // Una empresa dada de baja o anonimizada deja de generar gastos.
      where: { active: true, tenant: { deletedAt: null, status: { not: 'cancelled' } } },
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

  private toDto(
    r: RecurringRow,
    custom: { id: string; name: string }[],
    today: string,
  ): RecurringExpenseDto {
    const rule = this.rule(r);
    const last = dayString(r.lastGeneratedMonth);
    const pending = recurrencePending(rule, today, last);
    // La próxima: la de hoy si aún no se generó; si no, la siguiente.
    const nextDate = !r.active ? null : (pending.current ?? nextRecurrenceDate(rule, today));
    const method = ExpensePaymentMethodEnum.safeParse(r.paymentMethod);
    const totals = breakdownColumns({
      amount: num(r.amount),
      baseAmount: numOrNull(r.baseAmount),
      vatRate: numOrNull(r.vatRate),
      vatDeductible: r.vatDeductible,
      withholdingRate: numOrNull(r.withholdingRate),
      withholdingModel: r.withholdingModel,
    });
    return {
      id: r.id,
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      category: r.category,
      categoryLabel: expenseCategoryLabel(r.category, custom),
      description: r.description,
      amount: num(r.amount),
      dayOfMonth: r.dayOfMonth,
      active: r.active,
      lastGeneratedMonth: last,
      marketingChannelId: r.marketingChannelId,
      marketingChannelName: r.marketingChannel?.name ?? null,
      frequency: rule.frequency,
      startDate: rule.startDate,
      endDate: rule.endDate,
      supplierId: r.supplierId,
      supplierName: r.supplier?.name ?? null,
      vendor: r.vendor,
      vendorTaxId: r.vendorTaxId,
      broken: r.baseAmount !== null,
      baseAmount: numOrNull(r.baseAmount),
      vatRate: numOrNull(r.vatRate),
      vatDeductible: r.vatDeductible,
      withholdingRate: numOrNull(r.withholdingRate),
      withholdingModel: r.withholdingModel as ExpenseWithholdingModel | null,
      totalAmount: totals.totalAmount ?? totals.amount,
      paymentMethod: method.success ? (method.data as ExpensePaymentMethod) : null,
      nextDate,
      missedDates: r.active ? pending.missed : [],
      createdAt: r.createdAt.toISOString(),
    };
  }
}
