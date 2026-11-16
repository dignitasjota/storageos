import { Injectable } from '@nestjs/common';
import {
  adPerformanceRatios,
  attributeChannel,
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
      // Todos los canales: un contacto va a uno solo (aunque no sea de anuncios).
      const allChannels = await tx.marketingChannel.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          externalCampaignId: true,
          externalUrl: true,
          utmSourceMatch: true,
          createdAt: true,
        },
        orderBy: { name: 'asc' },
      });
      const channels = allChannels.filter((c) => c.type === 'google_ads' || c.type === 'meta_ads');
      const ids = channels.map((c) => c.id);
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
        ids.length
          ? tx.lead.findMany({
              where: {
                deletedAt: null,
                utmSource: { not: null },
                OR: [
                  { createdAt: { gte: fromD, lte: toEnd } },
                  { wonAt: { gte: fromD, lte: toEnd } },
                  { bookedAt: { gte: fromD, lte: toEnd } },
                ],
              },
              select: {
                utmSource: true,
                utmMedium: true,
                utmCampaign: true,
                createdAt: true,
                wonAt: true,
                bookedAt: true,
                convertedContractId: true,
              },
            })
          : Promise.resolve([]),
      ]);
      const bookedIn = (l: { bookedAt: Date | null; wonAt: Date | null }) => {
        const at = l.bookedAt ?? l.wonAt;
        return !!at && at >= fromD && at <= toEnd;
      };
      const contractIds = leads
        .filter((l) => l.convertedContractId && bookedIn(l))
        .map((l) => l.convertedContractId!);
      const signed = contractIds.length
        ? await tx.contract.findMany({
            where: { id: { in: contractIds }, signedAt: { not: null } },
            select: { id: true },
          })
        : [];
      return { channels, allChannels, metrics, lastDates, expenses, leads, signed };
    }, tenantId);

    const metricsBy = new Map(data.metrics.map((m) => [m.marketingChannelId, m]));
    const lastBy = new Map(data.lastDates.map((m) => [m.marketingChannelId, m._max.date]));
    const expenseBy = new Map(
      data.expenses.map((e) => [e.marketingChannelId, Number(e._sum.amount ?? 0)]),
    );
    const signedIds = new Set(data.signed.map((c) => c.id));
    const totals = empty();
    // Canal de cada contacto (uno como mucho: así el total no cuenta doble).
    const leadsBy = new Map<string, typeof data.leads>();
    for (const l of data.leads) {
      const channel = attributeChannel(data.allChannels, {
        source: l.utmSource,
        medium: l.utmMedium,
        campaign: l.utmCampaign,
      });
      if (!channel) continue;
      leadsBy.set(channel.id, [...(leadsBy.get(channel.id) ?? []), l]);
    }

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
      const seen = new Set<string>();
      for (const l of leadsBy.get(c.id) ?? []) {
        if (l.createdAt >= fromD && l.createdAt <= toEnd) f.contacts += 1;
        const cid = l.convertedContractId;
        const bookedAt = l.bookedAt ?? l.wonAt;
        if (cid && bookedAt && bookedAt >= fromD && bookedAt <= toEnd && !seen.has(cid)) {
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
