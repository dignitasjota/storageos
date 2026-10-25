import { Injectable } from '@nestjs/common';

import { zonedDayStart } from '../../../common/format';
import { PrismaService } from '../../database/prisma.service';

import { customerDisplay, eur, monthRange, PAYMENT_METHOD_LABELS } from './new-reports.helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Cobros de un mes con su forma de pago. */
@Injectable()
export class CollectionsMonthGenerator implements ReportGenerator {
  readonly code = 'collections_month';
  readonly name = 'Cobros del mes por forma de pago';
  readonly description =
    'Cada cobro del mes (tarjeta, domiciliación, transferencia, efectivo…) con su factura e inquilino, y el total por forma de pago.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly paramsSchema = {
    month: { label: 'Mes', type: 'period' as const, required: true },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { start, end, label } = monthRange(ctx.params.month, 'month');
    // Los cobros tienen hora: el mes se cuenta en hora de España.
    const tz = 'Europe/Madrid';
    const from = zonedDayStart(start.toISOString().slice(0, 10), tz);
    const to = zonedDayStart(end.toISOString().slice(0, 10), tz);
    const payments = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where: {
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: from, lt: to },
            methodType: { notIn: ['credit_note', 'withholding'] },
          },
          select: {
            paidAt: true,
            amount: true,
            refundedAmount: true,
            methodType: true,
            invoice: { select: { invoiceNumber: true } },
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
          orderBy: { paidAt: 'asc' },
        }),
      ctx.tenantId,
    );

    const byMethod = new Map<string, number>();
    let total = 0;
    const rows = payments.map((p) => {
      const amount = Number(p.amount) - Number(p.refundedAmount ?? 0);
      total += amount;
      const method = PAYMENT_METHOD_LABELS[p.methodType] ?? p.methodType;
      byMethod.set(method, (byMethod.get(method) ?? 0) + amount);
      return {
        date: p.paidAt ? p.paidAt.toLocaleDateString('es-ES', { timeZone: tz }) : '—',
        invoice: p.invoice?.invoiceNumber ?? '—',
        customer: customerDisplay(p.customer),
        method,
        amount: Math.round(amount * 100) / 100,
      };
    });

    return {
      title: 'Cobros del mes',
      subtitle: label,
      generatedAt: new Date(),
      columns: [
        { key: 'date', label: 'Fecha', width: 12 },
        { key: 'invoice', label: 'Factura', width: 18 },
        { key: 'customer', label: 'Inquilino', width: 30 },
        { key: 'method', label: 'Forma de pago', width: 16 },
        { key: 'amount', label: 'Importe', type: 'currency', align: 'right' },
      ],
      rows,
      summary: [
        ...[...byMethod.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([method, amount]) => ({ label: method, value: eur(amount) })),
        { label: 'Total cobrado', value: eur(total) },
      ],
    };
  }
}
