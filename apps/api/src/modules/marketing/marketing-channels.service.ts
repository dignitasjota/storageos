import { randomBytes } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import { normalizeLeadSource } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type {
  CreateMarketingChannelInput,
  MarketingChannelDto,
  MarketingChannelStatus,
  MarketingChannelType,
  MarketingPerformanceDto,
  MarketingPerformanceRowDto,
  MarketingShortLinkResolveDto,
  UpdateMarketingChannelInput,
} from '@storageos/shared';

const num = (d: Prisma.Decimal | number): number => Number(d);
const round2 = (n: number): number => Math.round(n * 100) / 100;

const CHANNEL_INCLUDE = {
  facility: { select: { name: true } },
  promotion: { select: { code: true } },
} satisfies Prisma.MarketingChannelInclude;

type ChannelRow = Prisma.MarketingChannelGetPayload<{ include: typeof CHANNEL_INCLUDE }>;

const WEB_BASE_URL_FALLBACK = 'https://trasteros.pro';

@Injectable()
export class MarketingChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  async list(tenantId: string, status?: string): Promise<MarketingChannelDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.marketingChannel.findMany({
        where: { deletedAt: null, ...(status ? { status } : {}) },
        include: CHANNEL_INCLUDE,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });
      return rows.map((r) => this.toDto(r));
    }, tenantId);
  }

  async create(tenantId: string, input: CreateMarketingChannelInput): Promise<MarketingChannelDto> {
    // El enlace corto solo aporta valor a canales sin URL propia clicable
    // (publicidad física: carteles, flyers) — se genera siempre, es barato y
    // así el canal puede pasar a físico más tarde sin perder el enlace.
    const shortCode = await this.uniqueShortCode();
    const utmSourceMatch =
      input.utmSourceMatch?.trim() || normalizeLeadSource(input.name).slice(0, 60);
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.marketingChannel.create({
        data: {
          tenantId,
          facilityId: input.facilityId ?? null,
          promotionId: input.promotionId ?? null,
          type: input.type,
          name: input.name,
          status: input.status,
          externalUrl: input.externalUrl?.trim() || null,
          monthlyCost: input.monthlyCost ?? null,
          renewsOn: input.renewsOn ? new Date(`${input.renewsOn}T00:00:00.000Z`) : null,
          utmSourceMatch,
          externalCampaignId: input.externalCampaignId?.trim() || null,
          shortCode,
          notes: input.notes?.trim() || null,
        },
        include: CHANNEL_INCLUDE,
      });
      return this.toDto(row);
    }, tenantId);
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateMarketingChannelInput,
  ): Promise<MarketingChannelDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await tx.marketingChannel.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: 'marketing_channel_not_found',
          message: 'No encontrado',
        });
      }
      const data: Prisma.MarketingChannelUpdateInput = {};
      if (input.facilityId !== undefined) {
        data.facility = input.facilityId
          ? { connect: { id: input.facilityId } }
          : { disconnect: true };
      }
      if (input.promotionId !== undefined) {
        data.promotion = input.promotionId
          ? { connect: { id: input.promotionId } }
          : { disconnect: true };
      }
      if (input.type !== undefined) data.type = input.type;
      if (input.name !== undefined) data.name = input.name;
      if (input.status !== undefined) data.status = input.status;
      if (input.externalUrl !== undefined) data.externalUrl = input.externalUrl?.trim() || null;
      if (input.monthlyCost !== undefined) data.monthlyCost = input.monthlyCost ?? null;
      if (input.renewsOn !== undefined) {
        data.renewsOn = input.renewsOn ? new Date(`${input.renewsOn}T00:00:00.000Z`) : null;
      }
      if (input.utmSourceMatch !== undefined) {
        data.utmSourceMatch = input.utmSourceMatch?.trim() || null;
      }
      if (input.externalCampaignId !== undefined) {
        data.externalCampaignId = input.externalCampaignId?.trim() || null;
      }
      if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
      const row = await tx.marketingChannel.update({
        where: { id },
        data,
        include: CHANNEL_INCLUDE,
      });
      return this.toDto(row);
    }, tenantId);
  }

  /** Soft delete: conserva el histórico de gasto/rendimiento ya vinculado. */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const existing = await tx.marketingChannel.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: 'marketing_channel_not_found',
          message: 'No encontrado',
        });
      }
      await tx.marketingChannel.update({ where: { id }, data: { deletedAt: new Date() } });
    }, tenantId);
  }

  /**
   * Resuelve el enlace corto público `/g/<code>` (carteles/flyers): cuenta el
   * clic e indica a dónde redirigir — el booking del tenant (su dominio propio
   * si está verificado, si no la plataforma) con `utm_source`/`utm_medium` ya
   * puestos para que la reserva atribuya el lead a este canal.
   */
  async resolveShortLink(shortCode: string): Promise<MarketingShortLinkResolveDto> {
    const channel = await this.admin.marketingChannel.findUnique({
      where: { shortCode },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        utmSourceMatch: true,
        tenant: { select: { slug: true, customDomain: true, customDomainVerifiedAt: true } },
      },
    });
    if (!channel || channel.deletedAt || channel.status !== 'active') {
      throw new NotFoundException({
        code: 'short_link_not_found',
        message: 'Enlace no encontrado',
      });
    }
    // Best-effort: si el incremento falla no debe romper la redirección.
    await this.admin.marketingChannel
      .update({ where: { shortCode }, data: { clickCount: { increment: 1 } } })
      .catch(() => undefined);

    const utm = new URLSearchParams({
      utm_source: channel.utmSourceMatch ?? 'physical',
      utm_medium: 'physical',
      utm_campaign: channel.id,
    });
    const base =
      channel.tenant.customDomain && channel.tenant.customDomainVerifiedAt
        ? `https://${channel.tenant.customDomain}/reservar`
        : `${(process.env.WEB_BASE_URL || WEB_BASE_URL_FALLBACK).replace(/\/$/, '')}/book/${channel.tenant.slug}`;
    return { targetUrl: `${base}?${utm.toString()}` };
  }

  /**
   * Rendimiento por canal: coste (expenses vinculados) ↔ leads atribuidos
   * (comparando `leads.utmSource`/`leads.source` contra `utmSourceMatch`) ↔
   * conversión (`status='won'`) ↔ MRR vivo (contratos active/ending de esos
   * leads). `paybackMonths` = meses de cuota para recuperar el CAC.
   */
  async getPerformance(
    tenantId: string,
    filters: { from?: string; to?: string },
  ): Promise<MarketingPerformanceDto> {
    return this.prisma.withTenant(async (tx) => {
      const fromD = filters.from ? new Date(`${filters.from}T00:00:00.000Z`) : undefined;
      const toD = filters.to ? new Date(`${filters.to}T23:59:59.999Z`) : undefined;
      const dateFilter =
        fromD || toD
          ? { ...(fromD ? { gte: fromD } : {}), ...(toD ? { lte: toD } : {}) }
          : undefined;

      const channels = await tx.marketingChannel.findMany({ where: { deletedAt: null } });

      const [expenses, leads] = await Promise.all([
        tx.expense.findMany({
          where: {
            marketingChannelId: { not: null },
            ...(dateFilter ? { expenseDate: dateFilter } : {}),
          },
          select: { marketingChannelId: true, amount: true },
        }),
        tx.lead.findMany({
          where: { deletedAt: null, ...(dateFilter ? { createdAt: dateFilter } : {}) },
          select: { source: true, utmSource: true, status: true, convertedContractId: true },
        }),
      ]);

      const costByChannel = new Map<string, number>();
      for (const e of expenses) {
        const key = e.marketingChannelId!;
        costByChannel.set(key, (costByChannel.get(key) ?? 0) + num(e.amount));
      }

      const channelByMatch = new Map<string, string>();
      for (const c of channels) {
        if (c.utmSourceMatch) channelByMatch.set(c.utmSourceMatch.toLowerCase(), c.id);
      }

      const leadsByChannel = new Map<
        string,
        { total: number; won: number; wonContractIds: string[] }
      >();
      for (const l of leads) {
        const key = (l.utmSource ?? l.source ?? '').toLowerCase();
        const channelId = channelByMatch.get(key);
        if (!channelId) continue;
        const bucket = leadsByChannel.get(channelId) ?? { total: 0, won: 0, wonContractIds: [] };
        bucket.total += 1;
        if (l.status === 'won') {
          bucket.won += 1;
          if (l.convertedContractId) bucket.wonContractIds.push(l.convertedContractId);
        }
        leadsByChannel.set(channelId, bucket);
      }

      const allWonContractIds = [...leadsByChannel.values()].flatMap((b) => b.wonContractIds);
      const contracts = allWonContractIds.length
        ? await tx.contract.findMany({
            where: { id: { in: allWonContractIds }, status: { in: ['active', 'ending'] } },
            select: { id: true, priceMonthly: true, discountAmount: true },
          })
        : [];
      const mrrByContract = new Map(
        contracts.map((c) => [c.id, Math.max(0, num(c.priceMonthly) - num(c.discountAmount))]),
      );

      const rows: MarketingPerformanceRowDto[] = channels
        .map((c) => {
          const cost = round2(costByChannel.get(c.id) ?? 0);
          const bucket = leadsByChannel.get(c.id) ?? { total: 0, won: 0, wonContractIds: [] };
          const mrrGenerated = round2(
            bucket.wonContractIds.reduce((sum, id) => sum + (mrrByContract.get(id) ?? 0), 0),
          );
          const costPerLead = bucket.total > 0 ? round2(cost / bucket.total) : null;
          const cac = bucket.won > 0 ? round2(cost / bucket.won) : null;
          const avgMrrPerWon = bucket.won > 0 ? mrrGenerated / bucket.won : 0;
          const paybackMonths =
            cac !== null && avgMrrPerWon > 0 ? round2(cac / avgMrrPerWon) : null;
          return {
            channelId: c.id,
            channelName: c.name,
            type: c.type as MarketingChannelType,
            status: c.status as MarketingChannelStatus,
            cost,
            leadsCount: bucket.total,
            wonCount: bucket.won,
            costPerLead,
            cac,
            mrrGenerated,
            paybackMonths,
          };
        })
        .sort((a, b) => b.cost - a.cost || b.mrrGenerated - a.mrrGenerated);

      const totals = rows.reduce(
        (t, r) => ({
          cost: round2(t.cost + r.cost),
          leadsCount: t.leadsCount + r.leadsCount,
          wonCount: t.wonCount + r.wonCount,
          mrrGenerated: round2(t.mrrGenerated + r.mrrGenerated),
        }),
        { cost: 0, leadsCount: 0, wonCount: 0, mrrGenerated: 0 },
      );

      return { from: filters.from ?? '', to: filters.to ?? '', rows, totals };
    }, tenantId);
  }

  /** Genera un código corto único (reintenta ante colisión, protegido por índice único). */
  private async uniqueShortCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomBytes(6).toString('base64url').slice(0, 8);
      // El código corto es un espacio GLOBAL (ruta pública /g/<code>, sin
      // contexto de tenant) — se comprueba cruzando tenants vía el cliente admin.
      const taken = await this.admin.marketingChannel.findUnique({
        where: { shortCode: code },
        select: { id: true },
      });
      if (!taken) return code;
    }
    // Prácticamente inalcanzable (colisión 5 veces seguidas), pero deja el
    // índice único de la BD como red de seguridad final.
    return randomBytes(9).toString('base64url').slice(0, 12);
  }

  private toDto(r: ChannelRow): MarketingChannelDto {
    const base = process.env.WEB_BASE_URL || WEB_BASE_URL_FALLBACK;
    return {
      id: r.id,
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      promotionId: r.promotionId,
      promotionCode: r.promotion?.code ?? null,
      type: r.type as MarketingChannelType,
      name: r.name,
      status: r.status as MarketingChannelStatus,
      externalUrl: r.externalUrl,
      monthlyCost: r.monthlyCost !== null ? num(r.monthlyCost) : null,
      renewsOn: r.renewsOn ? r.renewsOn.toISOString().slice(0, 10) : null,
      utmSourceMatch: r.utmSourceMatch,
      externalCampaignId: r.externalCampaignId,
      shortCode: r.shortCode,
      shortUrl: r.shortCode ? `${base.replace(/\/$/, '')}/g/${r.shortCode}` : null,
      clickCount: r.clickCount,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
