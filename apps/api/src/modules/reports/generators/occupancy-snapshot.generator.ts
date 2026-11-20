import { Injectable } from '@nestjs/common';

import {
  contractWhere,
  LIVE_CONTRACT_WHERE,
  MONTHLY_FEE_SELECT,
  monthlyFee,
} from '../../analytics/analytics-scope';
import { PrismaService } from '../../database/prisma.service';

import { dayLabel, eur, zonedDayKey } from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

/** Ocupación de cada local hoy: trasteros por estado, % y cuota de los vivos. */
@Injectable()
export class OccupancySnapshotGenerator implements ReportGenerator {
  readonly code = 'occupancy_snapshot';
  readonly name = 'Ocupación por local';
  readonly description =
    'Trasteros ocupados, reservados, libres y fuera de servicio de cada local, con su ocupación y las cuotas que suman al mes.';
  readonly formats = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
  readonly requires = ['units:read', 'contracts:read'] as const as ['units:read', 'contracts:read'];
  readonly byFacility = true;
  readonly paramsSchema = {};

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const inScope = ctx.scope.ids ? { in: ctx.scope.ids } : undefined;
    const { facilities, units, contracts } = await this.prisma.withTenant(async (tx) => {
      const [facilities, units, contracts] = await Promise.all([
        tx.facility.findMany({
          where: { deletedAt: null, ...(inScope ? { id: inScope } : {}) },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        tx.unit.groupBy({
          by: ['facilityId', 'status'],
          where: { facility: { deletedAt: null }, ...(inScope ? { facilityId: inScope } : {}) },
          _count: { _all: true },
        }),
        tx.contract.findMany({
          // Los mismos contratos que cuentan en «Cuotas al mes» del Resumen.
          where: { ...LIVE_CONTRACT_WHERE, ...contractWhere(ctx.scope) },
          select: { ...MONTHLY_FEE_SELECT, unit: { select: { facilityId: true } } },
        }),
      ]);
      return { facilities, units, contracts };
    }, ctx.tenantId);

    let totals = { total: 0, occupied: 0, feeCents: 0 };
    const rows = facilities.map((f) => {
      const of = (status: string) =>
        units.find((u) => u.facilityId === f.id && u.status === status)?._count._all ?? 0;
      const total = units
        .filter((u) => u.facilityId === f.id)
        .reduce((sum, u) => sum + u._count._all, 0);
      const occupied = of('occupied');
      const reserved = of('reserved');
      const available = of('available');
      const feeCents = contracts
        .filter((c) => c.unit.facilityId === f.id)
        .reduce((sum, c) => sum + Math.round(monthlyFee(c) * 100), 0);
      totals = {
        total: totals.total + total,
        occupied: totals.occupied + occupied,
        feeCents: totals.feeCents + feeCents,
      };
      return {
        facility: f.name,
        total,
        occupied,
        reserved,
        available,
        outOfService: total - occupied - reserved - available,
        occupancy: total === 0 ? '0 %' : `${Math.round((occupied / total) * 100)} %`,
        fee: feeCents / 100,
      };
    });

    return {
      title: 'Ocupación por local',
      subtitle: `A ${dayLabel(zonedDayKey(new Date(), ctx.timezone))}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'facility', label: 'Local', width: 26 },
        { key: 'total', label: 'Trasteros', type: 'number', align: 'right' },
        { key: 'occupied', label: 'Ocupados', type: 'number', align: 'right' },
        { key: 'reserved', label: 'Reservados', type: 'number', align: 'right' },
        { key: 'available', label: 'Libres', type: 'number', align: 'right' },
        { key: 'outOfService', label: 'Fuera de servicio', type: 'number', align: 'right' },
        { key: 'occupancy', label: 'Ocupación', align: 'right' },
        { key: 'fee', label: 'Cuotas al mes', type: 'currency', align: 'right' },
      ],
      rows,
      summary: [
        {
          label: 'Ocupación total',
          value:
            totals.total === 0 ? '0 %' : `${Math.round((totals.occupied / totals.total) * 100)} %`,
        },
        { label: 'Cuotas al mes (sin IVA)', value: eur(totals.feeCents / 100) },
      ],
    };
  }
}
