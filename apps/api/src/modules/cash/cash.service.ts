import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CASH_MOVEMENT_SIGN,
  denominationsTotalCents,
  NON_CASH_PAYMENT_METHODS,
  type CashMovementKind,
} from '@storageos/shared';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../common/format';
import { toCents } from '../../common/money';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  CashClosureBreakdownDto,
  CashClosureDto,
  CashDaySummaryDto,
  CashLineDto,
  CashMethodKey,
  CashMovementDto,
  CloseCashInput,
  CreateCashMovementInput,
  ReopenCashClosureInput,
} from '@storageos/shared';

const CLOSURE_INCLUDE = {
  closedBy: { select: { fullName: true } },
  reopenedBy: { select: { fullName: true } },
  facility: { select: { name: true } },
} satisfies Prisma.CashClosureInclude;

type ClosureRow = Prisma.CashClosureGetPayload<{ include: typeof CLOSURE_INCLUDE }>;

const MOVEMENT_INCLUDE = {
  createdBy: { select: { fullName: true } },
  facility: { select: { name: true } },
} satisfies Prisma.CashMovementInclude;

type MovementRow = Prisma.CashMovementGetPayload<{ include: typeof MOVEMENT_INCLUDE }>;

const CUSTOMER_NAME = {
  firstName: true,
  lastName: true,
  companyName: true,
  customerType: true,
} as const;

function customerName(
  c: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: string;
  } | null,
): string | null {
  if (!c) return null;
  if (c.customerType === 'business') return c.companyName ?? null;
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
}

/** La forma de un cobro tal como la cuenta la caja. */
function methodKey(methodType: string | null): CashMethodKey {
  switch (methodType) {
    case 'cash':
      return 'cash';
    case 'card':
      return 'card';
    case 'sepa_debit':
      return 'sepaDebit';
    case 'bank_transfer':
      return 'bankTransfer';
    case 'bizum':
      return 'bizum';
    default:
      return 'other';
  }
}

const emptyByMethod = (): Record<CashMethodKey, number> => ({
  cash: 0,
  card: 0,
  sepaDebit: 0,
  bankTransfer: 0,
  bizum: 0,
  other: 0,
});

/** `YYYY-MM-DD` que existe en el calendario. */
function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Cierre de caja diario (arqueo de efectivo). Agrega lo cobrado ese día por
 * forma de pago y lo que salió (devoluciones, fianzas devueltas en efectivo) y
 * registra el cierre: el operador introduce el efectivo contado y se guarda la
 * diferencia con el esperado. Uno por día, GLOBAL del negocio o por LOCAL; un
 * cierre se puede reabrir con motivo para registrar algo de ese día.
 *
 * El día es el del calendario del negocio (su zona horaria).
 */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** El día como valor de la columna DATE del cierre (medianoche UTC). */
  private closureDay(date: string): Date {
    return new Date(`${date}T00:00:00.000Z`);
  }

  private async tenantTimezone(tenantId: string): Promise<string> {
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      tenantId,
    );
    return tenant?.timezone ?? 'Europe/Madrid';
  }

  /** Día pedido (o hoy en la zona del negocio), comprobado. */
  private async resolveDay(
    tenantId: string,
    date: string | undefined,
  ): Promise<{ day: string; tz: string }> {
    const tz = await this.tenantTimezone(tenantId);
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    if (!date) return { day: today, tz };
    if (!isRealDate(date)) {
      throw new BadRequestException({ code: 'invalid_date', message: 'Fecha no válida' });
    }
    if (date > today) {
      throw new BadRequestException({
        code: 'date_in_future',
        message: 'La caja de un día que aún no ha llegado no se consulta ni se cierra',
      });
    }
    return { day: date, tz };
  }

  private async assertFacility(tenantId: string, facilityId: string): Promise<void> {
    const found = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({ where: { id: facilityId, deletedAt: null }, select: { id: true } }),
      tenantId,
    );
    if (!found) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
  }

  async getDaySummary(
    tenantId: string,
    date: string | undefined,
    facilityId?: string | null,
    facilityScope?: string[] | null,
  ): Promise<CashDaySummaryDto> {
    // Un usuario restringido a ciertos locales no puede ver la caja GLOBAL (la de
    // todos los locales): debe elegir uno de los suyos.
    if (facilityScope && !facilityId) {
      throw new BadRequestException({
        code: 'facility_required',
        message: 'Elige un local: tu acceso está limitado a unos locales',
      });
    }
    if (facilityId) {
      assertFacilityAllowed(facilityScope, facilityId);
      await this.assertFacility(tenantId, facilityId);
    }
    const { day, tz } = await this.resolveDay(tenantId, date);
    const gte = zonedDayStart(day, tz);
    const lt = zonedNextDayStart(day, tz);

    // Una factura es de un local por su contrato (alquiler), por su venta de
    // producto (tienda) o por su local imputado (pase nocturno).
    const invoiceOfFacility: Prisma.InvoiceWhereInput | null = facilityId
      ? {
          OR: [
            { contract: { unit: { facilityId } } },
            { productSale: { facilityId } },
            { facilityId },
          ],
        }
      : null;
    // Lo cobrado ese día: cuenta aunque después se devuelva (reembolso o
    // devolución del banco), que se descuenta el día en que ocurre. La fianza
    // aplicada a una factura no es dinero nuevo: entró al cobrar la fianza.
    const incomeWhere: Prisma.PaymentWhereInput = {
      paidAt: { gte, lt },
      methodType: { notIn: [...NON_CASH_PAYMENT_METHODS, 'deposit'] },
      OR: [
        { status: { in: ['succeeded', 'partially_refunded', 'refunded'] } },
        { status: 'failed', returnedAt: { not: null } },
      ],
      ...(invoiceOfFacility ? { invoice: invoiceOfFacility } : {}),
    };
    const dayDate = this.closureDay(day);

    const depositReturnWhere: Prisma.ContractWhereInput = {
      depositReturnMethod: 'cash',
      depositReturnedAmount: { gt: 0 },
      OR: [
        { depositReturnedOn: dayDate },
        { depositReturnedOn: null, depositSettledAt: { gte, lt } },
      ],
      ...(facilityId ? { unit: { facilityId } } : {}),
    };
    // La caja global es todo el efectivo del negocio: también los movimientos de cada local.
    const movementWhere: Prisma.CashMovementWhereInput = {
      movementDate: dayDate,
      ...(facilityId ? { facilityId } : {}),
    };
    const [
      incomeRows,
      refundRows,
      returnedSum,
      depositReturns,
      closureRow,
      movementRows,
      lastFloat,
      cashPayments,
      cashRefunds,
      depositReturnRows,
    ] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.payment.groupBy({
            by: ['methodType'],
            where: incomeWhere,
            _sum: { amount: true },
            _count: { _all: true },
          }),
          // Devoluciones del día por la forma en que salió el dinero (una
          // devolución como saldo a favor no tiene forma: no sale dinero).
          tx.invoiceRefund.groupBy({
            by: ['method'],
            where: {
              createdAt: { gte, lt },
              method: { not: null },
              ...(invoiceOfFacility ? { invoice: invoiceOfFacility } : {}),
            },
            _sum: { amount: true },
          }),
          tx.payment.aggregate({
            where: {
              returnedAt: { gte, lt },
              ...(invoiceOfFacility ? { invoice: invoiceOfFacility } : {}),
            },
            _sum: { amount: true },
          }),
          // Fianzas devueltas en efectivo ese día (el día que se indicó al
          // liquidar o, si no, el de la liquidación).
          tx.contract.aggregate({
            where: depositReturnWhere,
            _sum: { depositReturnedAmount: true },
          }),
          tx.cashClosure.findFirst({
            where: { closureDate: dayDate, facilityId: facilityId ?? null, reopenedAt: null },
            include: CLOSURE_INCLUDE,
          }),
          tx.cashMovement.findMany({
            where: movementWhere,
            include: MOVEMENT_INCLUDE,
            orderBy: { createdAt: 'asc' },
          }),
          // El último fondo de apertura de esta caja, para proponerlo.
          tx.cashMovement.findFirst({
            where: {
              kind: 'opening_float',
              facilityId: facilityId ?? null,
              movementDate: { lte: dayDate },
            },
            orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
            select: { amount: true },
          }),
          // Cada apunte de efectivo del día, con su inquilino y su factura.
          tx.payment.findMany({
            where: { ...incomeWhere, methodType: 'cash' },
            select: {
              amount: true,
              paidAt: true,
              customerId: true,
              customer: { select: CUSTOMER_NAME },
              invoice: { select: { id: true, invoiceNumber: true, contractId: true } },
            },
            orderBy: { paidAt: 'desc' },
            take: 200,
          }),
          tx.invoiceRefund.findMany({
            where: {
              createdAt: { gte, lt },
              method: 'cash',
              ...(invoiceOfFacility ? { invoice: invoiceOfFacility } : {}),
            },
            select: {
              amount: true,
              createdAt: true,
              invoice: {
                select: {
                  id: true,
                  invoiceNumber: true,
                  contractId: true,
                  customerId: true,
                  customer: { select: CUSTOMER_NAME },
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 200,
          }),
          tx.contract.findMany({
            where: depositReturnWhere,
            select: {
              id: true,
              depositReturnedAmount: true,
              depositSettledAt: true,
              depositReturnedOn: true,
              customerId: true,
              customer: { select: CUSTOMER_NAME },
            },
            take: 200,
          }),
        ]),
      tenantId,
    );

    const incomeCents = emptyByMethod();
    let count = 0;
    for (const r of incomeRows) {
      incomeCents[methodKey(r.methodType)] += toCents(r._sum.amount ?? 0);
      count += r._count._all;
    }
    const refundCents = emptyByMethod();
    for (const r of refundRows) {
      refundCents[methodKey(r.method)] += toCents(r._sum.amount ?? 0);
    }
    const sum = (m: Record<CashMethodKey, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    const toEuros = (m: Record<CashMethodKey, number>) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / 100])) as Record<
        CashMethodKey,
        number
      >;
    const depositReturnsCashCents = toCents(depositReturns._sum.depositReturnedAmount ?? 0);
    let movementsInCents = 0;
    let movementsOutCents = 0;
    for (const m of movementRows) {
      if (CASH_MOVEMENT_SIGN[m.kind as CashMovementKind] > 0) movementsInCents += toCents(m.amount);
      else movementsOutCents += toCents(m.amount);
    }
    const expectedCents =
      incomeCents.cash -
      refundCents.cash -
      depositReturnsCashCents +
      movementsInCents -
      movementsOutCents;

    const cashLines: CashLineDto[] = [
      ...cashPayments.map(
        (p): CashLineDto => ({
          kind: 'payment',
          amount: Number(p.amount),
          at: p.paidAt!.toISOString(),
          customerId: p.customerId,
          customerName: customerName(p.customer),
          invoiceId: p.invoice?.id ?? null,
          invoiceNumber: p.invoice?.invoiceNumber ?? null,
          contractId: p.invoice?.contractId ?? null,
        }),
      ),
      ...cashRefunds.map(
        (r): CashLineDto => ({
          kind: 'refund',
          amount: -Number(r.amount),
          at: r.createdAt.toISOString(),
          customerId: r.invoice.customerId,
          customerName: customerName(r.invoice.customer),
          invoiceId: r.invoice.id,
          invoiceNumber: r.invoice.invoiceNumber,
          contractId: r.invoice.contractId,
        }),
      ),
      ...depositReturnRows.map(
        (c): CashLineDto => ({
          kind: 'deposit_return',
          amount: -Number(c.depositReturnedAmount ?? 0),
          at: (c.depositSettledAt ?? gte).toISOString(),
          customerId: c.customerId,
          customerName: customerName(c.customer),
          invoiceId: null,
          invoiceNumber: null,
          contractId: c.id,
        }),
      ),
    ].sort((a, b) => b.at.localeCompare(a.at));

    return {
      date: day,
      facilityId: facilityId ?? null,
      ...toEuros(incomeCents),
      total: sum(incomeCents) / 100,
      refunds: toEuros(refundCents),
      refundsTotal: sum(refundCents) / 100,
      returned: toCents(returnedSum._sum.amount ?? 0) / 100,
      cashRefunds: refundCents.cash / 100,
      depositReturnsCash: depositReturnsCashCents / 100,
      movements: movementRows.map((m) => this.movementDto(m)),
      movementsIn: movementsInCents / 100,
      movementsOut: movementsOutCents / 100,
      lastOpeningFloat: lastFloat ? Number(lastFloat.amount) : null,
      cashLines,
      expectedCash: expectedCents / 100,
      count,
      closure: closureRow ? this.toDto(closureRow) : null,
    };
  }

  async closeDay(args: {
    tenantId: string;
    userId: string;
    input: CloseCashInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<CashClosureDto> {
    const facilityId = args.input.facilityId ?? null;
    // El resumen comprueba el día, el local y el alcance.
    const summary = await this.getDaySummary(
      args.tenantId,
      args.input.date,
      facilityId,
      args.facilityScope,
    );
    if (summary.closure) {
      throw new ConflictException({
        code: 'day_already_closed',
        message: 'La caja de ese día ya está cerrada',
      });
    }
    const expectedCents = toCents(summary.expectedCash);
    const countedCents = toCents(args.input.countedCash);
    const differenceCents = countedCents - expectedCents;
    // El recuento por billetes y monedas tiene que dar lo contado.
    const denominations = args.input.denominations
      ? Object.fromEntries(Object.entries(args.input.denominations).filter(([, n]) => n > 0))
      : null;
    if (denominations && denominationsTotalCents(denominations) !== countedCents) {
      throw new BadRequestException({
        code: 'denominations_mismatch',
        message: 'El recuento por billetes y monedas no suma el efectivo contado',
      });
    }
    const breakdown: CashClosureBreakdownDto = {
      cashIn: summary.cash,
      cashRefunds: summary.cashRefunds,
      depositReturnsCash: summary.depositReturnsCash,
      movementsIn: summary.movementsIn,
      movementsOut: summary.movementsOut,
      byMethod: {
        cash: summary.cash,
        card: summary.card,
        sepaDebit: summary.sepaDebit,
        bankTransfer: summary.bankTransfer,
        bizum: summary.bizum,
        other: summary.other,
      },
      movements: summary.movements.map((m) => ({
        kind: m.kind,
        amount: m.amount,
        notes: m.notes,
      })),
    };

    const created = await this.prisma
      .withTenant(
        (tx) =>
          tx.cashClosure.create({
            data: {
              tenantId: args.tenantId,
              facilityId,
              closureDate: this.closureDay(summary.date),
              expectedCash: expectedCents / 100,
              countedCash: countedCents / 100,
              difference: differenceCents / 100,
              notes: args.input.notes?.trim() || null,
              closedByUserId: args.userId,
              ...(denominations ? { denominations } : {}),
              breakdown: breakdown as unknown as Prisma.InputJsonValue,
            },
            include: CLOSURE_INCLUDE,
          }),
        args.tenantId,
      )
      .catch((err: unknown) => {
        // Índice único parcial: cierre concurrente del mismo ámbito → 409.
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          throw new ConflictException({
            code: 'day_already_closed',
            message: 'La caja de ese día ya está cerrada',
          });
        }
        throw err;
      });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'cash.day_closed',
      entityType: 'CashClosure',
      entityId: created.id,
      changes: {
        date: summary.date,
        facilityId,
        expected: expectedCents / 100,
        counted: countedCents / 100,
        difference: differenceCents / 100,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  /**
   * Reabre un cierre para registrar un cobro o una devolución en efectivo de
   * ese día. El cierre queda de constancia (reabierto, con quién y por qué) y
   * el día se vuelve a cerrar con el arqueo nuevo.
   */
  async reopen(args: {
    tenantId: string;
    userId: string;
    closureId: string;
    input: ReopenCashClosureInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<CashClosureDto> {
    const closure = await this.prisma.withTenant(
      (tx) => tx.cashClosure.findFirst({ where: { id: args.closureId } }),
      args.tenantId,
    );
    // Quien solo ve unos locales no ve (ni reabre) la caja global.
    if (!closure || (args.facilityScope && !closure.facilityId)) {
      throw new NotFoundException({ code: 'closure_not_found', message: 'Cierre no encontrado' });
    }
    if (closure.facilityId) assertFacilityAllowed(args.facilityScope, closure.facilityId);
    const reason = args.input.reason.trim();
    const updated = await this.prisma.withTenant(async (tx) => {
      const claimed = await tx.cashClosure.updateMany({
        where: { id: args.closureId, reopenedAt: null },
        data: { reopenedAt: new Date(), reopenedByUserId: args.userId, reopenReason: reason },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'closure_already_reopened',
          message: 'Ese cierre ya está reabierto',
        });
      }
      return tx.cashClosure.findUniqueOrThrow({
        where: { id: args.closureId },
        include: CLOSURE_INCLUDE,
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'cash.closure_reopened',
      entityType: 'CashClosure',
      entityId: args.closureId,
      changes: {
        date: closure.closureDate.toISOString().slice(0, 10),
        facilityId: closure.facilityId,
        reason,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Cierres, del más reciente al más antiguo: los 90 últimos o los de un mes,
   * de todas las cajas o de una (`global` = la de toda la empresa).
   */
  async listClosures(
    tenantId: string,
    facilityScope?: string[] | null,
    filters: { month?: string; facilityId?: string } = {},
  ): Promise<CashClosureDto[]> {
    const where: Prisma.CashClosureWhereInput = {
      // Quien solo ve unos locales ve los cierres de esos locales (la caja
      // global es de toda la empresa).
      ...(facilityScope ? { facilityId: { in: facilityScope } } : {}),
    };
    if (filters.facilityId === 'global') {
      if (facilityScope) return [];
      where.facilityId = null;
    } else if (filters.facilityId) {
      assertFacilityAllowed(facilityScope, filters.facilityId);
      where.facilityId = filters.facilityId;
    }
    if (filters.month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month)) {
        throw new BadRequestException({
          code: 'invalid_month',
          message: 'Mes no válido (AAAA-MM).',
        });
      }
      const [y, m] = filters.month.split('-').map(Number) as [number, number];
      where.closureDate = {
        gte: new Date(Date.UTC(y, m - 1, 1)),
        lt: new Date(Date.UTC(y, m, 1)),
      };
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.cashClosure.findMany({
          where,
          orderBy: [{ closureDate: 'desc' }, { closedAt: 'desc' }],
          take: filters.month ? 500 : 90,
          include: CLOSURE_INCLUDE,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Un cierre (para el PDF), con el alcance por local. */
  async getClosure(
    tenantId: string,
    closureId: string,
    facilityScope?: string[] | null,
  ): Promise<CashClosureDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.cashClosure.findFirst({ where: { id: closureId }, include: CLOSURE_INCLUDE }),
      tenantId,
    );
    if (!row || (facilityScope && !row.facilityId)) {
      throw new NotFoundException({ code: 'closure_not_found', message: 'Cierre no encontrado' });
    }
    if (row.facilityId) assertFacilityAllowed(facilityScope, row.facilityId);
    return this.toDto(row);
  }

  /**
   * Movimiento de caja que no es un cobro: fondo de apertura, entrada de cambio
   * o retirada al banco. Con la caja de ese día cerrada no se registra.
   */
  async addMovement(args: {
    tenantId: string;
    userId: string;
    input: CreateCashMovementInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<CashMovementDto> {
    const facilityId = args.input.facilityId ?? null;
    if (args.facilityScope && !facilityId) {
      throw new BadRequestException({
        code: 'facility_required',
        message: 'Elige un local: tu acceso está limitado a unos locales',
      });
    }
    if (facilityId) {
      assertFacilityAllowed(args.facilityScope, facilityId);
      await this.assertFacility(args.tenantId, facilityId);
    }
    const { day } = await this.resolveDay(args.tenantId, args.input.date);
    const dayDate = this.closureDay(day);
    const created = await this.prisma.withTenant(async (tx) => {
      await this.assertDayOpen(tx, args.tenantId, dayDate, facilityId);
      return tx.cashMovement.create({
        data: {
          tenantId: args.tenantId,
          facilityId,
          movementDate: dayDate,
          kind: args.input.kind,
          amount: toCents(args.input.amount) / 100,
          notes: args.input.notes?.trim() || null,
          createdByUserId: args.userId,
        },
        include: MOVEMENT_INCLUDE,
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'cash.movement_added',
      entityType: 'CashMovement',
      entityId: created.id,
      changes: { date: day, facilityId, kind: args.input.kind, amount: Number(created.amount) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.movementDto(created);
  }

  async deleteMovement(args: {
    tenantId: string;
    userId: string;
    movementId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<void> {
    const removed = await this.prisma.withTenant(async (tx) => {
      const row = await tx.cashMovement.findFirst({ where: { id: args.movementId } });
      if (!row || (args.facilityScope && !row.facilityId)) {
        throw new NotFoundException({
          code: 'movement_not_found',
          message: 'Movimiento no encontrado',
        });
      }
      if (row.facilityId) assertFacilityAllowed(args.facilityScope, row.facilityId);
      await this.assertDayOpen(tx, args.tenantId, row.movementDate, row.facilityId);
      await tx.cashMovement.delete({ where: { id: row.id } });
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'cash.movement_deleted',
      entityType: 'CashMovement',
      entityId: removed.id,
      changes: {
        date: removed.movementDate.toISOString().slice(0, 10),
        facilityId: removed.facilityId,
        kind: removed.kind,
        amount: Number(removed.amount),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /**
   * 409 si la caja de ese día está cerrada: la suya o la global (que cubre
   * todo el efectivo); un movimiento de la caja global, solo la global.
   */
  private async assertDayOpen(
    tx: Prisma.TransactionClient,
    tenantId: string,
    dayDate: Date,
    facilityId: string | null,
  ): Promise<void> {
    const closed = await tx.cashClosure.findFirst({
      where: {
        tenantId,
        closureDate: dayDate,
        reopenedAt: null,
        OR: [{ facilityId: null }, ...(facilityId ? [{ facilityId }] : [])],
      },
      select: { id: true },
    });
    if (closed) {
      const day = dayDate.toISOString().slice(0, 10).split('-').reverse().join('/');
      throw new ConflictException({
        code: 'cash_day_closed',
        message: `La caja del ${day} ya está cerrada: un movimiento de caja de ese día no se puede registrar ni quitar. Si hace falta, reabre el cierre.`,
        details: { closureId: closed.id },
      });
    }
  }

  private movementDto(row: MovementRow): CashMovementDto {
    return {
      id: row.id,
      date: row.movementDate.toISOString().slice(0, 10),
      facilityId: row.facilityId,
      facilityName: row.facility?.name ?? null,
      kind: row.kind as CashMovementKind,
      amount: Number(row.amount),
      notes: row.notes,
      createdByName: row.createdBy?.fullName ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toDto(row: ClosureRow): CashClosureDto {
    return {
      id: row.id,
      date: row.closureDate.toISOString().slice(0, 10),
      facilityId: row.facilityId,
      facilityName: row.facility?.name ?? null,
      expectedCash: Number(row.expectedCash),
      countedCash: Number(row.countedCash),
      difference: Number(row.difference),
      notes: row.notes,
      closedByName: row.closedBy?.fullName ?? null,
      closedAt: row.closedAt.toISOString(),
      reopenedAt: row.reopenedAt?.toISOString() ?? null,
      reopenedByName: row.reopenedBy?.fullName ?? null,
      reopenReason: row.reopenReason,
      denominations: (row.denominations as Record<string, number> | null) ?? null,
      breakdown: (row.breakdown as CashClosureBreakdownDto | null) ?? null,
    };
  }
}
