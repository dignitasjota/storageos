import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../common/format';
import { toCents } from '../../common/money';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  CashClosureDto,
  CashDaySummaryDto,
  CashMethodKey,
  CloseCashInput,
  ReopenCashClosureInput,
} from '@storageos/shared';

const CLOSURE_INCLUDE = {
  closedBy: { select: { fullName: true } },
  reopenedBy: { select: { fullName: true } },
  facility: { select: { name: true } },
} satisfies Prisma.CashClosureInclude;

type ClosureRow = Prisma.CashClosureGetPayload<{ include: typeof CLOSURE_INCLUDE }>;

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

    const [incomeRows, refundRows, returnedSum, depositReturns, closureRow] =
      await this.prisma.withTenant(
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
              where: {
                depositReturnMethod: 'cash',
                depositReturnedAmount: { gt: 0 },
                OR: [
                  { depositReturnedOn: dayDate },
                  { depositReturnedOn: null, depositSettledAt: { gte, lt } },
                ],
                ...(facilityId ? { unit: { facilityId } } : {}),
              },
              _sum: { depositReturnedAmount: true },
            }),
            tx.cashClosure.findFirst({
              where: { closureDate: dayDate, facilityId: facilityId ?? null, reopenedAt: null },
              include: CLOSURE_INCLUDE,
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
    const expectedCents = incomeCents.cash - refundCents.cash - depositReturnsCashCents;

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

  async listClosures(tenantId: string, facilityScope?: string[] | null): Promise<CashClosureDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.cashClosure.findMany({
          // Quien solo ve unos locales ve los cierres de esos locales (la caja
          // global es de toda la empresa).
          where: facilityScope ? { facilityId: { in: facilityScope } } : {},
          orderBy: [{ closureDate: 'desc' }, { closedAt: 'desc' }],
          take: 90,
          include: CLOSURE_INCLUDE,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
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
    };
  }
}
