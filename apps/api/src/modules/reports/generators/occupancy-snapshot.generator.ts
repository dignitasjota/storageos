import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

import { eur } from './new-reports.helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Ocupación de cada local hoy: trasteros por estado, % y cuota de los vivos. */
@Injectable()
export class OccupancySnapshotGenerator implements ReportGenerator {
  readonly code = 'occupancy_snapshot';
  readonly name = 'Ocupación por local';
  readonly description =
    'Trasteros ocupados, reservados, libres y fuera de servicio de cada local, con su ocupación y lo que facturan al mes.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly paramsSchema = {};

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { facilities, units, contracts } = await this.prisma.withTenant(async (tx) => {
      const [facilities, units, contracts] = await Promise.all([
        tx.facility.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        tx.unit.groupBy({ by: ['facilityId', 'status'], _count: { _all: true } }),
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, deletedAt: null },
          select: {
            priceMonthly: true,
            discountAmount: true,
            unit: { select: { facilityId: true } },
          },
        }),
      ]);
      return { facilities, units, contracts };
    }, ctx.tenantId);

    let totals = { total: 0, occupied: 0, mrr: 0 };
    const rows = facilities.map((f) => {
      const of = (status: string) =>
        units.find((u) => u.facilityId === f.id && u.status === status)?._count._all ?? 0;
      const total = units
        .filter((u) => u.facilityId === f.id)
        .reduce((sum, u) => sum + u._count._all, 0);
      const occupied = of('occupied');
      const reserved = of('reserved');
      const available = of('available');
      const mrr = contracts
        .filter((c) => c.unit.facilityId === f.id)
        .reduce(
          (sum, c) => sum + Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)),
          0,
        );
      totals = {
        total: totals.total + total,
        occupied: totals.occupied + occupied,
        mrr: totals.mrr + mrr,
      };
      return {
        facility: f.name,
        total,
        occupied,
        reserved,
        available,
        outOfService: total - occupied - reserved - available,
        occupancy: total === 0 ? '0 %' : `${Math.round((occupied / total) * 100)} %`,
        mrr: Math.round(mrr * 100) / 100,
      };
    });

    return {
      title: 'Ocupación por local',
      subtitle: `A ${new Date().toLocaleDateString('es-ES')}`,
      generatedAt: new Date(),
      columns: [
        { key: 'facility', label: 'Local', width: 26 },
        { key: 'total', label: 'Trasteros', type: 'number', align: 'right' },
        { key: 'occupied', label: 'Ocupados', type: 'number', align: 'right' },
        { key: 'reserved', label: 'Reservados', type: 'number', align: 'right' },
        { key: 'available', label: 'Libres', type: 'number', align: 'right' },
        { key: 'outOfService', label: 'Fuera de servicio', type: 'number', align: 'right' },
        { key: 'occupancy', label: 'Ocupación', align: 'right' },
        { key: 'mrr', label: 'Cuotas/mes', type: 'currency', align: 'right' },
      ],
      rows,
      summary: [
        {
          label: 'Ocupación total',
          value:
            totals.total === 0 ? '0 %' : `${Math.round((totals.occupied / totals.total) * 100)} %`,
        },
        { label: 'Cuotas al mes', value: eur(totals.mrr) },
      ],
    };
  }
}
