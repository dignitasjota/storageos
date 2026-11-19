import { Injectable } from '@nestjs/common';

import { toCents } from '../../../common/money';
import { invoiceWhere } from '../../analytics/analytics-scope';
import { CASH_METHOD_WHERE, zonedMonthStart } from '../../analytics/business-metrics';
import { PrismaService } from '../../database/prisma.service';

import {
  CUSTOMER_NAME_SELECT,
  customerDisplay,
  dayLabel,
  eur,
  monthRange,
  PAYMENT_METHOD_LABELS,
  zonedDayKey,
} from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Cobros de un mes con su forma de pago. Las fianzas van aparte del total. */
@Injectable()
export class CollectionsMonthGenerator implements ReportGenerator {
  readonly code = 'collections_month';
  readonly name = 'Cobros del mes por forma de pago';
  readonly description =
    'Cada cobro del mes (tarjeta, domiciliación, transferencia, efectivo…) con su factura e inquilino, y el total por forma de pago. Las fianzas, aparte.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly requires = ['payments:read'] as const as ['payments:read'];
  readonly byFacility = true;
  readonly paramsSchema = {
    month: { label: 'Mes', type: 'period' as const, required: true },
  };

  constructor(private readonly prisma: PrismaService) {}

  validate(params: Record<string, unknown>): void {
    monthRange(params.month, 'Mes');
  }

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { start, label } = monthRange(ctx.params.month, 'Mes');
    // Los cobros tienen hora: el mes se cuenta en la zona del negocio.
    const tz = ctx.timezone;
    const from = zonedMonthStart(start.getUTCFullYear(), start.getUTCMonth() + 1, tz);
    const to = zonedMonthStart(start.getUTCFullYear(), start.getUTCMonth() + 2, tz);
    const payments = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where: {
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: from, lt: to },
            // Sin compensaciones ni fianzas aplicadas (no es dinero nuevo).
            methodType: CASH_METHOD_WHERE,
            invoice: invoiceWhere(ctx.scope),
          },
          select: {
            paidAt: true,
            amount: true,
            refundedAmount: true,
            methodType: true,
            invoice: { select: { invoiceNumber: true, kind: true, customerNameSnapshot: true } },
            customer: { select: CUSTOMER_NAME_SELECT },
          },
          orderBy: { paidAt: 'asc' },
        }),
      ctx.tenantId,
    );

    const byMethod = new Map<string, number>();
    let rentCents = 0;
    let depositCents = 0;
    const rows = payments.map((p) => {
      const cents = toCents(p.amount) - toCents(p.refundedAmount ?? 0);
      const deposit = p.invoice?.kind === 'deposit_receipt';
      const method = PAYMENT_METHOD_LABELS[p.methodType] ?? p.methodType;
      if (deposit) {
        depositCents += cents;
      } else {
        rentCents += cents;
        byMethod.set(method, (byMethod.get(method) ?? 0) + cents);
      }
      return {
        date: p.paidAt ? dayLabel(zonedDayKey(p.paidAt, tz)) : '—',
        invoice: p.invoice?.invoiceNumber ?? '—',
        concept: deposit ? 'Fianza' : 'Factura',
        customer: p.customer
          ? customerDisplay(p.customer)
          : (p.invoice?.customerNameSnapshot ?? '—'),
        method,
        amount: cents / 100,
      };
    });

    return {
      title: 'Cobros del mes',
      subtitle: label,
      generatedAt: new Date(),
      timezone: tz,
      columns: [
        { key: 'date', label: 'Fecha', width: 12 },
        { key: 'invoice', label: 'Documento', width: 20 },
        { key: 'concept', label: 'Concepto', width: 10 },
        { key: 'customer', label: 'Inquilino', width: 30 },
        { key: 'method', label: 'Forma de pago', width: 16 },
        { key: 'amount', label: 'Importe', type: 'currency', align: 'right' },
      ],
      rows,
      summary: [
        ...[...byMethod.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([method, cents]) => ({ label: method, value: eur(cents / 100) })),
        // El mismo «Cobrado» del Resumen: sin fianzas, que se devuelven.
        { label: 'Total cobrado (sin fianzas)', value: eur(rentCents / 100) },
        ...(depositCents !== 0
          ? [{ label: 'Fianzas recibidas (aparte)', value: eur(depositCents / 100) }]
          : []),
      ],
    };
  }
}
