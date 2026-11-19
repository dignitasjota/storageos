import { Injectable } from '@nestjs/common';

import { zonedDayStart, zonedNextDayStart } from '../../../common/format';
import {
  contractLifecycle,
  contractWhere,
  LIFECYCLE_SELECT,
  MONTHLY_FEE_SELECT,
  monthlyFee,
  REAL_CONTRACT_WHERE,
} from '../../analytics/analytics-scope';
import { PrismaService } from '../../database/prisma.service';

import {
  CUSTOMER_NAME_SELECT,
  customerDisplay,
  dayLabel,
  dayRange,
  decimal,
  eur,
  zonedDayKey,
} from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Contratos que terminaron o se cancelaron (ya en marcha) en un periodo. */
@Injectable()
export class MoveOutsPeriodGenerator implements ReportGenerator {
  readonly code = 'move_outs_period';
  readonly name = 'Bajas del periodo';
  readonly description =
    'Inquilinos que se fueron entre dos fechas: trastero, local, cuánto tiempo estuvieron y la cuota que pagaban.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly requires = ['contracts:read'] as const as ['contracts:read'];
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
    const { fromKey, toKey } = dayRange(ctx.params);
    // Las bajas llevan hora: los días se cuentan en la zona del negocio.
    const from = zonedDayStart(fromKey, ctx.timezone);
    const toExclusive = zonedNextDayStart(toKey, ctx.timezone);
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            status: { in: ['ended', 'cancelled'] },
            deletedAt: null,
            signedAt: { not: null },
            // Sin el inquilino de prueba de la puesta en marcha.
            ...REAL_CONTRACT_WHERE,
            ...contractWhere(ctx.scope),
            OR: [
              { endedAt: { gte: from, lt: toExclusive } },
              { cancelledAt: { gte: from, lt: toExclusive } },
            ],
          },
          select: {
            ...LIFECYCLE_SELECT,
            ...MONTHLY_FEE_SELECT,
            contractNumber: true,
            customer: { select: CUSTOMER_NAME_SELECT },
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
        }),
      ctx.tenantId,
    );

    let monthsSum = 0;
    let lostCents = 0;
    const rows = contracts
      .map((c) => ({ c, life: contractLifecycle(c) }))
      .filter((x) => x.life?.end && x.life.end >= from && x.life.end < toExclusive)
      .sort((a, b) => a.life!.end!.getTime() - b.life!.end!.getTime())
      .map(({ c, life }) => {
        const months = (life!.end!.getTime() - life!.begin.getTime()) / (30.44 * 86_400_000);
        const fee = Math.round(monthlyFee(c) * 100);
        monthsSum += months;
        lostCents += fee;
        return {
          date: dayLabel(zonedDayKey(life!.end!, ctx.timezone)),
          contract: c.contractNumber,
          customer: customerDisplay(c.customer),
          unit: c.unit.code,
          facility: c.unit.facility.name,
          type: c.status === 'cancelled' ? 'Cancelado' : 'Finalizado',
          months: Math.round(months * 10) / 10,
          price: fee / 100,
        };
      });

    return {
      title: 'Bajas del periodo',
      subtitle: `${dayLabel(fromKey)} – ${dayLabel(toKey)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'date', label: 'Fecha', width: 12 },
        { key: 'contract', label: 'Contrato', width: 16 },
        { key: 'customer', label: 'Inquilino', width: 26 },
        { key: 'unit', label: 'Trastero', width: 10 },
        { key: 'facility', label: 'Local', width: 18 },
        { key: 'type', label: 'Tipo', width: 12 },
        { key: 'months', label: 'Meses', type: 'number', align: 'right' },
        { key: 'price', label: 'Cuota al mes', type: 'currency', align: 'right' },
      ],
      rows,
      summary: [
        { label: 'Bajas', value: String(rows.length) },
        {
          label: 'Estancia media',
          value: rows.length === 0 ? '—' : `${decimal(monthsSum / rows.length)} meses`,
        },
        { label: 'Cuotas que se dejan de cobrar al mes', value: eur(lostCents / 100) },
      ],
    };
  }
}
