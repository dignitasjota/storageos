import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CUSTOM_EXPENSE_CATEGORY_PREFIX,
  EXPENSE_CATEGORY_LABELS,
  ExpenseCategoryEnum,
  expenseCategoryLabel,
  type CreateExpenseCategoryInput,
  type CreateExpenseSupplierInput,
  type ExpenseCategoryDto,
  type ExpenseSupplierDto,
  type ExpensePaymentMethod,
  type ExpenseWithholdingModel,
  type UpdateExpenseSupplierInput,
} from '@storageos/shared';

import { PrismaService } from '../database/prisma.service';

import {
  assertCategory,
  customCategories,
  normalizeTaxId,
  num,
  numOrNull,
  round2,
} from './expense-helpers';

import type { Prisma } from '@storageos/database';

type SupplierRow = Prisma.ExpenseSupplierGetPayload<Record<string, never>>;

/** Proveedores y categorías propias de los gastos. */
@Injectable()
export class ExpenseCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- categorías ----

  /** Las de siempre y las propias, con cuántos gastos usan cada una. */
  async listCategories(tenantId: string): Promise<ExpenseCategoryDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const [custom, usage] = await Promise.all([
        tx.expenseCategory.findMany({ orderBy: { name: 'asc' } }),
        tx.expense.groupBy({ by: ['category'], _count: { _all: true } }),
      ]);
      const used = new Map(usage.map((u) => [u.category, u._count._all]));
      return [
        ...ExpenseCategoryEnum.options.map((key) => ({
          key,
          name: EXPENSE_CATEGORY_LABELS[key],
          builtin: true,
          usage: used.get(key) ?? 0,
        })),
        ...custom.map((c) => {
          const key = `${CUSTOM_EXPENSE_CATEGORY_PREFIX}${c.id}`;
          return { key, name: c.name, builtin: false, usage: used.get(key) ?? 0 };
        }),
      ];
    }, tenantId);
  }

  async createCategory(
    tenantId: string,
    input: CreateExpenseCategoryInput,
  ): Promise<ExpenseCategoryDto> {
    return this.prisma.withTenant(async (tx) => {
      await this.assertCategoryNameFree(tx, input.name);
      const row = await tx.expenseCategory.create({ data: { tenantId, name: input.name } });
      return {
        key: `${CUSTOM_EXPENSE_CATEGORY_PREFIX}${row.id}`,
        name: row.name,
        builtin: false,
        usage: 0,
      };
    }, tenantId);
  }

  async renameCategory(
    tenantId: string,
    id: string,
    input: CreateExpenseCategoryInput,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const row = await tx.expenseCategory.findFirst({ where: { id } });
      if (!row) throw this.categoryNotFound();
      if (row.name.toLowerCase() !== input.name.toLowerCase()) {
        await this.assertCategoryNameFree(tx, input.name);
      }
      await tx.expenseCategory.update({ where: { id }, data: { name: input.name } });
    }, tenantId);
  }

  /** Al borrarla, sus gastos, plantillas y proveedores pasan a «Otros». */
  async removeCategory(tenantId: string, id: string): Promise<{ moved: number }> {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.expenseCategory.findFirst({ where: { id } });
      if (!row) throw this.categoryNotFound();
      const key = `${CUSTOM_EXPENSE_CATEGORY_PREFIX}${id}`;
      const moved = await tx.expense.updateMany({
        where: { category: key },
        data: { category: 'other' },
      });
      await tx.recurringExpense.updateMany({
        where: { category: key },
        data: { category: 'other' },
      });
      await tx.expenseSupplier.updateMany({
        where: { defaultCategory: key },
        data: { defaultCategory: null },
      });
      await tx.expenseBudget.deleteMany({ where: { category: key } });
      await tx.expenseCategory.delete({ where: { id } });
      return { moved: moved.count };
    }, tenantId);
  }

  private async assertCategoryNameFree(tx: Prisma.TransactionClient, name: string): Promise<void> {
    const builtin = Object.values(EXPENSE_CATEGORY_LABELS).some(
      (label) => label.toLowerCase() === name.toLowerCase(),
    );
    const taken =
      builtin ||
      !!(await tx.expenseCategory.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      }));
    if (taken) {
      throw new ConflictException({
        code: 'category_name_taken',
        message: `Ya hay una categoría «${name}»`,
      });
    }
  }

  private categoryNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'category_not_found',
      message: 'Categoría no encontrada',
    });
  }

  // ---- proveedores ----

  async listSuppliers(
    tenantId: string,
    opts: { search?: string; includeInactive?: boolean } = {},
  ): Promise<ExpenseSupplierDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const search = opts.search?.trim();
      const where: Prisma.ExpenseSupplierWhereInput = {
        ...(opts.includeInactive ? {} : { isActive: true }),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { taxId: { contains: search.replace(/[\s.-]/g, ''), mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const since = new Date();
      since.setUTCFullYear(since.getUTCFullYear() - 1);
      const [rows, counts, recent, custom] = await Promise.all([
        tx.expenseSupplier.findMany({ where, orderBy: { name: 'asc' }, take: 500 }),
        tx.expense.groupBy({
          by: ['supplierId'],
          where: { supplierId: { not: null } },
          _count: { _all: true },
        }),
        tx.expense.groupBy({
          by: ['supplierId'],
          where: { supplierId: { not: null }, expenseDate: { gte: since } },
          _sum: { amount: true },
        }),
        customCategories(tx),
      ]);
      const countOf = new Map(counts.map((c) => [c.supplierId, c._count._all]));
      const sumOf = new Map(recent.map((c) => [c.supplierId, num(c._sum.amount)]));
      return rows.map((r) =>
        this.supplierDto(r, custom, countOf.get(r.id) ?? 0, round2(sumOf.get(r.id) ?? 0)),
      );
    }, tenantId);
  }

  async createSupplier(
    tenantId: string,
    input: CreateExpenseSupplierInput,
  ): Promise<ExpenseSupplierDto> {
    return this.prisma.withTenant(async (tx) => {
      if (input.defaultCategory) await assertCategory(tx, input.defaultCategory);
      const taxId = normalizeTaxId(input.taxId);
      await this.assertTaxIdFree(tx, taxId, null);
      const row = await tx.expenseSupplier.create({
        data: {
          tenantId,
          name: input.name,
          taxId,
          email: input.email?.trim() || null,
          phone: input.phone?.trim() || null,
          defaultCategory: input.defaultCategory ?? null,
          defaultVatRate: input.defaultVatRate ?? null,
          defaultWithholdingRate: input.defaultWithholdingRate ?? null,
          defaultWithholdingModel: input.defaultWithholdingModel ?? null,
          defaultPaymentMethod: input.defaultPaymentMethod ?? null,
          notes: input.notes?.trim() || null,
          isActive: input.isActive ?? true,
        },
      });
      return this.supplierDto(row, await customCategories(tx), 0, 0);
    }, tenantId);
  }

  async updateSupplier(
    tenantId: string,
    id: string,
    input: UpdateExpenseSupplierInput,
  ): Promise<ExpenseSupplierDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await tx.expenseSupplier.findFirst({ where: { id } });
      if (!existing) throw this.supplierNotFound();
      if (input.defaultCategory) await assertCategory(tx, input.defaultCategory);
      const data: Prisma.ExpenseSupplierUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.taxId !== undefined) {
        const taxId = normalizeTaxId(input.taxId);
        await this.assertTaxIdFree(tx, taxId, id);
        data.taxId = taxId;
      }
      if (input.email !== undefined) data.email = input.email?.trim() || null;
      if (input.phone !== undefined) data.phone = input.phone?.trim() || null;
      if (input.defaultCategory !== undefined) data.defaultCategory = input.defaultCategory ?? null;
      if (input.defaultVatRate !== undefined) data.defaultVatRate = input.defaultVatRate ?? null;
      if (input.defaultWithholdingRate !== undefined)
        data.defaultWithholdingRate = input.defaultWithholdingRate ?? null;
      if (input.defaultWithholdingModel !== undefined)
        data.defaultWithholdingModel = input.defaultWithholdingModel ?? null;
      if (input.defaultPaymentMethod !== undefined)
        data.defaultPaymentMethod = input.defaultPaymentMethod ?? null;
      if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
      if (input.isActive !== undefined) data.isActive = input.isActive;
      const row = await tx.expenseSupplier.update({ where: { id }, data });
      const [count, recent] = await Promise.all([
        tx.expense.count({ where: { supplierId: id } }),
        this.lastYearAmount(tx, id),
      ]);
      return this.supplierDto(row, await customCategories(tx), count, recent);
    }, tenantId);
  }

  /** Sus gastos conservan el nombre y el NIF (se guardan en cada gasto). */
  async removeSupplier(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const existing = await tx.expenseSupplier.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw this.supplierNotFound();
      await tx.expenseSupplier.delete({ where: { id } });
    }, tenantId);
  }

  /** El proveedor con ese NIF, si existe. */
  async findSupplierByTaxId(
    tx: Prisma.TransactionClient,
    taxId: string | null,
  ): Promise<{ id: string } | null> {
    const normalized = normalizeTaxId(taxId);
    if (!normalized) return null;
    return tx.expenseSupplier.findFirst({
      where: { taxId: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
  }

  private async lastYearAmount(tx: Prisma.TransactionClient, supplierId: string): Promise<number> {
    const since = new Date();
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    const agg = await tx.expense.aggregate({
      where: { supplierId, expenseDate: { gte: since } },
      _sum: { amount: true },
    });
    return round2(num(agg._sum.amount));
  }

  private async assertTaxIdFree(
    tx: Prisma.TransactionClient,
    taxId: string | null,
    exceptId: string | null,
  ): Promise<void> {
    if (!taxId) return;
    const other = await tx.expenseSupplier.findFirst({
      where: {
        taxId: { equals: taxId, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { name: true },
    });
    if (other) {
      throw new ConflictException({
        code: 'supplier_tax_id_taken',
        message: `Ya tienes un proveedor con el NIF ${taxId}: ${other.name}`,
      });
    }
  }

  private supplierNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'supplier_not_found',
      message: 'Proveedor no encontrado',
    });
  }

  private supplierDto(
    r: SupplierRow,
    custom: { id: string; name: string }[],
    expenseCount: number,
    last12Months: number,
  ): ExpenseSupplierDto {
    return {
      id: r.id,
      name: r.name,
      taxId: r.taxId,
      email: r.email,
      phone: r.phone,
      defaultCategory: r.defaultCategory,
      defaultCategoryLabel: r.defaultCategory
        ? expenseCategoryLabel(r.defaultCategory, custom)
        : null,
      defaultVatRate: numOrNull(r.defaultVatRate),
      defaultWithholdingRate: numOrNull(r.defaultWithholdingRate),
      defaultWithholdingModel: r.defaultWithholdingModel as ExpenseWithholdingModel | null,
      defaultPaymentMethod: r.defaultPaymentMethod as ExpensePaymentMethod | null,
      notes: r.notes,
      isActive: r.isActive,
      expenseCount,
      last12Months,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
