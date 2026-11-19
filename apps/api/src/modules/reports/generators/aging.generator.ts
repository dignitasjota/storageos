import { Injectable } from '@nestjs/common';

import { todayInTimezone, zonedNextDayStart } from '../../../common/format';
import { toCents } from '../../../common/money';
import { invoiceWhere } from '../../analytics/analytics-scope';
import { PrismaService } from '../../database/prisma.service';

import { CUSTOMER_NAME_SELECT, customerDisplay, dayLabel, dayParam, eur } from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

const BUCKETS = ['0-30 días', '31-60 días', '61-90 días', 'Más de 90 días'] as const;

function bucketOf(days: number): (typeof BUCKETS)[number] {
  if (days <= 30) return BUCKETS[0];
  if (days <= 60) return BUCKETS[1];
  if (days <= 90) return BUCKETS[2];
  return BUCKETS[3];
}

/**
 * Facturas vencidas y sin cobrar a una fecha, por antigüedad. Con una fecha
 * pasada se calcula con los cobros registrados hasta ese día (lo que se debía
 * entonces), no con el estado de hoy.
 */
@Injectable()
export class AgingGenerator implements ReportGenerator {
  readonly code = 'aging_at_date';
  readonly name = 'Facturas vencidas por antigüedad';
  readonly description =
    'Lo que te deben a una fecha: cada factura vencida con sus días de retraso, por tramos (0-30, 31-60, 61-90 y más de 90 días).';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly requires = ['invoices:read'] as const as ['invoices:read'];
  readonly byFacility = true;
  readonly paramsSchema = {
    atDate: { label: 'A fecha (vacío = hoy)', type: 'date' as const, required: false },
  };

  constructor(private readonly prisma: PrismaService) {}

  validate(params: Record<string, unknown>): void {
    if (params.atDate) dayParam(params.atDate, 'A fecha');
  }

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const today = todayInTimezone(ctx.timezone);
    const asked = ctx.params.atDate ? dayParam(ctx.params.atDate, 'A fecha') : today;
    // Una fecha futura no tiene sentido: se toma hoy.
    const at = asked > today ? today : asked;
    const past = at < today;
    const atKey = at.toISOString().slice(0, 10);
    // Fin de ese día en la zona del negocio (los cobros llevan hora).
    const cut = zonedNextDayStart(atKey, ctx.timezone);

    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            deletedAt: null,
            // Las fianzas no son deuda del alquiler.
            kind: 'invoice',
            dueDate: { lt: at },
            ...(past
              ? {
                  // Lo que estaba emitido ese día (las anuladas no se reclaman).
                  status: { notIn: ['draft', 'cancelled', 'rectified'] },
                  issueDate: { lte: at },
                }
              : { status: { in: ['issued', 'overdue', 'partially_refunded'] } }),
            ...invoiceWhere(ctx.scope),
          },
          select: {
            invoiceNumber: true,
            dueDate: true,
            total: true,
            amountPaid: true,
            paidAt: true,
            customerNameSnapshot: true,
            customer: { select: CUSTOMER_NAME_SELECT },
            ...(past
              ? {
                  payments: {
                    where: {
                      status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
                      paidAt: { lt: cut },
                    },
                    select: { amount: true },
                  },
                  _count: { select: { payments: true } },
                }
              : {}),
          },
        }),
      ctx.tenantId,
    );

    const day = 86_400_000;
    const buckets = new Map<string, { cents: number; count: number }>(
      BUCKETS.map((b) => [b, { cents: 0, count: 0 }]),
    );
    let totalCents = 0;
    const out = rows
      .map((r) => {
        let paidCents = toCents(r.amountPaid);
        if (past) {
          const payments = (r as { payments?: { amount: unknown }[] }).payments ?? [];
          const count = (r as { _count?: { payments: number } })._count?.payments ?? 0;
          paidCents =
            count > 0
              ? payments.reduce((sum, p) => sum + toCents(p.amount as number), 0)
              : // Sin cobros apuntados (datos antiguos): vale la fecha de pago.
                r.paidAt && r.paidAt < cut
                ? toCents(r.amountPaid)
                : 0;
        }
        const pendingCents = toCents(r.total) - paidCents;
        const days = Math.floor((at.getTime() - r.dueDate!.getTime()) / day);
        return { r, pendingCents, days };
      })
      .filter((x) => x.pendingCents > 0)
      .sort((a, b) => b.days - a.days)
      .map(({ r, pendingCents, days }) => {
        const bucket = bucketOf(days);
        const b = buckets.get(bucket)!;
        b.cents += pendingCents;
        b.count += 1;
        totalCents += pendingCents;
        return {
          invoiceNumber: r.invoiceNumber ?? '—',
          customerName: r.customerNameSnapshot ?? customerDisplay(r.customer),
          dueDate: r.dueDate!.toISOString().slice(0, 10),
          daysOverdue: days,
          bucket,
          pending: pendingCents / 100,
        };
      });

    return {
      title: 'Facturas vencidas por antigüedad',
      subtitle: past
        ? `A ${dayLabel(atKey)}, con los cobros registrados hasta ese día`
        : `A ${dayLabel(atKey)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'invoiceNumber', label: 'Número', width: 18 },
        { key: 'customerName', label: 'Inquilino', width: 30 },
        { key: 'dueDate', label: 'Vencimiento', type: 'date', width: 12 },
        { key: 'daysOverdue', label: 'Días de retraso', type: 'number', width: 14, align: 'right' },
        { key: 'bucket', label: 'Tramo', width: 16 },
        { key: 'pending', label: 'Pendiente', type: 'currency', width: 12, align: 'right' },
      ],
      rows: out,
      summary: [
        ...BUCKETS.map((b) => {
          const v = buckets.get(b)!;
          return {
            label: b,
            value: `${eur(v.cents / 100)} · ${v.count} ${v.count === 1 ? 'factura' : 'facturas'}`,
          };
        }),
        { label: 'Facturas vencidas', value: String(out.length) },
        { label: 'Total vencido', value: eur(totalCents / 100) },
      ],
    };
  }
}
