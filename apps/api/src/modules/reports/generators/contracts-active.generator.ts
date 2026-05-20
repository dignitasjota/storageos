import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

@Injectable()
export class ContractsActiveGenerator implements ReportGenerator {
  readonly code = 'contracts_active';
  readonly name = 'Contratos activos';
  readonly description = 'Snapshot de contratos vigentes con customer, unit y precio.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly paramsSchema = {};

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, deletedAt: null },
          include: {
            customer: true,
            unit: { include: { facility: { select: { name: true } } } },
          },
          orderBy: { startDate: 'asc' },
        }),
      ctx.tenantId,
    );
    const totalMrr = rows.reduce((acc, r) => acc + Number(r.priceMonthly), 0);
    return {
      title: 'Contratos activos',
      subtitle: `Generado ${new Date().toISOString().slice(0, 10)}`,
      generatedAt: new Date(),
      columns: [
        { key: 'contractNumber', label: 'Número', width: 16 },
        { key: 'customerName', label: 'Cliente', width: 30 },
        { key: 'facilityName', label: 'Facility', width: 20 },
        { key: 'unitCode', label: 'Trastero', width: 12 },
        { key: 'startDate', label: 'Inicio', type: 'date', width: 12 },
        { key: 'priceMonthly', label: 'Cuota', type: 'currency', width: 12, align: 'right' },
        { key: 'status', label: 'Estado', width: 12 },
      ],
      rows: rows.map((r) => ({
        contractNumber: r.contractNumber,
        customerName: customerDisplay(r.customer),
        facilityName: r.unit.facility.name,
        unitCode: r.unit.code,
        startDate: r.startDate.toISOString().slice(0, 10),
        priceMonthly: Number(r.priceMonthly),
        status: r.status,
      })),
      summary: [
        { label: 'Contratos vigentes', value: String(rows.length) },
        {
          label: 'MRR',
          value: totalMrr.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }),
        },
      ],
    };
  }
}

function customerDisplay(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}
