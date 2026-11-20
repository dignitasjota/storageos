import { Injectable } from '@nestjs/common';

import {
  contractWhere,
  LIVE_CONTRACT_WHERE,
  MONTHLY_FEE_SELECT,
  monthlyFee,
} from '../../analytics/analytics-scope';
import { PrismaService } from '../../database/prisma.service';

import {
  CONTRACT_STATUS_LABELS,
  CUSTOMER_NAME_SELECT,
  customerDisplay,
  dayLabel,
  eur,
  zonedDayKey,
} from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Contratos en vigor hoy, con la cuota que paga cada uno. */
@Injectable()
export class ContractsActiveGenerator implements ReportGenerator {
  readonly code = 'contracts_active';
  readonly name = 'Contratos en vigor';
  readonly description =
    'Los contratos en vigor hoy: inquilino, local, trastero, fecha de inicio y la cuota que paga al mes.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly requires = ['contracts:read'] as const as ['contracts:read'];
  readonly byFacility = true;
  readonly paramsSchema = {};

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          // Los mismos contratos que cuentan en «Cuotas al mes» del Resumen.
          where: { ...LIVE_CONTRACT_WHERE, ...contractWhere(ctx.scope) },
          select: {
            ...MONTHLY_FEE_SELECT,
            contractNumber: true,
            startDate: true,
            status: true,
            customer: { select: CUSTOMER_NAME_SELECT },
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
          orderBy: { startDate: 'asc' },
        }),
      ctx.tenantId,
    );
    let feeCents = 0;
    const out = rows.map((r) => {
      const fee = Math.round(monthlyFee(r) * 100);
      feeCents += fee;
      return {
        contractNumber: r.contractNumber,
        customerName: customerDisplay(r.customer),
        facilityName: r.unit.facility.name,
        unitCode: r.unit.code,
        startDate: r.startDate.toISOString().slice(0, 10),
        fee: fee / 100,
        status: CONTRACT_STATUS_LABELS[r.status] ?? r.status,
      };
    });
    return {
      title: 'Contratos en vigor',
      subtitle: `A ${dayLabel(zonedDayKey(new Date(), ctx.timezone))}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'contractNumber', label: 'Número', width: 16 },
        { key: 'customerName', label: 'Inquilino', width: 30 },
        { key: 'facilityName', label: 'Local', width: 20 },
        { key: 'unitCode', label: 'Trastero', width: 12 },
        { key: 'startDate', label: 'Inicio', type: 'date', width: 12 },
        { key: 'fee', label: 'Cuota al mes', type: 'currency', width: 14, align: 'right' },
        { key: 'status', label: 'Estado', width: 14 },
      ],
      rows: out,
      summary: [
        { label: 'Contratos en vigor', value: String(rows.length) },
        { label: 'Cuotas al mes (sin IVA)', value: eur(feeCents / 100) },
      ],
    };
  }
}
