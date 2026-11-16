import { BadRequestException, Injectable } from '@nestjs/common';
import {
  adPerformanceRatios,
  attributeChannel,
  type AdPerformanceDto,
  type AdPerformanceFigures,
  type AdPerformanceRowDto,
} from '@storageos/shared';

import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../../common/format';
import { PrismaService } from '../../database/prisma.service';
import { FULL_MARKETING_VIEWER, type MarketingViewer } from '../marketing-viewer';

import { round2 } from './ad-stats';

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

const empty = (): AdPerformanceFigures => ({
  impressions: 0,
  clicks: 0,
  cost: 0,
  platformConversions: 0,
  contacts: 0,
  bookings: 0,
  signed: 0,
});

function assertDay(d: string | undefined): void {
  if (d === undefined) return;
  if (!DAY_RE.test(d) || Number.isNaN(asDate(d).getTime()) || isoDate(asDate(d)) !== d) {
    throw new BadRequestException({
      code: 'invalid_date',
      message: 'Fecha no válida (AAAA-MM-DD)',
    });
  }
}

/**
 * Rendimiento de las campañas de Google Ads y Meta Ads vinculadas a un canal:
 * lo que da la plataforma (impresiones, clics, gasto, conversiones) y lo que
 * pasa después en TrasterOS. Mismos criterios que Rendimiento:
 * - Contactos: los creados en el periodo.
 * - Reservas: las reservas online hechas en el periodo que siguen en pie (sin
 *   las caducadas ni las canceladas).
 * - Gasto: el de las métricas de cada día y, los días sin métricas, el de los
 *   gastos vinculados al canal.
 * Los días se cuentan en la zona del negocio.
 */
@Injectable()
export class AdPerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    tenantId: string,
    filters: { from?: string; to?: string },
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<AdPerformanceDto> {
    assertDay(filters.from);
    assertDay(filters.to);
    const scope = viewer.facilityScope;

    const data = await this.prisma.withTenant(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true },
        });
        const tz = tenant?.timezone || 'Europe/Madrid';
        const to = filters.to ?? isoDate(todayInTimezone(tz));
        const from = filters.from ?? isoDate(new Date(asDate(to).getTime() - 29 * DAY_MS));
        if (from > to) {
          throw new BadRequestException({
            code: 'invalid_date',
            message: 'La fecha de inicio va después de la de fin',
          });
        }
        const fromD = asDate(from);
        const toD = asDate(to);
        const since = zonedDayStart(from, tz);
        const until = zonedNextDayStart(to, tz);

        // Todos los canales: un contacto va a uno solo (aunque no sea de anuncios).
        const allChannels = await tx.marketingChannel.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            facilityId: true,
            externalCampaignId: true,
            externalUrl: true,
            utmSourceMatch: true,
            createdAt: true,
          },
          orderBy: { name: 'asc' },
        });
        const channels = allChannels.filter(
          (c) =>
            (c.type === 'google_ads' || c.type === 'meta_ads') &&
            (!scope || !c.facilityId || scope.includes(c.facilityId)),
        );
        const ids = channels.map((c) => c.id);
        const [metrics, lastDates, expenses, leads] = await Promise.all([
          tx.adMetricDaily.findMany({
            where: { marketingChannelId: { in: ids }, date: { gte: fromD, lte: toD } },
            select: {
              marketingChannelId: true,
              date: true,
              impressions: true,
              clicks: true,
              cost: true,
              conversions: true,
            },
          }),
          tx.adMetricDaily.groupBy({
            by: ['marketingChannelId'],
            where: { marketingChannelId: { in: ids } },
            _max: { date: true },
          }),
          tx.expense.groupBy({
            by: ['marketingChannelId', 'expenseDate'],
            where: { marketingChannelId: { in: ids }, expenseDate: { gte: fromD, lte: toD } },
            _sum: { amount: true },
          }),
          ids.length
            ? tx.lead.findMany({
                where: {
                  deletedAt: null,
                  utmSource: { not: null },
                  OR: [
                    { createdAt: { gte: since, lt: until } },
                    { bookedAt: { gte: since, lt: until } },
                  ],
                },
                select: {
                  utmSource: true,
                  utmMedium: true,
                  utmCampaign: true,
                  createdAt: true,
                  bookedAt: true,
                  convertedContractId: true,
                },
              })
            : Promise.resolve([]),
        ]);
        const bookedIds = leads
          .filter(
            (l) => l.convertedContractId && l.bookedAt && l.bookedAt >= since && l.bookedAt < until,
          )
          .map((l) => l.convertedContractId!);
        // Solo las reservas que siguen en pie: una caducada se cancela.
        const contracts = bookedIds.length
          ? await tx.contract.findMany({
              where: {
                id: { in: bookedIds },
                deletedAt: null,
                status: { not: 'cancelled' },
              },
              select: { id: true, signedAt: true },
            })
          : [];
        return {
          from,
          to,
          since,
          until,
          channels,
          allChannels,
          metrics,
          lastDates,
          expenses,
          leads,
          contracts,
        };
      },
      tenantId,
      { timeout: 20_000 },
    );

    const lastBy = new Map(data.lastDates.map((m) => [m.marketingChannelId, m._max.date]));
    const contractBy = new Map(data.contracts.map((c) => [c.id, c]));
    // Días con métricas de cada canal: su gasto sale de ahí, no de los gastos.
    const metricDays = new Map<string, Set<string>>();
    const figures = new Map<string, AdPerformanceFigures>();
    const fig = (id: string) => {
      let f = figures.get(id);
      if (!f) {
        f = empty();
        figures.set(id, f);
      }
      return f;
    };
    for (const m of data.metrics) {
      const f = fig(m.marketingChannelId);
      f.impressions += m.impressions;
      f.clicks += m.clicks;
      f.cost += Number(m.cost);
      f.platformConversions += Number(m.conversions);
      const set = metricDays.get(m.marketingChannelId) ?? new Set<string>();
      set.add(isoDate(m.date));
      metricDays.set(m.marketingChannelId, set);
    }
    for (const e of data.expenses) {
      if (!e.marketingChannelId) continue;
      if (metricDays.get(e.marketingChannelId)?.has(isoDate(e.expenseDate))) continue;
      fig(e.marketingChannelId).cost += Number(e._sum.amount ?? 0);
    }
    // Canal de cada contacto (uno como mucho: así el total no cuenta doble) y
    // cada reserva una vez aunque la compartan dos contactos.
    const counted = new Set<string>();
    for (const l of data.leads) {
      const channel = attributeChannel(data.allChannels, {
        source: l.utmSource,
        medium: l.utmMedium,
        campaign: l.utmCampaign,
      });
      if (!channel || !data.channels.some((c) => c.id === channel.id)) continue;
      const f = fig(channel.id);
      if (l.createdAt >= data.since && l.createdAt < data.until) f.contacts += 1;
      const contract = l.convertedContractId ? contractBy.get(l.convertedContractId) : undefined;
      if (
        contract &&
        !counted.has(contract.id) &&
        l.bookedAt &&
        l.bookedAt >= data.since &&
        l.bookedAt < data.until
      ) {
        counted.add(contract.id);
        f.bookings += 1;
        if (contract.signedAt) f.signed += 1;
      }
    }

    const totals = empty();
    const rows: AdPerformanceRowDto[] = data.channels.map((c) => {
      const f = { ...(figures.get(c.id) ?? empty()) };
      f.cost = viewer.cost ? round2(f.cost) : 0;
      f.platformConversions = round2(f.platformConversions);
      for (const k of Object.keys(totals) as (keyof AdPerformanceFigures)[]) totals[k] += f[k];
      const last = lastBy.get(c.id);
      const ratios = adPerformanceRatios(f);
      return {
        channelId: c.id,
        channelName: c.name,
        platform: c.type as 'google_ads' | 'meta_ads',
        externalCampaignId: c.externalCampaignId,
        lastDataDate: last ? isoDate(last) : null,
        ...f,
        ...(viewer.cost
          ? ratios
          : { ...ratios, cpc: null, costPerContact: null, costPerBooking: null }),
      };
    });

    totals.cost = round2(totals.cost);
    totals.platformConversions = round2(totals.platformConversions);
    const totalRatios = adPerformanceRatios(totals);
    return {
      from: data.from,
      to: data.to,
      rows: rows.sort((a, b) => b.cost - a.cost || b.clicks - a.clicks),
      totals: {
        ...totals,
        ...(viewer.cost
          ? totalRatios
          : { ...totalRatios, cpc: null, costPerContact: null, costPerBooking: null }),
      },
      money: { revenue: viewer.revenue, cost: viewer.cost },
    };
  }
}
