import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EXPENSE_RECEIPT_MAX_BYTES,
  EXPENSE_RECEIPT_MIME_TYPES,
  ExpenseCategoryEnum,
  ExpensePaymentMethodEnum,
  ExpensePaymentStatusEnum,
  expenseCategoryLabel,
  type BulkExpenseActionInput,
  type BulkExpenseResultDto,
  type CreateExpenseInput,
  type ExpenseDto,
  type ExpensePaymentMethod,
  type ExpensePaymentStatus,
  type ExpenseReceiptReadDto,
  type ExpenseReceiptUploadDto,
  type ExpenseTotalDto,
  type ExpenseWithholdingModel,
  type MarkExpensePaidInput,
  type UpdateExpenseInput,
} from '@storageos/shared';

import { optionalFacilityWhere, type FacilityScope } from '../../common/facility-scope';
import { assertFiscalPeriodOpen } from '../../common/fiscal-closure';
import { todayInTimezone } from '../../common/format';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { AiService } from '../ai/ai.service';
import { EXPENSE_RECEIPT_MARKER } from '../ai/stub-ai-provider';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { ExpenseCatalogService } from './expense-catalog.service';
import {
  assertCategory,
  assertDay,
  assertTargetAllowed,
  assertUuidParam,
  breakdownColumns,
  customCategories,
  dayDate,
  dayString,
  normalizeTaxId,
  num,
  numOrNull,
  round2,
  sourceOf,
} from './expense-helpers';

import type { Prisma } from '@storageos/database';

const RECEIPT_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
};
/** Anthropic no admite imágenes de más de 5 MB. */
const AI_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const EXPENSE_INCLUDE = {
  facility: { select: { name: true } },
  marketingChannel: { select: { name: true } },
  supplier: { select: { name: true } },
} satisfies Prisma.ExpenseInclude;

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof EXPENSE_INCLUDE }>;

export interface ExpenseFilters {
  facilityId?: string;
  category?: string;
  from?: string;
  to?: string;
  facilityScope?: string[] | null;
  /** Descripción, proveedor, NIF, número de factura o nota. */
  search?: string;
  /** paid | pending | overdue */
  paymentStatus?: string;
  supplierId?: string;
}

type PaymentState = {
  facilityId: string | null;
  description: string;
  paymentStatus: string;
  paymentMethod: string | null;
  paidAt: Date | null;
  amountToPay: number;
  cashMovementId: string | null;
};

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly ai: AiService,
    private readonly catalog: ExpenseCatalogService,
  ) {}

  // ---------------------------------------------------------------------
  // Lista y totales
  // ---------------------------------------------------------------------

  async list(
    tenantId: string,
    filters: ExpenseFilters & { page?: PageRequest; take?: number },
  ): Promise<ExpenseDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const today = await this.today(tx);
      const where = this.filterWhere(filters, today);
      if (!where) return [];
      const [rows, custom] = await Promise.all([
        tx.expense.findMany({
          where,
          include: EXPENSE_INCLUDE,
          orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          ...(filters.page ? pageArgs(filters.page) : { take: filters.take ?? 500 }),
        }),
        customCategories(tx),
      ]);
      return rows.map((r) => this.toDto(r, custom, today));
    }, tenantId);
  }

  /** Filtro común de la lista y su total (valida fechas, local y categoría). `null` = nada. */
  private filterWhere(filters: ExpenseFilters, today: string): Prisma.ExpenseWhereInput | null {
    assertDay(filters.from, 'desde');
    assertDay(filters.to, 'hasta');
    assertUuidParam(filters.facilityId, 'invalid_facility_id', 'Local');
    assertUuidParam(filters.supplierId, 'invalid_supplier_id', 'Proveedor');
    if (
      filters.category &&
      !ExpenseCategoryEnum.safeParse(filters.category).success &&
      !/^custom:[0-9a-f-]{36}$/i.test(filters.category)
    ) {
      throw new BadRequestException({ code: 'invalid_category', message: 'Categoría no válida' });
    }
    if (
      filters.paymentStatus &&
      filters.paymentStatus !== 'overdue' &&
      !ExpensePaymentStatusEnum.safeParse(filters.paymentStatus).success
    ) {
      throw new BadRequestException({
        code: 'invalid_status',
        message: 'Estado de pago no válido',
      });
    }
    const facility = optionalFacilityWhere(filters.facilityScope, filters.facilityId);
    if (!facility) return null;
    const where: Prisma.ExpenseWhereInput = { ...facility };
    const and: Prisma.ExpenseWhereInput[] = [];
    const search = filters.search?.trim();
    if (search) {
      const q = { contains: search, mode: 'insensitive' as const };
      and.push({
        OR: [
          { description: q },
          { vendor: q },
          { notes: q },
          { invoiceNumber: q },
          { vendorTaxId: { contains: search.replace(/[\s.-]/g, ''), mode: 'insensitive' } },
        ],
      });
    }
    if (filters.category) where.category = filters.category;
    if (filters.supplierId) where.supplierId = filters.supplierId;
    if (filters.paymentStatus === 'overdue') {
      where.paymentStatus = 'pending';
      where.dueDate = { lt: dayDate(today) };
    } else if (filters.paymentStatus) {
      where.paymentStatus = filters.paymentStatus;
    }
    if (filters.from || filters.to) {
      where.expenseDate = {};
      if (filters.from) where.expenseDate.gte = dayDate(filters.from);
      if (filters.to) where.expenseDate.lte = dayDate(filters.to);
    }
    if (and.length) where.AND = and;
    return where;
  }

  /** Total de lo filtrado (la lista va por páginas). */
  async total(tenantId: string, filters: ExpenseFilters): Promise<ExpenseTotalDto> {
    return this.prisma.withTenant(async (tx) => {
      const today = await this.today(tx);
      const where = this.filterWhere(filters, today);
      if (!where) return { count: 0, amount: 0, pending: 0 };
      const [agg, pendingRows] = await Promise.all([
        tx.expense.aggregate({ where, _count: { _all: true }, _sum: { amount: true } }),
        tx.expense.findMany({
          where: { AND: [where, { paymentStatus: 'pending' }] },
          select: { amount: true, totalAmount: true },
        }),
      ]);
      const pending = pendingRows.reduce((sum, r) => sum + num(r.totalAmount ?? r.amount), 0);
      return {
        count: agg._count._all,
        amount: round2(num(agg._sum.amount)),
        pending: round2(pending),
      };
    }, tenantId);
  }

  // ---------------------------------------------------------------------
  // Alta, edición y borrado
  // ---------------------------------------------------------------------

  /**
   * El local, el canal de marketing y el proveedor tienen que ser de esta
   * empresa (la clave ajena no lo comprueba). El canal solo vale con Marketing.
   */
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
      const facility = await tx.facility.findFirst({
        where: { id: refs.facilityId, deletedAt: null },
        select: { id: true },
      });
      if (!facility) {
        throw new BadRequestException({
          code: 'facility_not_found',
          message: 'Local no encontrado',
        });
      }
    }
    if (refs.category !== undefined) await assertCategory(tx, refs.category);
    if (refs.marketingChannelId && refs.category === 'marketing') {
      const channel = await tx.marketingChannel.findFirst({
        where: { id: refs.marketingChannelId },
        select: { id: true },
      });
      if (!channel) {
        throw new BadRequestException({
          code: 'marketing_channel_not_found',
          message: 'Canal de marketing no encontrado',
        });
      }
    }
    if (refs.supplierId) {
      const supplier = await tx.expenseSupplier.findFirst({
        where: { id: refs.supplierId },
        select: { id: true },
      });
      if (!supplier) {
        throw new BadRequestException({
          code: 'supplier_not_found',
          message: 'Proveedor no encontrado',
        });
      }
    }
  }

  /** El justificante subido para esta empresa, con un tipo y un tamaño válidos. */
  private async assertReceipt(tenantId: string, key: string): Promise<void> {
    if (!key.startsWith(`${tenantId}/expenses/`)) {
      throw new BadRequestException({
        code: 'invalid_receipt_key',
        message: 'Justificante no válido',
      });
    }
    await this.files.assertObjectMimeType(
      'uploads',
      key,
      EXPENSE_RECEIPT_MIME_TYPES,
      EXPENSE_RECEIPT_MAX_BYTES,
      { mustExist: true },
    );
  }

  async create(
    tenantId: string,
    userId: string | null,
    input: CreateExpenseInput,
    scope: FacilityScope = null,
    opts: { skipCash?: boolean } = {},
  ): Promise<ExpenseDto> {
    const facilityId = input.facilityId ?? null;
    assertTargetAllowed(scope, facilityId);
    assertDay(input.expenseDate, 'fecha');
    assertDay(input.paidAt, 'pagado el');
    assertDay(input.dueDate, 'vence el');
    if (input.receiptKey) await this.assertReceipt(tenantId, input.receiptKey);
    const amounts = breakdownColumns(input);
    // El canal solo cuenta como coste de marketing.
    const channelId = input.category === 'marketing' ? (input.marketingChannelId ?? null) : null;
    const status: ExpensePaymentStatus = input.paymentStatus ?? 'paid';
    const paidAt = status === 'paid' ? (input.paidAt ?? input.expenseDate) : null;
    return this.prisma.withTenant(async (tx) => {
      await assertFiscalPeriodOpen(tx, [dayDate(input.expenseDate)], 'sus gastos');
      await this.assertRefs(tx, {
        facilityId,
        category: input.category,
        marketingChannelId: channelId,
        supplierId: input.supplierId ?? null,
      });
      const supplier = input.supplierId
        ? await tx.expenseSupplier.findFirst({ where: { id: input.supplierId } })
        : null;
      const row = await tx.expense.create({
        data: {
          tenantId,
          facilityId,
          category: input.category,
          description: input.description,
          expenseDate: dayDate(input.expenseDate),
          vendor: input.vendor?.trim() || supplier?.name || null,
          vendorTaxId: normalizeTaxId(input.vendorTaxId) ?? supplier?.taxId ?? null,
          invoiceNumber: input.invoiceNumber?.trim() || null,
          supplierId: supplier?.id ?? null,
          notes: input.notes?.trim() || null,
          createdByUserId: userId,
          marketingChannelId: channelId,
          ...amounts,
          receiptKey: input.receiptKey ?? null,
          receiptName: input.receiptKey ? (input.receiptName ?? 'Justificante') : null,
          receiptMime: input.receiptKey ? (input.receiptMime ?? null) : null,
          paymentStatus: status,
          paidAt: paidAt ? dayDate(paidAt) : null,
          paymentMethod: input.paymentMethod ?? null,
          dueDate: input.dueDate ? dayDate(input.dueDate) : null,
        },
        include: EXPENSE_INCLUDE,
      });
      // Al importar gastos de días pasados no se toca la caja.
      const cash = opts.skipCash
        ? { changed: false, notice: null }
        : await this.syncCash(tx, tenantId, userId, row.id, null, this.paymentState(row));
      const final = cash.changed
        ? await tx.expense.findUniqueOrThrow({ where: { id: row.id }, include: EXPENSE_INCLUDE })
        : row;
      return {
        ...this.toDto(final, await customCategories(tx), await this.today(tx)),
        cashNotice: cash.notice,
      };
    }, tenantId);
  }

  async get(tenantId: string, id: string, scope: FacilityScope): Promise<ExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.expense.findFirst({ where: { id }, include: EXPENSE_INCLUDE });
      if (!row || (row.facilityId && scope && !scope.includes(row.facilityId))) {
        throw new NotFoundException({ code: 'expense_not_found', message: 'Gasto no encontrado' });
      }
      return this.toDto(row, await customCategories(tx), await this.today(tx));
    }, tenantId);
  }

  /** Gasto de la empresa, visible para quien lo pide y que se puede tocar a mano. */
  private async editable(
    tx: Prisma.TransactionClient,
    id: string,
    scope: FacilityScope,
  ): Promise<ExpenseRow> {
    const existing = await tx.expense.findFirst({ where: { id }, include: EXPENSE_INCLUDE });
    if (!existing) {
      throw new NotFoundException({ code: 'expense_not_found', message: 'Gasto no encontrado' });
    }
    if (existing.facilityId && scope && !scope.includes(existing.facilityId)) {
      throw new NotFoundException({ code: 'expense_not_found', message: 'Gasto no encontrado' });
    }
    assertTargetAllowed(scope, existing.facilityId);
    if (existing.externalRef) {
      const platform = existing.externalRef.startsWith('meta_ads:') ? 'Meta Ads' : 'Google Ads';
      throw new ConflictException({
        code: 'expense_synced',
        message: `Este gasto llega de ${platform} y se actualiza solo con la sincronización. Para dejar de importarlo, quita la campaña del canal de marketing.`,
      });
    }
    return existing;
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateExpenseInput,
    scope: FacilityScope = null,
    userId: string | null = null,
  ): Promise<ExpenseDto> {
    assertDay(input.expenseDate, 'fecha');
    assertDay(input.paidAt, 'pagado el');
    assertDay(input.dueDate, 'vence el');
    if (input.receiptKey) await this.assertReceipt(tenantId, input.receiptKey);
    let oldReceipt: string | null = null;
    const dto = await this.prisma.withTenant(async (tx) => {
      const existing = await this.editable(tx, id, scope);
      // Lo que cambia las cifras declaradas no se toca en un trimestre cerrado
      // (sí el pago, las notas o la categoría).
      const fiscalChange =
        input.expenseDate !== undefined ||
        input.amount !== undefined ||
        input.baseAmount !== undefined ||
        input.vatRate !== undefined ||
        input.vatDeductible !== undefined ||
        input.withholdingRate !== undefined ||
        input.withholdingModel !== undefined ||
        input.vendorTaxId !== undefined ||
        input.invoiceNumber !== undefined ||
        input.facilityId !== undefined;
      if (fiscalChange) {
        await assertFiscalPeriodOpen(
          tx,
          [existing.expenseDate, input.expenseDate ? dayDate(input.expenseDate) : null],
          'este gasto',
        );
      }
      const facilityId =
        input.facilityId !== undefined ? (input.facilityId ?? null) : existing.facilityId;
      if (input.facilityId !== undefined) assertTargetAllowed(scope, facilityId);
      const category = input.category ?? existing.category;
      // Fuera de Marketing el canal se quita (antes seguía sumando como coste del canal).
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

      const data: Prisma.ExpenseUpdateInput = {};
      if (input.facilityId !== undefined) {
        data.facility = facilityId ? { connect: { id: facilityId } } : { disconnect: true };
      }
      if (input.category !== undefined) data.category = input.category;
      if (input.description !== undefined) data.description = input.description;
      if (input.expenseDate !== undefined) data.expenseDate = dayDate(input.expenseDate);
      if (input.vendor !== undefined) data.vendor = input.vendor?.trim() || null;
      if (input.vendorTaxId !== undefined) data.vendorTaxId = normalizeTaxId(input.vendorTaxId);
      if (input.invoiceNumber !== undefined)
        data.invoiceNumber = input.invoiceNumber?.trim() || null;
      if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
      if (input.supplierId !== undefined) {
        data.supplier = input.supplierId
          ? { connect: { id: input.supplierId } }
          : { disconnect: true };
      }
      if (channelId !== existing.marketingChannelId) {
        data.marketingChannel = channelId ? { connect: { id: channelId } } : { disconnect: true };
      }

      // Importe: si cambia algo del desglose, se recalcula todo.
      const touchesAmount =
        input.amount !== undefined ||
        input.baseAmount !== undefined ||
        input.vatRate !== undefined ||
        input.vatDeductible !== undefined ||
        input.withholdingRate !== undefined ||
        input.withholdingModel !== undefined;
      if (touchesAmount) {
        const baseAmount =
          input.baseAmount !== undefined ? input.baseAmount : numOrNull(existing.baseAmount);
        Object.assign(
          data,
          breakdownColumns({
            amount: input.amount ?? num(existing.amount),
            baseAmount,
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
          }),
        );
      }

      if (input.receiptKey !== undefined) {
        if (existing.receiptKey && existing.receiptKey !== input.receiptKey) {
          oldReceipt = existing.receiptKey;
        }
        data.receiptKey = input.receiptKey ?? null;
        data.receiptName = input.receiptKey ? (input.receiptName ?? 'Justificante') : null;
        data.receiptMime = input.receiptKey ? (input.receiptMime ?? null) : null;
      }

      // Pago.
      const status = input.paymentStatus ?? (existing.paymentStatus as ExpensePaymentStatus);
      if (input.paymentStatus !== undefined) data.paymentStatus = status;
      if (status === 'pending') {
        data.paidAt = null;
      } else if (input.paidAt !== undefined || input.paymentStatus === 'paid') {
        data.paidAt = dayDate(
          input.paidAt ?? dayString(existing.paidAt) ?? dayString(existing.expenseDate)!,
        );
      }
      if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod ?? null;
      if (input.dueDate !== undefined) data.dueDate = input.dueDate ? dayDate(input.dueDate) : null;

      const row = await tx.expense.update({ where: { id }, data, include: EXPENSE_INCLUDE });
      const cash = await this.syncCash(
        tx,
        tenantId,
        userId,
        id,
        this.paymentState(existing),
        this.paymentState(row),
      );
      const final = cash.changed
        ? await tx.expense.findUniqueOrThrow({ where: { id }, include: EXPENSE_INCLUDE })
        : row;
      return {
        ...this.toDto(final, await customCategories(tx), await this.today(tx)),
        cashNotice: cash.notice,
      };
    }, tenantId);
    if (oldReceipt) await this.files.deleteObjects('uploads', [oldReceipt]).catch(() => undefined);
    return dto;
  }

  async markPaid(
    tenantId: string,
    userId: string | null,
    id: string,
    input: MarkExpensePaidInput,
    scope: FacilityScope = null,
  ): Promise<ExpenseDto> {
    return this.update(
      tenantId,
      id,
      { paymentStatus: 'paid', paidAt: input.paidAt, paymentMethod: input.paymentMethod },
      scope,
      userId,
    );
  }

  async markPending(
    tenantId: string,
    userId: string | null,
    id: string,
    scope: FacilityScope = null,
  ): Promise<ExpenseDto> {
    return this.update(tenantId, id, { paymentStatus: 'pending' }, scope, userId);
  }

  async remove(tenantId: string, id: string, scope: FacilityScope = null): Promise<void> {
    const receipt = await this.prisma.withTenant(async (tx) => {
      const existing = await this.editable(tx, id, scope);
      await assertFiscalPeriodOpen(tx, [existing.expenseDate], 'este gasto');
      if (existing.cashMovementId) {
        await this.removeCashMovement(tx, tenantId, existing.cashMovementId);
      }
      await tx.expense.delete({ where: { id } });
      return existing.receiptKey;
    }, tenantId);
    if (receipt) await this.files.deleteObjects('uploads', [receipt]).catch(() => undefined);
  }

  // ---------------------------------------------------------------------
  // Pago en efectivo → salida de caja
  // ---------------------------------------------------------------------

  private paymentState(r: ExpenseRow): PaymentState {
    return {
      facilityId: r.facilityId,
      description: r.description,
      paymentStatus: r.paymentStatus,
      paymentMethod: r.paymentMethod,
      paidAt: r.paidAt,
      amountToPay: num(r.totalAmount ?? r.amount),
      cashMovementId: r.cashMovementId,
    };
  }

  /** ¿Está cerrada la caja de ese día? (la del local o la global, que cubre todo). */
  private async cashDayClosed(
    tx: Prisma.TransactionClient,
    tenantId: string,
    day: Date,
    facilityId: string | null,
  ): Promise<boolean> {
    const closed = await tx.cashClosure.findFirst({
      where: {
        tenantId,
        closureDate: day,
        reopenedAt: null,
        OR: [{ facilityId: null }, ...(facilityId ? [{ facilityId }] : [])],
      },
      select: { id: true },
    });
    return !!closed;
  }

  private async removeCashMovement(
    tx: Prisma.TransactionClient,
    tenantId: string,
    movementId: string,
  ): Promise<void> {
    const movement = await tx.cashMovement.findFirst({ where: { id: movementId } });
    if (!movement) return;
    if (await this.cashDayClosed(tx, tenantId, movement.movementDate, movement.facilityId)) {
      const day = movement.movementDate.toISOString().slice(0, 10).split('-').reverse().join('/');
      throw new ConflictException({
        code: 'cash_day_closed',
        message: `El pago en efectivo de este gasto salió de la caja del ${day}, que ya está cerrada. Reabre ese cierre para cambiarlo.`,
      });
    }
    await tx.cashMovement.delete({ where: { id: movementId } });
  }

  /**
   * Pagado en efectivo = una salida en la caja del día del pago (del local del
   * gasto, o la global si es general). Si cambia el día, el local, el importe
   * o deja de ser efectivo, la salida se quita o se rehace. Con la caja de ese
   * día cerrada no se apunta y se avisa.
   */
  private async syncCash(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string | null,
    expenseId: string,
    before: PaymentState | null,
    after: PaymentState,
  ): Promise<{ changed: boolean; notice: string | null }> {
    const wantsCash =
      after.paymentStatus === 'paid' && after.paymentMethod === 'cash' && !!after.paidAt;
    let movementId = before?.cashMovementId ?? after.cashMovementId;
    let changed = false;
    if (movementId) {
      const movement = await tx.cashMovement.findFirst({ where: { id: movementId } });
      const same =
        wantsCash &&
        movement &&
        movement.facilityId === after.facilityId &&
        movement.movementDate.getTime() === after.paidAt!.getTime() &&
        Math.round(num(movement.amount) * 100) === Math.round(after.amountToPay * 100);
      if (same) return { changed: false, notice: null };
      if (movement) await this.removeCashMovement(tx, tenantId, movementId);
      await tx.expense.update({ where: { id: expenseId }, data: { cashMovementId: null } });
      movementId = null;
      changed = true;
    }
    if (!wantsCash) return { changed, notice: null };
    if (await this.cashDayClosed(tx, tenantId, after.paidAt!, after.facilityId)) {
      return {
        changed,
        notice:
          'La caja de ese día ya está cerrada: no se ha apuntado la salida de efectivo. Si hace falta, reabre el cierre y vuelve a guardar el gasto.',
      };
    }
    const movement = await tx.cashMovement.create({
      data: {
        tenantId,
        facilityId: after.facilityId,
        movementDate: after.paidAt!,
        kind: 'expense_payment',
        amount: Math.round(after.amountToPay * 100) / 100,
        notes: after.description.slice(0, 300),
        createdByUserId: userId,
      },
    });
    await tx.expense.update({ where: { id: expenseId }, data: { cashMovementId: movement.id } });
    return { changed: true, notice: null };
  }

  // ---------------------------------------------------------------------
  // Justificante
  // ---------------------------------------------------------------------

  async receiptUploadUrl(
    tenantId: string,
    mimeType: (typeof EXPENSE_RECEIPT_MIME_TYPES)[number],
  ): Promise<ExpenseReceiptUploadDto> {
    const key = `${tenantId}/expenses/${randomUUID()}.${RECEIPT_EXT[mimeType]}`;
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, expiresIn };
  }

  async receiptUrl(tenantId: string, id: string, scope: FacilityScope): Promise<{ url: string }> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.expense.findFirst({
          where: { id },
          select: { facilityId: true, receiptKey: true, receiptName: true },
        }),
      tenantId,
    );
    if (!row || (row.facilityId && scope && !scope.includes(row.facilityId))) {
      throw new NotFoundException({ code: 'expense_not_found', message: 'Gasto no encontrado' });
    }
    if (!row.receiptKey) {
      throw new NotFoundException({ code: 'receipt_not_found', message: 'Sin justificante' });
    }
    return {
      url: await this.files.getPresignedGetUrl(
        'uploads',
        row.receiptKey,
        300,
        row.receiptName ?? 'justificante',
      ),
    };
  }

  /**
   * La IA lee el justificante y propone los datos del gasto (proveedor, NIF,
   * número, fecha, base, IVA, retención y total). Gasta una consulta del mes y
   * solo con el asistente IA en el plan. No guarda nada: se revisa antes.
   */
  async readReceipt(
    tenantId: string,
    userId: string | null,
    key: string,
  ): Promise<ExpenseReceiptReadDto> {
    if (!(await this.ai.isAiEnabled(tenantId))) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'Leer facturas con IA necesita el asistente IA en tu plan',
        details: { requiredFeature: 'ai_assistant' },
      });
    }
    await this.assertReceipt(tenantId, key);
    const ext = key.split('.').pop() ?? '';
    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) {
      throw new BadRequestException({
        code: 'invalid_receipt_key',
        message: 'Justificante no válido',
      });
    }
    const bytes = await this.files.getObject({ bucket: 'uploads', key });
    if (mimeType !== 'application/pdf' && bytes.length > AI_IMAGE_MAX_BYTES) {
      throw new BadRequestException({
        code: 'receipt_too_large_for_ai',
        message: 'La foto es demasiado grande para leerla (máx. 5 MB). Hazla con menos resolución.',
      });
    }
    const custom = await this.prisma.withTenant((tx) => customCategories(tx), tenantId);
    const categories = [
      ...ExpenseCategoryEnum.options.map((k) => `${k} (${expenseCategoryLabel(k)})`),
      ...custom.map((c) => `custom:${c.id} (${c.name})`),
    ].join(', ');
    const system = [
      `${EXPENSE_RECEIPT_MARKER} españoles para registrar el gasto de un negocio de trasteros.`,
      'Lee la factura o el ticket y devuelve SOLO un objeto JSON, sin texto alrededor, con estas claves:',
      'vendor (razón social del proveedor), vendorTaxId (su NIF o CIF, sin espacios), invoiceNumber,',
      'expenseDate (fecha de la factura, AAAA-MM-DD), description (concepto breve, máx. 80 caracteres),',
      `category (una de estas claves: ${categories}), baseAmount (base imponible),`,
      'vatRate (tipo de IVA en %, p. ej. 21), withholdingRate (retención de IRPF en %, 0 si no hay)',
      'y totalAmount (total a pagar). Importes con punto decimal. Si un dato no aparece, null.',
      'Si la factura tiene varios tipos de IVA, usa la suma de las bases y el tipo principal.',
    ].join(' ');
    const text = await this.ai.completeWithFile({
      tenantId,
      userId,
      feature: 'expense_receipt',
      system,
      user: 'Lee este justificante.',
      file: { mimeType, base64: bytes.toString('base64') },
    });
    const parsed = this.parseReceiptJson(text, custom);
    const supplier = await this.prisma.withTenant(
      (tx) => this.catalog.findSupplierByTaxId(tx, parsed.vendorTaxId),
      tenantId,
    );
    return { ...parsed, supplierId: supplier?.id ?? null };
  }

  private parseReceiptJson(
    text: string,
    custom: { id: string; name: string }[],
  ): Omit<ExpenseReceiptReadDto, 'supplierId'> {
    const empty = {
      vendor: null,
      vendorTaxId: null,
      invoiceNumber: null,
      expenseDate: null,
      description: null,
      category: null,
      baseAmount: null,
      vatRate: null,
      withholdingRate: null,
      totalAmount: null,
    };
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return empty;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return empty;
    }
    const str = (v: unknown, max: number): string | null =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
    const amount = (v: unknown, max = 99_999_999.99): number | null => {
      const n =
        typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
      return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
    };
    const date = str(raw.expenseDate, 10);
    const category = str(raw.category, 60);
    const validCategory =
      category &&
      (ExpenseCategoryEnum.safeParse(category).success ||
        custom.some((c) => `custom:${c.id}` === category))
        ? category
        : null;
    return {
      vendor: str(raw.vendor, 200),
      vendorTaxId: normalizeTaxId(str(raw.vendorTaxId, 30)),
      invoiceNumber: str(raw.invoiceNumber, 60),
      expenseDate:
        date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : null,
      description: str(raw.description, 300),
      category: validCategory,
      baseAmount: amount(raw.baseAmount),
      vatRate: amount(raw.vatRate, 100),
      withholdingRate: amount(raw.withholdingRate, 100),
      totalAmount: amount(raw.totalAmount),
    };
  }

  // ---------------------------------------------------------------------
  // Cambios en lote
  // ---------------------------------------------------------------------

  async bulk(
    tenantId: string,
    userId: string | null,
    input: BulkExpenseActionInput,
    scope: FacilityScope,
  ): Promise<BulkExpenseResultDto> {
    let succeeded = 0;
    const failed: { id: string; error: string }[] = [];
    for (const id of [...new Set(input.ids)]) {
      try {
        if (input.action === 'delete') await this.remove(tenantId, id, scope);
        else if (input.action === 'mark_paid')
          await this.markPaid(
            tenantId,
            userId,
            id,
            { paidAt: input.paidAt, paymentMethod: input.paymentMethod },
            scope,
          );
        else if (input.action === 'category')
          await this.update(tenantId, id, { category: input.category }, scope, userId);
        else await this.update(tenantId, id, { facilityId: input.facilityId }, scope, userId);
        succeeded += 1;
      } catch (err) {
        const body = (err as { getResponse?: () => unknown }).getResponse?.() as
          | { message?: string }
          | undefined;
        failed.push({ id, error: body?.message ?? 'No se ha podido cambiar' });
      }
    }
    return { succeeded, failed };
  }

  // ---------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------

  private async today(tx: Prisma.TransactionClient): Promise<string> {
    const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
    return todayInTimezone(tenant?.timezone ?? 'Europe/Madrid')
      .toISOString()
      .slice(0, 10);
  }

  private toDto(r: ExpenseRow, custom: { id: string; name: string }[], today: string): ExpenseDto {
    const paymentStatus = r.paymentStatus as ExpensePaymentStatus;
    const dueDate = dayString(r.dueDate);
    const method = ExpensePaymentMethodEnum.safeParse(r.paymentMethod);
    return {
      id: r.id,
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      category: r.category,
      categoryLabel: expenseCategoryLabel(r.category, custom),
      description: r.description,
      amount: num(r.amount),
      expenseDate: dayString(r.expenseDate)!,
      vendor: r.vendor,
      notes: r.notes,
      marketingChannelId: r.marketingChannelId,
      marketingChannelName: r.marketingChannel?.name ?? null,
      source: sourceOf(r),
      recurringExpenseId: r.recurringExpenseId,
      supplierId: r.supplierId,
      supplierName: r.supplier?.name ?? null,
      vendorTaxId: r.vendorTaxId,
      invoiceNumber: r.invoiceNumber,
      broken: r.baseAmount !== null,
      baseAmount: numOrNull(r.baseAmount),
      vatRate: numOrNull(r.vatRate),
      vatAmount: numOrNull(r.vatAmount),
      vatDeductible: r.vatDeductible,
      withholdingRate: numOrNull(r.withholdingRate),
      withholdingAmount: numOrNull(r.withholdingAmount),
      withholdingModel: r.withholdingModel as ExpenseWithholdingModel | null,
      totalAmount: num(r.totalAmount ?? r.amount),
      hasReceipt: !!r.receiptKey,
      receiptName: r.receiptName,
      paymentStatus,
      paidAt: dayString(r.paidAt),
      paymentMethod: method.success ? (method.data as ExpensePaymentMethod) : null,
      dueDate,
      overdue: paymentStatus === 'pending' && !!dueDate && dueDate < today,
      cashMovementId: r.cashMovementId,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
