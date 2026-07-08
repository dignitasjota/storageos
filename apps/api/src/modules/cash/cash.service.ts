import { ConflictException, Injectable } from '@nestjs/common';

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
 * al esperado (suma de pagos `cash` del día). Caja global del tenant, uno por día.
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

  async getDaySummary(tenantId: string, date: string): Promise<CashDaySummaryDto> {
    const { gte, lt } = this.dayRange(date);
    const [rows, closureRow] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.payment.groupBy({
            by: ['methodType'],
            where: { status: 'succeeded', paidAt: { gte, lt } },
            _sum: { amount: true },
            _count: { _all: true },
          }),
          tx.cashClosure.findFirst({
            where: { closureDate: gte },
            include: { closedBy: { select: { fullName: true } } },
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
    meta: RequestMeta;
  }): Promise<CashClosureDto> {
    const { gte } = this.dayRange(args.input.date);
    // Esperado = efectivo cobrado ese día (pagos `cash` succeeded).
    const summary = await this.getDaySummary(args.tenantId, args.input.date);
    if (summary.closure) {
      throw new ConflictException({
        code: 'day_already_closed',
        message: 'La caja de ese día ya está cerrada',
      });
    }
    const expected = summary.cash;
    const counted = args.input.countedCash;
    const difference = subtractAmounts(counted, expected);

    const created = await this.prisma.withTenant(
      (tx) =>
        tx.cashClosure.create({
          data: {
            tenantId: args.tenantId,
            closureDate: gte,
            expectedCash: expected,
            countedCash: counted,
            difference,
            notes: args.input.notes?.trim() || null,
            closedByUserId: args.userId,
          },
          include: { closedBy: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'cash.day_closed',
      entityType: 'CashClosure',
      entityId: created.id,
      changes: { date: args.input.date, expected, counted, difference },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async listClosures(tenantId: string): Promise<CashClosureDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.cashClosure.findMany({
          orderBy: { closureDate: 'desc' },
          take: 90,
          include: { closedBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  private toDto(row: {
    id: string;
    closureDate: Date;
    expectedCash: Prisma.Decimal;
    countedCash: Prisma.Decimal;
    difference: Prisma.Decimal;
    notes: string | null;
    closedAt: Date;
    closedBy: { fullName: string } | null;
  }): CashClosureDto {
    return {
      id: row.id,
      date: row.closureDate.toISOString().slice(0, 10),
      expectedCash: Number(row.expectedCash),
      countedCash: Number(row.countedCash),
      difference: Number(row.difference),
      notes: row.notes,
      closedByName: row.closedBy?.fullName ?? null,
      closedAt: row.closedAt.toISOString(),
    };
  }
}
