import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { OwnerStatementsService } from '../../owners/owner-statements.service';

import { eur, monthRange } from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** La liquidación de un propietario en un mes, para enviarla en PDF o Excel. */
@Injectable()
export class OwnerStatementGenerator implements ReportGenerator {
  readonly code = 'owner_statement';
  readonly name = 'Liquidación de un propietario';
  readonly description =
    'Lo cobrado de sus contratos en el mes, devoluciones, honorarios, gastos y lo que hay que transferirle.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly requires = ['invoices:read', 'payments:read'] as const as [
    'invoices:read',
    'payments:read',
  ];
  /** La liquidación es de todos los locales del propietario. */
  readonly companyWide = true;
  readonly paramsSchema = {
    ownerId: { label: 'Propietario', type: 'select' as const, required: true, options: [] },
    month: { label: 'Mes', type: 'period' as const, required: true },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: OwnerStatementsService,
  ) {}

  /** Solo aparece si el tenant tiene propietarios; las opciones son los suyos. */
  async loadOptions(tenantId: string) {
    const owners = await this.prisma.withTenant(
      (tx) =>
        tx.owner.findMany({
          where: { isActive: true },
          select: { id: true, legalName: true },
          orderBy: { legalName: 'asc' },
        }),
      tenantId,
    );
    if (owners.length === 0) return null;
    return { ownerId: owners.map((o) => ({ value: o.id, label: o.legalName })) };
  }

  validate(params: Record<string, unknown>): void {
    monthRange(params.month, 'Mes');
    if (typeof params.ownerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(params.ownerId)) {
      throw new BadRequestException({ code: 'invalid_owner', message: 'Elige un propietario' });
    }
  }

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { start, end, label } = monthRange(ctx.params.month, 'Mes');
    const last = new Date(end.getTime() - 86_400_000);
    const s = await this.statements.compute(
      ctx.tenantId,
      String(ctx.params.ownerId ?? ''),
      start.toISOString().slice(0, 10),
      last.toISOString().slice(0, 10),
    );
    const fee = Math.round((s.feeBase + s.feeVat) * 100) / 100;
    return {
      title: `Liquidación de ${s.ownerName}`,
      subtitle: `${label} · NIF ${s.ownerTaxId}${s.ownerIbanLast4 ? ` · cuenta …${s.ownerIbanLast4}` : ''}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'date', label: 'Fecha', width: 12 },
        { key: 'concept', label: 'Concepto', width: 40 },
        { key: 'detail', label: 'Detalle', width: 20 },
        { key: 'amount', label: 'Importe', type: 'currency', align: 'right' },
      ],
      rows: [
        ...s.payments.map((p) => ({
          date: p.date,
          concept: `Cobro ${p.invoiceNumber ?? ''} — ${p.customerName}`.trim(),
          detail: p.unitCode ?? '',
          amount: Math.round((p.amount - p.refunded) * 100) / 100,
        })),
        ...s.expenseLines.map((e) => ({
          date: e.date,
          concept: `Gasto: ${e.description}`,
          detail: e.facilityName ?? '',
          amount: -e.amount,
        })),
      ],
      summary: [
        { label: 'Cobrado', value: eur(s.collected) },
        { label: 'Devuelto', value: eur(-s.refunded) },
        { label: 'Honorarios (con IVA)', value: eur(-fee) },
        { label: 'Gastos', value: eur(-s.expenses) },
        ...(s.withholding > 0
          ? [{ label: 'IRPF retenido (informativo)', value: eur(s.withholding) }]
          : []),
        { label: 'A transferir', value: eur(s.net) },
      ],
    };
  }
}
