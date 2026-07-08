import { ConflictException, Injectable } from '@nestjs/common';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { subtractAmounts } from '../../common/money';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type { CashClosureDto, CashDaySummaryDto, CloseCashInput } from '@storageos/shared';

/**
 * Cierre de caja diario (arqueo de efectivo). Agrega los cobros del día por
 * método de pago (para cuadrar el efectivo) y registra el cierre: el operador
 * introduce el efectivo contado físicamente y se guarda la diferencia respecto
 * al esperado (suma de pagos `cash` del día). Uno por día, GLOBAL del tenant o
 * por LOCAL (`facilityId`); respeta el alcance por local del usuario.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Rango [00:00, 24:00) UTC del día `YYYY-MM-DD`. */
  private dayRange(date: string): { gte: Date; lt: Date } {
    const gte = new Date(`${date}T00:00:00.000Z`);
    const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
    return { gte, lt };
  }

  async getDaySummary(
    tenantId: string,
    date: string,
    facilityId?: string | null,
    facilityScope?: string[] | null,
  ): Promise<CashDaySummaryDto> {
    if (facilityId) assertFacilityAllowed(facilityScope, facilityId);
    const { gte, lt } = this.dayRange(date);
    // Filtro de pagos: por local (vía invoice→contract→unit→facility) o global.
    const paymentWhere: Prisma.PaymentWhereInput = {
      status: 'succeeded',
      paidAt: { gte, lt },
      ...(facilityId ? { invoice: { contract: { unit: { facilityId } } } } : {}),
    };
    const [rows, closureRow] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.payment.groupBy({
            by: ['methodType'],
            where: paymentWhere,
            _sum: { amount: true },
            _count: { _all: true },
          }),
          tx.cashClosure.findFirst({
            where: { closureDate: gte, facilityId: facilityId ?? null },
            include: {
              closedBy: { select: { fullName: true } },
              facility: { select: { name: true } },
            },
          }),
        ]),
      tenantId,
    );

    const byMethod: Record<string, number> = {};
    let count = 0;
    for (const r of rows) {
      byMethod[r.methodType] = Number(r._sum.amount ?? 0);
      count += r._count._all;
    }
    const cash = byMethod.cash ?? 0;
    const card = byMethod.card ?? 0;
    const sepaDebit = byMethod.sepa_debit ?? 0;
    const bankTransfer = byMethod.bank_transfer ?? 0;
    const other = byMethod.other ?? 0;
    return {
      date,
      facilityId: facilityId ?? null,
      cash,
      card,
      sepaDebit,
      bankTransfer,
      other,
      total: cash + card + sepaDebit + bankTransfer + other,
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
    if (facilityId) assertFacilityAllowed(args.facilityScope, facilityId);
    const { gte } = this.dayRange(args.input.date);
    // Esperado = efectivo cobrado ese día (pagos `cash` succeeded) en ese ámbito.
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
    const expected = summary.cash;
    const counted = args.input.countedCash;
    const difference = subtractAmounts(counted, expected);

    const created = await this.prisma
      .withTenant(
        (tx) =>
          tx.cashClosure.create({
            data: {
              tenantId: args.tenantId,
              facilityId,
              closureDate: gte,
              expectedCash: expected,
              countedCash: counted,
              difference,
              notes: args.input.notes?.trim() || null,
              closedByUserId: args.userId,
            },
            include: {
              closedBy: { select: { fullName: true } },
              facility: { select: { name: true } },
            },
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
      changes: { date: args.input.date, facilityId, expected, counted, difference },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async listClosures(tenantId: string, facilityScope?: string[] | null): Promise<CashClosureDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.cashClosure.findMany({
          // El usuario restringido solo ve los cierres globales + los de sus locales.
          where: facilityScope
            ? { OR: [{ facilityId: null }, { facilityId: { in: facilityScope } }] }
            : {},
          orderBy: { closureDate: 'desc' },
          take: 90,
          include: {
            closedBy: { select: { fullName: true } },
            facility: { select: { name: true } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  private toDto(row: {
    id: string;
    facilityId: string | null;
    closureDate: Date;
    expectedCash: Prisma.Decimal;
    countedCash: Prisma.Decimal;
    difference: Prisma.Decimal;
    notes: string | null;
    closedAt: Date;
    closedBy: { fullName: string } | null;
    facility: { name: string } | null;
  }): CashClosureDto {
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
    };
  }
}
