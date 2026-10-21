import { Injectable } from '@nestjs/common';
import {
  adPerformanceRatios,
  type AdPerformanceDto,
  type AdPerformanceFigures,
  type AdPerformanceRowDto,
} from '@storageos/shared';

import { PrismaService } from '../../database/prisma.service';

import { round2 } from './ad-stats';

const DAY_MS = 86_400_000;
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

/**
 * Rendimiento de las campañas de Google Ads y Meta Ads vinculadas a un canal:
 * lo que da la plataforma (impresiones, clics, gasto, conversiones) y lo que
 * pasa después en TrasterOS (contactos y reservas con el origen del canal).
 */
@Injectable()
export class AdPerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    tenantId: string,
    filters: { from?: string; to?: string },
  ): Promise<AdPerformanceDto> {
    const to = filters.to ?? isoDate(new Date());
    const from = filters.from ?? isoDate(new Date(asDate(to).getTime() - 29 * DAY_MS));
    const fromD = asDate(from);
    const toD = asDate(to);
    const toEnd = new Date(toD.getTime() + DAY_MS - 1);

    const data = await this.prisma.withTenant(async (tx) => {
      const channels = await tx.marketingChannel.findMany({
        where: { deletedAt: null, type: { in: ['google_ads', 'meta_ads'] } },
        select: {
          id: true,
          name: true,
          type: true,
          externalCampaignId: true,
          utmSourceMatch: true,
        },
        orderBy: { name: 'asc' },
      });
      const ids = channels.map((c) => c.id);
      const sources = channels
        .map((c) => c.utmSourceMatch?.toLowerCase())
        .filter((s): s is string => !!s);
      const [metrics, lastDates, expenses, leads] = await Promise.all([
        tx.adMetricDaily.groupBy({
          by: ['marketingChannelId'],
          where: { marketingChannelId: { in: ids }, date: { gte: fromD, lte: toD } },
          _sum: { impressions: true, clicks: true, cost: true, conversions: true },
          _count: { _all: true },
        }),
        tx.adMetricDaily.groupBy({
          by: ['marketingChannelId'],
          where: { marketingChannelId: { in: ids } },
          _max: { date: true },
        }),
        // Gasto de los canales sin métricas todavía (sincronizado antes de guardarlas).
        tx.expense.groupBy({
          by: ['marketingChannelId'],
          where: { marketingChannelId: { in: ids }, expenseDate: { gte: fromD, lte: toD } },
          _sum: { amount: true },
        }),
        sources.length
          ? tx.lead.findMany({
              where: {
                deletedAt: null,
                utmSource: { in: sources, mode: 'insensitive' },
                OR: [
                  { createdAt: { gte: fromD, lte: toEnd } },
                  { wonAt: { gte: fromD, lte: toEnd } },
                ],
              },
              select: { utmSource: true, createdAt: true, wonAt: true, convertedContractId: true },
            })
          : Promise.resolve([]),
      ]);
      const contractIds = leads
        .filter((l) => l.convertedContractId && l.wonAt && l.wonAt >= fromD && l.wonAt <= toEnd)
        .map((l) => l.convertedContractId!);
      const signed = contractIds.length
        ? await tx.contract.findMany({
            where: { id: { in: contractIds }, signedAt: { not: null } },
            select: { id: true },
          })
        : [];
      return { channels, metrics, lastDates, expenses, leads, signed };
    }, tenantId);

    const metricsBy = new Map(data.metrics.map((m) => [m.marketingChannelId, m]));
    const lastBy = new Map(data.lastDates.map((m) => [m.marketingChannelId, m._max.date]));
    const expenseBy = new Map(
      data.expenses.map((e) => [e.marketingChannelId, Number(e._sum.amount ?? 0)]),
    );
    const signedIds = new Set(data.signed.map((c) => c.id));
    const totals = empty();

    const rows: AdPerformanceRowDto[] = data.channels.map((c) => {
      const m = metricsBy.get(c.id);
      const f = empty();
      if (m) {
        f.impressions = m._sum.impressions ?? 0;
        f.clicks = m._sum.clicks ?? 0;
        f.cost = Number(m._sum.cost ?? 0);
        f.platformConversions = round2(Number(m._sum.conversions ?? 0));
      } else {
        f.cost = expenseBy.get(c.id) ?? 0;
      }
      const source = c.utmSourceMatch?.toLowerCase();
      const seen = new Set<string>();
      for (const l of source ? data.leads : []) {
        if (l.utmSource?.toLowerCase() !== source) continue;
        if (l.createdAt >= fromD && l.createdAt <= toEnd) f.contacts += 1;
        const cid = l.convertedContractId;
        if (cid && l.wonAt && l.wonAt >= fromD && l.wonAt <= toEnd && !seen.has(cid)) {
          seen.add(cid);
          f.bookings += 1;
          if (signedIds.has(cid)) f.signed += 1;
        }
      }
      f.cost = round2(f.cost);
      for (const k of Object.keys(totals) as (keyof AdPerformanceFigures)[]) totals[k] += f[k];
      const last = lastBy.get(c.id);
      return {
        channelId: c.id,
        channelName: c.name,
        platform: c.type as 'google_ads' | 'meta_ads',
        externalCampaignId: c.externalCampaignId,
        lastDataDate: last ? isoDate(last) : null,
        ...f,
        ...adPerformanceRatios(f),
      };
    });

    totals.cost = round2(totals.cost);
    totals.platformConversions = round2(totals.platformConversions);
    return {
      from,
      to,
      rows: rows.sort((a, b) => b.cost - a.cost || b.clicks - a.clicks),
      totals: { ...totals, ...adPerformanceRatios(totals) },
    };
  }
}
