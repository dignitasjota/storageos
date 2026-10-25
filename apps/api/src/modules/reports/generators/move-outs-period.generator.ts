import { Injectable } from '@nestjs/common';

import { contractLifecycle, LIFECYCLE_SELECT } from '../../analytics/analytics-scope';
import { PrismaService } from '../../database/prisma.service';

import { customerDisplay, dayParam } from './new-reports.helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Contratos que terminaron o se cancelaron (ya en marcha) en un periodo. */
@Injectable()
export class MoveOutsPeriodGenerator implements ReportGenerator {
  readonly code = 'move_outs_period';
  readonly name = 'Bajas del periodo';
  readonly description =
    'Inquilinos que se fueron entre dos fechas: trastero, local, cuánto tiempo estuvieron y cuota que pagaban.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly paramsSchema = {
    from: { label: 'Desde', type: 'date' as const, required: true },
    to: { label: 'Hasta', type: 'date' as const, required: true },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const from = dayParam(ctx.params.from, 'from');
    const to = dayParam(ctx.params.to, 'to');
    const toExclusive = new Date(to.getTime() + 86_400_000);
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            status: { in: ['ended', 'cancelled'] },
            deletedAt: null,
            signedAt: { not: null },
            OR: [
              { endedAt: { gte: from, lt: toExclusive } },
              { cancelledAt: { gte: from, lt: toExclusive } },
            ],
          },
          select: {
            ...LIFECYCLE_SELECT,
            contractNumber: true,
            priceMonthly: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
        }),
      ctx.tenantId,
    );

    let monthsSum = 0;
    let mrrLost = 0;
    const rows = contracts
      .map((c) => ({ c, life: contractLifecycle(c) }))
      .filter((x) => x.life?.end && x.life.end >= from && x.life.end < toExclusive)
      .sort((a, b) => a.life!.end!.getTime() - b.life!.end!.getTime())
      .map(({ c, life }) => {
        const months = (life!.end!.getTime() - life!.begin.getTime()) / (30.44 * 86_400_000);
        monthsSum += months;
        mrrLost += Number(c.priceMonthly);
        return {
          date: life!.end!.toLocaleDateString('es-ES'),
          contract: c.contractNumber,
          customer: customerDisplay(c.customer),
          unit: c.unit.code,
          facility: c.unit.facility.name,
          type: c.status === 'cancelled' ? 'Cancelado' : 'Finalizado',
          months: Math.round(months * 10) / 10,
          price: Number(c.priceMonthly),
        };
      });

    return {
      title: 'Bajas del periodo',
      subtitle: `${from.toLocaleDateString('es-ES')} → ${to.toLocaleDateString('es-ES')}`,
      generatedAt: new Date(),
      columns: [
        { key: 'date', label: 'Fecha', width: 12 },
        { key: 'contract', label: 'Contrato', width: 16 },
        { key: 'customer', label: 'Inquilino', width: 26 },
        { key: 'unit', label: 'Trastero', width: 10 },
        { key: 'facility', label: 'Local', width: 18 },
        { key: 'type', label: 'Tipo', width: 12 },
        { key: 'months', label: 'Meses', type: 'number', align: 'right' },
        { key: 'price', label: 'Cuota', type: 'currency', align: 'right' },
      ],
      rows,
      summary: [
        { label: 'Bajas', value: String(rows.length) },
        {
          label: 'Estancia media',
          value: rows.length === 0 ? '—' : `${(monthsSum / rows.length).toFixed(1)} meses`,
        },
        {
          label: 'Cuotas perdidas al mes',
          value: mrrLost.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }),
        },
      ],
    };
  }
}
