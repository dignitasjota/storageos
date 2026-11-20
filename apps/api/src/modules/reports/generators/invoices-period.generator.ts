import { Injectable } from '@nestjs/common';

import { toCents } from '../../../common/money';
import { INVOICED_SELECT, invoicedAmount, invoicedWhere } from '../../analytics/business-metrics';
import { PrismaService } from '../../database/prisma.service';

import {
  CUSTOMER_NAME_SELECT,
  customerDisplay,
  dayLabel,
  dayRange,
  eur,
  INVOICE_STATUS_LABELS,
} from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Facturas emitidas entre dos fechas (sin borradores ni justificantes de fianza). */
@Injectable()
export class InvoicesPeriodGenerator implements ReportGenerator {
  readonly code = 'invoices_period';
  readonly name = 'Facturas emitidas en un periodo';
  readonly description =
    'Las facturas emitidas entre dos fechas, con su base, IVA, total, lo cobrado y lo que queda por cobrar.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly requires = ['invoices:read'] as const as ['invoices:read'];
  readonly byFacility = true;
  readonly paramsSchema = {
    from: { label: 'Desde', type: 'date' as const, required: true },
    to: { label: 'Hasta', type: 'date' as const, required: true },
  };

  constructor(private readonly prisma: PrismaService) {}

  validate(params: Record<string, unknown>): void {
    dayRange(params);
  }

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { from, to } = dayRange(ctx.params);
    const toExclusive = new Date(to.getTime() + 86_400_000);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          // Misma definición de «facturado» que el Resumen y Analítica: sin
          // borradores ni canceladas, y sin justificantes de fianza.
          where: invoicedWhere(ctx.scope, from, toExclusive),
          select: {
            ...INVOICED_SELECT,
            invoiceNumber: true,
            dueDate: true,
            status: true,
            taxAmount: true,
            amountPaid: true,
            customerNameSnapshot: true,
            customer: { select: CUSTOMER_NAME_SELECT },
          },
          orderBy: [{ issueDate: 'asc' }, { sequenceNumber: 'asc' }],
        }),
      ctx.tenantId,
    );

    let base = 0;
    let tax = 0;
    let invoiced = 0;
    let paid = 0;
    let pending = 0;
    const out = rows.map((r) => {
      const open = r.status === 'issued' || r.status === 'overdue';
      const pendingCents = open ? Math.max(0, toCents(r.total) - toCents(r.amountPaid)) : 0;
      base += toCents(r.subtotal);
      tax += toCents(r.taxAmount);
      invoiced += toCents(invoicedAmount(r));
      paid += toCents(r.amountPaid);
      pending += pendingCents;
      return {
        invoiceNumber: r.invoiceNumber ?? '—',
        issueDate: r.issueDate?.toISOString().slice(0, 10) ?? '',
        dueDate: r.dueDate?.toISOString().slice(0, 10) ?? '',
        customerName: r.customerNameSnapshot ?? customerDisplay(r.customer),
        base: Number(r.subtotal),
        tax: Number(r.taxAmount),
        total: Number(r.total),
        amountPaid: Number(r.amountPaid),
        pending: pendingCents / 100,
        status: INVOICE_STATUS_LABELS[r.status] ?? r.status,
      };
    });
    const total = rows.reduce((sum, r) => sum + toCents(r.total), 0);

    return {
      title: 'Facturas emitidas',
      subtitle: `${dayLabel(from)} – ${dayLabel(to)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'invoiceNumber', label: 'Número', width: 18 },
        { key: 'issueDate', label: 'Emisión', type: 'date', width: 12 },
        { key: 'dueDate', label: 'Vencimiento', type: 'date', width: 12 },
        { key: 'customerName', label: 'Cliente', width: 30 },
        { key: 'base', label: 'Base', type: 'currency', width: 12, align: 'right' },
        { key: 'tax', label: 'IVA', type: 'currency', width: 11, align: 'right' },
        { key: 'total', label: 'Total', type: 'currency', width: 12, align: 'right' },
        { key: 'amountPaid', label: 'Pagado', type: 'currency', width: 12, align: 'right' },
        { key: 'pending', label: 'Pendiente', type: 'currency', width: 12, align: 'right' },
        { key: 'status', label: 'Estado', width: 16 },
      ],
      rows: out,
      summary: [
        { label: 'Facturas', value: String(rows.length) },
        { label: 'Base', value: eur(base / 100) },
        { label: 'IVA', value: eur(tax / 100) },
        { label: 'Total', value: eur(total / 100) },
        // Una factura que sustituye a otra cuenta solo la diferencia.
        ...(invoiced !== total
          ? [
              {
                label: 'Facturado (sin contar dos veces las sustituidas)',
                value: eur(invoiced / 100),
              },
            ]
          : []),
        { label: 'Pagado', value: eur(paid / 100) },
        { label: 'Pendiente de cobro', value: eur(pending / 100) },
      ],
    };
  }
}
