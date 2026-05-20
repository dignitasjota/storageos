import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

@Injectable()
export class AgingGenerator implements ReportGenerator {
  readonly code = 'aging_at_date';
  readonly name = 'Aging de facturas pendientes';
  readonly description = 'Facturas pendientes agrupadas por antiguedad (0-30, 30-60, 60-90, +90).';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly paramsSchema = {
    atDate: { label: 'Fecha de corte', type: 'date' as const, required: false },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const atDate =
      typeof ctx.params.atDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.atDate)
        ? new Date(`${ctx.params.atDate}T23:59:59.999Z`)
        : new Date();
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            status: { in: ['issued', 'overdue', 'partially_refunded'] },
            dueDate: { lt: atDate },
            deletedAt: null,
          },
          include: { customer: true },
        }),
      ctx.tenantId,
    );
    const day = 24 * 60 * 60 * 1000;
    const out = rows
      .filter((r) => r.dueDate)
      .map((r) => {
        const daysOverdue = Math.floor((atDate.getTime() - r.dueDate!.getTime()) / day);
        const pending = Number(r.total) - Number(r.amountPaid);
        return { row: r, daysOverdue, pending };
      })
      .filter((x) => x.pending > 0);
    const total = out.reduce((acc, x) => acc + x.pending, 0);
    return {
      title: 'Morosidad (aging)',
      subtitle: `Fecha de corte: ${atDate.toISOString().slice(0, 10)}`,
      generatedAt: new Date(),
      columns: [
        { key: 'invoiceNumber', label: 'Número', width: 18 },
        { key: 'customerName', label: 'Cliente', width: 30 },
        { key: 'dueDate', label: 'Vencimiento', type: 'date', width: 12 },
        { key: 'daysOverdue', label: 'Días vencida', type: 'number', width: 14, align: 'right' },
        { key: 'pending', label: 'Pendiente', type: 'currency', width: 12, align: 'right' },
      ],
      rows: out
        .sort((a, b) => b.daysOverdue - a.daysOverdue)
        .map((x) => ({
          invoiceNumber: x.row.invoiceNumber ?? '—',
          customerName: customerDisplay(x.row.customer),
          dueDate: x.row.dueDate!.toISOString().slice(0, 10),
          daysOverdue: x.daysOverdue,
          pending: x.pending,
        })),
      summary: [
        { label: 'Facturas pendientes', value: String(out.length) },
        {
          label: 'Importe total',
          value: total.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }),
        },
      ],
    };
  }
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
