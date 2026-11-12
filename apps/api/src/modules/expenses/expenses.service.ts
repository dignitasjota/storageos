import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseCategoryEnum } from '@storageos/shared';

import {
  assertFacilityAllowed,
  optionalFacilityWhere,
  type FacilityScope,
} from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../common/format';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { resolveAnalyticsScope } from '../analytics/analytics-scope';
import {
  INVOICED_SELECT,
  collectedWhere,
  invoicedBase,
  invoicedWhere,
} from '../analytics/business-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  CreateExpenseInput,
  CreateRecurringExpenseInput,
  ExpenseCategory,
  ExpenseDto,
  ExpenseSource,
  ProfitLossDto,
  ProfitLossRowDto,
  RecurringExpenseDto,
  UpdateExpenseInput,
  UpdateRecurringExpenseInput,
} from '@storageos/shared';

const num = (d: Prisma.Decimal | number): number => Number(d);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Nota de los gastos generados por una plantilla antes de enlazarlos con ella. */
const AUTO_RECURRING_NOTE = 'Generado automáticamente (gasto recurrente)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un día `YYYY-MM-DD` que existe; si no, 400 (antes, un 500). */
function assertDay(value: string | undefined, label: string): void {
  if (value === undefined) return;
  const ok =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) {
    throw new BadRequestException({
      code: 'invalid_date',
      message: `La fecha «${label}» no es válida (AAAA-MM-DD)`,
    });
  }
}

function assertFacilityParam(value: string | undefined): void {
  if (value !== undefined && !UUID_RE.test(value)) {
    throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
  }
}

function sourceOf(r: {
  externalRef: string | null;
  recurringExpenseId: string | null;
  notes: string | null;
}): ExpenseSource {
  if (r.externalRef?.startsWith('google_ads:')) return 'google_ads';
  if (r.externalRef?.startsWith('meta_ads:')) return 'meta_ads';
  if (r.recurringExpenseId || r.notes === AUTO_RECURRING_NOTE) return 'recurring';
  return 'manual';
}

/**
 * Quien solo ve unos locales gestiona los gastos de esos locales; los de toda
 * la empresa (sin local) los gestiona quien ve todos.
 */
function assertTargetAllowed(scope: FacilityScope, facilityId: string | null): void {
  if (facilityId) {
    assertFacilityAllowed(scope, facilityId);
    return;
  }
  if (scope) {
    throw new ForbiddenException({
      code: 'facility_required',
      message:
        'Elige uno de tus locales: los gastos de toda la empresa los gestiona quien ve todos los locales',
    });
  }
}

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
  marketingChannelId: string | null;
  marketingChannel: { name: string } | null;
  externalRef: string | null;
  recurringExpenseId: string | null;
};

const EXPENSE_INCLUDE = {
  facility: { select: { name: true } },
  marketingChannel: { select: { name: true } },
} satisfies Prisma.ExpenseInclude;

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
  marketingChannelId: string | null;
  marketingChannel: { name: string } | null;
};

const RECURRING_INCLUDE = {
  facility: { select: { name: true } },
  marketingChannel: { select: { name: true } },
} satisfies Prisma.RecurringExpenseInclude;

@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  async list(
    tenantId: string,
    filters: {
      facilityId?: string;
      category?: string;
      from?: string;
      to?: string;
      facilityScope?: string[] | null;
      /** Descripción o proveedor. */
      search?: string;
      page?: PageRequest;
    },
  ): Promise<ExpenseDto[]> {
    const where = this.filterWhere(filters);
    if (!where) return [];
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.expense.findMany({
        where,
        include: EXPENSE_INCLUDE,
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        ...(filters.page ? pageArgs(filters.page) : { take: 500 }),
      });
      return rows.map((r) => this.toDto(r));
    }, tenantId);
  }

  /** Filtro común de la lista y su total (valida fechas, local y categoría). `null` = nada. */
  private filterWhere(filters: {
    facilityId?: string;
    category?: string;
    from?: string;
    to?: string;
    facilityScope?: string[] | null;
    search?: string;
  }): Prisma.ExpenseWhereInput | null {
    assertDay(filters.from, 'desde');
    assertDay(filters.to, 'hasta');
    assertFacilityParam(filters.facilityId);
    if (filters.category && !ExpenseCategoryEnum.safeParse(filters.category).success) {
      throw new BadRequestException({ code: 'invalid_category', message: 'Categoría no válida' });
    }
    const facility = optionalFacilityWhere(filters.facilityScope, filters.facilityId);
    if (!facility) return null;
    const where: Prisma.ExpenseWhereInput = { ...facility };
    const search = filters.search?.trim();
    if (search) {
      const q = { contains: search, mode: 'insensitive' as const };
      where.AND = [{ OR: [{ description: q }, { vendor: q }, { notes: q }] }];
    }
    if (filters.category) where.category = filters.category;
    if (filters.from || filters.to) {
      where.expenseDate = {};
      if (filters.from) where.expenseDate.gte = new Date(`${filters.from}T00:00:00.000Z`);
      if (filters.to) where.expenseDate.lte = new Date(`${filters.to}T00:00:00.000Z`);
    }
    return where;
  }

  /** Total de lo filtrado (la lista va por páginas). */
  async total(
    tenantId: string,
    filters: {
      facilityId?: string;
      category?: string;
      from?: string;
      to?: string;
      facilityScope?: string[] | null;
      search?: string;
    },
  ): Promise<{ count: number; amount: number }> {
    const where = this.filterWhere(filters);
    if (!where) return { count: 0, amount: 0 };
    return this.prisma.withTenant(async (tx) => {
      const agg = await tx.expense.aggregate({
        where,
        _count: { _all: true },
        _sum: { amount: true },
      });
      return { count: agg._count._all, amount: round2(num(agg._sum.amount ?? 0)) };
    }, tenantId);
  }

  /**
   * El local y el canal de marketing tienen que ser de esta empresa (la clave
   * ajena no lo comprueba: con un id de otra empresa el gasto se guardaba). El
   * canal solo vale con la categoría Marketing.
   */
  private async assertRefs(
    tx: Prisma.TransactionClient,
    facilityId: string | null,
    category: string,
    marketingChannelId: string | null,
  ): Promise<void> {
    if (facilityId) {
      const facility = await tx.facility.findFirst({
        where: { id: facilityId, deletedAt: null },
        select: { id: true },
      });
      if (!facility) {
        throw new BadRequestException({
          code: 'facility_not_found',
          message: 'Local no encontrado',
        });
      }
    }
    if (marketingChannelId && category === 'marketing') {
      const channel = await tx.marketingChannel.findFirst({
        where: { id: marketingChannelId },
        select: { id: true },
      });
      if (!channel) {
        throw new BadRequestException({
          code: 'marketing_channel_not_found',
          message: 'Canal de marketing no encontrado',
        });
      }
    }
  }

  async create(
    tenantId: string,
    userId: string | null,
    input: CreateExpenseInput,
    scope: FacilityScope = null,
  ): Promise<ExpenseDto> {
    const facilityId = input.facilityId ?? null;
    assertTargetAllowed(scope, facilityId);
    // El canal solo cuenta como coste de marketing.
    const channelId = input.category === 'marketing' ? (input.marketingChannelId ?? null) : null;
    return this.prisma.withTenant(async (tx) => {
      await this.assertRefs(tx, facilityId, input.category, channelId);
      const row = await tx.expense.create({
        data: {
          tenantId,
          facilityId,
          category: input.category,
          description: input.description,
          amount: input.amount,
          expenseDate: new Date(`${input.expenseDate}T00:00:00.000Z`),
          vendor: input.vendor?.trim() || null,
          notes: input.notes?.trim() || null,
          createdByUserId: userId,
          marketingChannelId: channelId,
        },
        include: EXPENSE_INCLUDE,
      });
      return this.toDto(row);
    }, tenantId);
  }

  /** Gasto de la empresa, visible para quien lo pide y que se puede tocar a mano. */
  private async editable(
    tx: Prisma.TransactionClient,
    id: string,
    scope: FacilityScope,
  ): Promise<{
    facilityId: string | null;
    category: string;
    marketingChannelId: string | null;
  }> {
    const existing = await tx.expense.findFirst({
      where: { id },
      select: { facilityId: true, category: true, marketingChannelId: true, externalRef: true },
    });
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
  ): Promise<ExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await this.editable(tx, id, scope);
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
      await this.assertRefs(
        tx,
        input.facilityId !== undefined ? facilityId : null,
        category,
        input.marketingChannelId !== undefined ? channelId : null,
      );
      const data: Prisma.ExpenseUpdateInput = {};
      if (input.facilityId !== undefined) {
        data.facility = facilityId ? { connect: { id: facilityId } } : { disconnect: true };
      }
      if (input.category !== undefined) data.category = input.category;
      if (input.description !== undefined) data.description = input.description;
      if (input.amount !== undefined) data.amount = input.amount;
      if (input.expenseDate !== undefined)
        data.expenseDate = new Date(`${input.expenseDate}T00:00:00.000Z`);
      if (input.vendor !== undefined) data.vendor = input.vendor?.trim() || null;
      if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
      if (channelId !== existing.marketingChannelId) {
        data.marketingChannel = channelId ? { connect: { id: channelId } } : { disconnect: true };
      }
      const row = await tx.expense.update({
        where: { id },
        data,
        include: EXPENSE_INCLUDE,
      });
      return this.toDto(row);
    }, tenantId);
  }

  async remove(tenantId: string, id: string, scope: FacilityScope = null): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      await this.editable(tx, id, scope);
      await tx.expense.delete({ where: { id } });
    }, tenantId);
  }

  /**
   * Cuenta de resultados por local con las mismas reglas que el Resumen:
   * facturado sin IVA (una sustitutiva cuenta la diferencia, los abonos restan,
   * sin fianzas) − gastos = resultado. Cada factura va al local de su contrato,
   * al suyo propio (pase nocturno) o al de su venta; las que no tienen local y
   * los gastos generales van a «Sin local». El cobrado es el dinero recibido
   * (con IVA), por días en la hora del negocio. Quien solo ve unos locales ve
   * los suyos y lo general; sin permiso de facturas o de cobros, esas cifras no
   * se enseñan.
   */
  async getProfitLoss(
    tenantId: string,
    from: string,
    to: string,
    opts: {
      facilityScope?: FacilityScope;
      invoicesVisible?: boolean;
      paymentsVisible?: boolean;
    } = {},
  ): Promise<ProfitLossDto> {
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
    const invoicesVisible = opts.invoicesVisible !== false;
    const paymentsVisible = opts.paymentsVisible !== false;
    const scope = resolveAnalyticsScope(opts.facilityScope ?? null);
    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
      const tz = tenant?.timezone ?? 'Europe/Madrid';
      // Facturas por su fecha de emisión (día del calendario, columna DATE).
      const fromD = new Date(`${from}T00:00:00.000Z`);
      const toNext = new Date(`${to}T00:00:00.000Z`);
      toNext.setUTCDate(toNext.getUTCDate() + 1);
      const facilityOf = {
        facilityId: true,
        contract: { select: { unit: { select: { facilityId: true } } } },
        productSale: { select: { facilityId: true } },
      } as const;
      const [invoices, payments, expenses, facilities] = await Promise.all([
        invoicesVisible
          ? tx.invoice.findMany({
              where: invoicedWhere(scope, fromD, toNext),
              select: { ...INVOICED_SELECT, ...facilityOf },
            })
          : Promise.resolve([]),
        paymentsVisible
          ? tx.payment.findMany({
              where: collectedWhere(scope, zonedDayStart(from, tz), zonedNextDayStart(to, tz)),
              select: { amount: true, refundedAmount: true, invoice: { select: facilityOf } },
            })
          : Promise.resolve([]),
        tx.expense.findMany({
          where: {
            expenseDate: { gte: fromD, lt: toNext },
            ...(scope.ids ? { OR: [{ facilityId: { in: scope.ids } }, { facilityId: null }] } : {}),
          },
          select: { facilityId: true, amount: true, category: true },
        }),
        tx.facility.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
      ]);

      const GENERAL = '__none__';
      const keyOf = (
        i: {
          facilityId: string | null;
          contract: { unit: { facilityId: string } | null } | null;
          productSale: { facilityId: string | null } | null;
        } | null,
      ): string =>
        i?.contract?.unit?.facilityId ?? i?.facilityId ?? i?.productSale?.facilityId ?? GENERAL;
      const acc = new Map<string, { invoiced: number; collected: number; expenses: number }>();
      const bump = (key: string, field: 'invoiced' | 'collected' | 'expenses', v: number) => {
        const e = acc.get(key) ?? { invoiced: 0, collected: 0, expenses: 0 };
        e[field] += v;
        acc.set(key, e);
      };
      for (const i of invoices) bump(keyOf(i), 'invoiced', invoicedBase(i));
      for (const p of payments)
        bump(keyOf(p.invoice), 'collected', num(p.amount) - num(p.refundedAmount));
      for (const ex of expenses) bump(ex.facilityId ?? GENERAL, 'expenses', num(ex.amount));

      const nameById = new Map(facilities.map((f) => [f.id, f.name]));
      const rows: ProfitLossRowDto[] = [...acc.entries()]
        .map(([key, v]) => ({
          facilityId: key === GENERAL ? null : key,
          facilityName: key === GENERAL ? 'Sin local' : (nameById.get(key) ?? 'Local eliminado'),
          invoiced: round2(v.invoiced),
          collected: round2(v.collected),
          expenses: round2(v.expenses),
          net: invoicesVisible ? round2(v.invoiced - v.expenses) : 0,
        }))
        .sort((a, b) => b.net - a.net || b.expenses - a.expenses);

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

      return { from, to, rows, totals, byCategory, invoicesVisible, paymentsVisible };
    }, tenantId);
  }

  // ---- gastos recurrentes (plantillas) ----

  async listRecurring(
    tenantId: string,
    scope: FacilityScope = null,
  ): Promise<RecurringExpenseDto[]> {
    const facility = optionalFacilityWhere(scope);
    if (!facility) return [];
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.recurringExpense.findMany({
        where: facility,
        include: RECURRING_INCLUDE,
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      });
      return rows.map((r) => this.toRecurringDto(r));
    }, tenantId);
  }

  async createRecurring(
    tenantId: string,
    userId: string | null,
    input: CreateRecurringExpenseInput,
    scope: FacilityScope = null,
  ): Promise<RecurringExpenseDto> {
    const facilityId = input.facilityId ?? null;
    assertTargetAllowed(scope, facilityId);
    const channelId = input.category === 'marketing' ? (input.marketingChannelId ?? null) : null;
    return this.prisma.withTenant(async (tx) => {
      await this.assertRefs(tx, facilityId, input.category, channelId);
      const row = await tx.recurringExpense.create({
        data: {
          tenantId,
          facilityId,
          category: input.category,
          description: input.description,
          amount: input.amount,
          dayOfMonth: input.dayOfMonth,
          active: input.active,
          createdByUserId: userId,
          marketingChannelId: channelId,
        },
        include: RECURRING_INCLUDE,
      });
      return this.toRecurringDto(row);
    }, tenantId);
  }

  private async editableRecurring(
    tx: Prisma.TransactionClient,
    id: string,
    scope: FacilityScope,
  ): Promise<{ facilityId: string | null; category: string; marketingChannelId: string | null }> {
    const existing = await tx.recurringExpense.findFirst({
      where: { id },
      select: { facilityId: true, category: true, marketingChannelId: true },
    });
    if (!existing || (existing.facilityId && scope && !scope.includes(existing.facilityId))) {
      throw new NotFoundException({ code: 'recurring_not_found', message: 'No encontrado' });
    }
    assertTargetAllowed(scope, existing.facilityId);
    return existing;
  }

  async updateRecurring(
    tenantId: string,
    id: string,
    input: UpdateRecurringExpenseInput,
    scope: FacilityScope = null,
  ): Promise<RecurringExpenseDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await this.editableRecurring(tx, id, scope);
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
      await this.assertRefs(
        tx,
        input.facilityId !== undefined ? facilityId : null,
        category,
        input.marketingChannelId !== undefined ? channelId : null,
      );
      const data: Prisma.RecurringExpenseUpdateInput = {};
      if (input.facilityId !== undefined)
        data.facility = facilityId ? { connect: { id: facilityId } } : { disconnect: true };
      if (input.category !== undefined) data.category = input.category;
      if (input.description !== undefined) data.description = input.description;
      if (input.amount !== undefined) data.amount = input.amount;
      if (input.dayOfMonth !== undefined) data.dayOfMonth = input.dayOfMonth;
      if (input.active !== undefined) data.active = input.active;
      if (channelId !== existing.marketingChannelId) {
        data.marketingChannel = channelId ? { connect: { id: channelId } } : { disconnect: true };
      }
      const row = await tx.recurringExpense.update({
        where: { id },
        data,
        include: RECURRING_INCLUDE,
      });
      return this.toRecurringDto(row);
    }, tenantId);
  }

  async removeRecurring(tenantId: string, id: string, scope: FacilityScope = null): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      await this.editableRecurring(tx, id, scope);
      await tx.recurringExpense.delete({ where: { id } });
    }, tenantId);
  }

  /**
   * Genera los gastos de las plantillas recurrentes vencidas de un tenant: por
   * cada plantilla activa cuyo `dayOfMonth` ya llegó este mes (en la hora del
   * negocio) y que no se ha generado aún este mes, crea el `expense`. Cada
   * plantilla se reserva antes de crear su gasto: dos «Generar ahora» a la vez
   * (o con la tarea de las 06:00) no lo duplican.
   */
  async generateForTenant(tenantId: string, now = new Date()): Promise<{ created: number }> {
    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
      const today = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid', now);
      const year = today.getUTCFullYear();
      const month = today.getUTCMonth();
      const monthStart = new Date(Date.UTC(year, month, 1));
      const due = await tx.recurringExpense.findMany({
        where: {
          active: true,
          dayOfMonth: { lte: today.getUTCDate() },
          AND: [
            { OR: [{ lastGeneratedMonth: null }, { lastGeneratedMonth: { lt: monthStart } }] },
            // Los gastos de un local borrado no siguen generándose.
            { OR: [{ facilityId: null }, { facility: { deletedAt: null } }] },
          ],
        },
      });
      let created = 0;
      for (const r of due) {
        // Reserva: solo quien la pasa al mes actual crea el gasto.
        const claimed = await tx.recurringExpense.updateMany({
          where: {
            id: r.id,
            OR: [{ lastGeneratedMonth: null }, { lastGeneratedMonth: { lt: monthStart } }],
          },
          data: { lastGeneratedMonth: monthStart },
        });
        if (claimed.count === 0) continue;
        await tx.expense.create({
          data: {
            tenantId,
            facilityId: r.facilityId,
            category: r.category,
            description: r.description,
            amount: r.amount,
            expenseDate: new Date(Date.UTC(year, month, r.dayOfMonth)),
            notes: AUTO_RECURRING_NOTE,
            marketingChannelId: r.category === 'marketing' ? r.marketingChannelId : null,
            recurringExpenseId: r.id,
          },
        });
        created += 1;
      }
      return { created };
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
      marketingChannelId: r.marketingChannelId,
      marketingChannelName: r.marketingChannel?.name ?? null,
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
      marketingChannelId: r.marketingChannelId,
      marketingChannelName: r.marketingChannel?.name ?? null,
      source: sourceOf(r),
      recurringExpenseId: r.recurringExpenseId,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
