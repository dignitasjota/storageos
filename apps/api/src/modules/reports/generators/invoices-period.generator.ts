import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

@Injectable()
export class InvoicesPeriodGenerator implements ReportGenerator {
  readonly code = 'invoices_period';
  readonly name = 'Facturas emitidas en un periodo';
  readonly description = 'Lista de facturas emitidas/pagadas entre dos fechas, con total y estado.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly paramsSchema = {
    from: { label: 'Desde', type: 'date' as const, required: true },
    to: { label: 'Hasta', type: 'date' as const, required: true },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const from = parseDate(ctx.params.from, 'from');
    const to = parseDate(ctx.params.to, 'to');
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            issueDate: { gte: from, lte: to },
            status: { not: 'draft' },
            deletedAt: null,
          },
          include: { customer: true },
          orderBy: { issueDate: 'asc' },
        }),
      ctx.tenantId,
    );
    const totalAmount = rows.reduce((acc, r) => acc + Number(r.total), 0);
    return {
      title: 'Facturas emitidas',
      subtitle: `${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`,
      generatedAt: new Date(),
      columns: [
        { key: 'invoiceNumber', label: 'Número', width: 18 },
        { key: 'issueDate', label: 'Emisión', type: 'date', width: 12 },
        { key: 'dueDate', label: 'Vencimiento', type: 'date', width: 12 },
        { key: 'customerName', label: 'Cliente', width: 30 },
        { key: 'total', label: 'Total', type: 'currency', width: 12, align: 'right' },
        { key: 'amountPaid', label: 'Pagado', type: 'currency', width: 12, align: 'right' },
        { key: 'status', label: 'Estado', width: 14 },
      ],
      rows: rows.map((r) => ({
        invoiceNumber: r.invoiceNumber ?? '—',
        issueDate: r.issueDate?.toISOString().slice(0, 10) ?? '—',
        dueDate: r.dueDate?.toISOString().slice(0, 10) ?? '—',
        customerName: customerDisplay(r.customer),
        total: Number(r.total),
        amountPaid: Number(r.amountPaid),
        status: r.status,
      })),
      summary: [
        { label: 'Total facturas', value: String(rows.length) },
        {
          label: 'Importe total',
          value: totalAmount.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }),
        },
      ],
    };
  }
}

function parseDate(v: unknown, name: string): Date {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`Parametro ${name} debe ser YYYY-MM-DD`);
  }
  return new Date(`${v}T00:00:00.000Z`);
}

function customerDisplay(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return '—';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}
