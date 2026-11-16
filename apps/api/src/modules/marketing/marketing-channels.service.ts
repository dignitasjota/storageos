import { createHash, randomBytes } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  attributeChannel,
  channelReportSource,
  channelSourceConflicts,
  defaultChannelSource,
  isBotUserAgent,
  normalizeLeadSource,
  promoCampaign,
  promoUtmMedium,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { assertFacilityAllowed, assertWholeBusiness } from '../../common/facility-scope';
import { zonedDayStart, zonedNextDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { QUEUE_BILLING } from '../queues/queues.module';

import { FULL_MARKETING_VIEWER, inViewerScope, type MarketingViewer } from './marketing-viewer';

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
const asDay = (d: string) => new Date(`${d}T00:00:00.000Z`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Un mismo visitante cuenta un clic del enlace corto cada 30 minutos. */
const CLICK_DEDUPE_SECONDS = 30 * 60;

const CHANNEL_INCLUDE = {
  facility: { select: { name: true } },
  promotion: { select: { code: true } },
  promoLanding: {
    select: {
      name: true,
      slug: true,
      shortPath: true,
      tenant: { select: { slug: true, customDomain: true, customDomainVerifiedAt: true } },
    },
  },
  tenant: { select: { customDomain: true, customDomainVerifiedAt: true } },
} satisfies Prisma.MarketingChannelInclude;

type ChannelRow = Prisma.MarketingChannelGetPayload<{ include: typeof CHANNEL_INCLUDE }>;

const WEB_BASE_URL_FALLBACK = 'https://trasteros.pro';

/** Quien abre un enlace corto (lo manda el servidor del web). */
export interface ShortLinkVisitor {
  ip?: string | undefined;
  userAgent?: string | undefined;
  /** false = no contar (una petición HEAD, que solo comprueba el enlace). */
  count?: boolean;
}

/** Lo que hace falta de un canal para saber el origen de sus enlaces. */
interface LinkChannel {
  id: string;
  name: string;
  type: string;
  status: string;
  utmSourceMatch: string | null;
  externalCampaignId: string | null;
  createdAt: Date;
}

/**
 * Origen que llevan los enlaces del canal: uno solo aunque recoja varios
 * (`facebook, instagram` no es un origen), el de su tipo en los de anuncios.
 */
function linkSource(channel: LinkChannel, fallback: string): string {
  return channelReportSource(channel) ?? fallback;
}

/** Dirección de una landing de promoción con las variables de seguimiento del canal. */
function promoLandingUrl(
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  slug: string,
  source: string,
  type: MarketingChannelType,
  shortPath = false,
): string {
  const ownDomain = !!(tenant.customDomain && tenant.customDomainVerifiedAt);
  const base = ownDomain
    ? `https://${tenant.customDomain}`
    : `${(process.env.WEB_BASE_URL || WEB_BASE_URL_FALLBACK).replace(/\/$/, '')}/s/${tenant.slug}`;
  const utm = new URLSearchParams({
    utm_source: source,
    utm_medium: promoUtmMedium(type),
    utm_campaign: promoCampaign(slug),
  });
  // Con dominio propio y dirección corta, el enlace usa `/<nombre>`.
  return `${base}${ownDomain && shortPath ? '' : '/promo'}/${slug}?${utm.toString()}`;
}

/** La landing debe ser del tenant (la transacción ya va con su RLS). */
async function assertPromoLanding(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const found = await tx.promoLanding.count({ where: { id } });
  if (found === 0) {
    throw new BadRequestException({
      code: 'promo_landing_not_found',
      message: 'La landing no existe',
    });
  }
}

/**
 * El local y la promoción tienen que ser de este negocio: la clave ajena de
 * Postgres no aplica RLS, así que sin esto se podía guardar el de otro.
 */
async function assertRefs(
  tx: Prisma.TransactionClient,
  refs: { facilityId?: string | null; promotionId?: string | null },
): Promise<void> {
  if (refs.facilityId) {
    const found = await tx.facility.count({ where: { id: refs.facilityId, deletedAt: null } });
    if (found === 0) {
      throw new BadRequestException({ code: 'facility_not_found', message: 'El local no existe' });
    }
  }
  if (refs.promotionId) {
    const found = await tx.promotion.count({ where: { id: refs.promotionId } });
    if (found === 0) {
      throw new BadRequestException({
        code: 'promotion_not_found',
        message: 'La promoción no existe',
      });
    }
  }
}

/** Una campaña de Google Ads o Meta Ads solo puede estar en un canal (su gasto iría a los dos). */
async function assertCampaignFree(
  tx: Prisma.TransactionClient,
  type: string,
  campaignId: string | null,
  exceptId?: string,
): Promise<void> {
  if (!campaignId || (type !== 'google_ads' && type !== 'meta_ads')) return;
  const other = await tx.marketingChannel.findFirst({
    where: {
      deletedAt: null,
      type,
      externalCampaignId: campaignId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { name: true },
  });
  if (other) {
    throw new ConflictException({
      code: 'external_campaign_taken',
      message: `Esa campaña ya está en el canal «${other.name}»`,
    });
  }
}

/** Quien solo ve unos locales gestiona los canales de esos locales; los de todo el negocio, no. */
function assertChannelScope(viewer: MarketingViewer, facilityId: string | null): void {
  if (facilityId) assertFacilityAllowed(viewer.facilityScope, facilityId);
  else assertWholeBusiness(viewer.facilityScope);
}

function assertReportDay(d: string | undefined): void {
  if (d === undefined) return;
  const date = asDay(d);
  if (!DAY_RE.test(d) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== d) {
    throw new BadRequestException({
      code: 'invalid_date',
      message: 'Fecha no válida (AAAA-MM-DD)',
    });
  }
}

@Injectable()
export class MarketingChannelsService {
  private readonly logger = new Logger(MarketingChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
  ) {}

  async list(
    tenantId: string,
    status?: string,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<MarketingChannelDto[]> {
    const scope = viewer.facilityScope;
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.marketingChannel.findMany({
        where: {
          deletedAt: null,
          ...(status ? { status } : {}),
          // Con alcance por local: los de sus locales y los de todo el negocio.
          ...(scope ? { OR: [{ facilityId: null }, { facilityId: { in: scope } }] } : {}),
        },
        include: CHANNEL_INCLUDE,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });
      const conflicts = await this.conflicts(tx);
      return rows.map((r) => this.toDto(r, conflicts.get(r.id) ?? null, viewer));
    }, tenantId);
  }

  async create(
    tenantId: string,
    input: CreateMarketingChannelInput,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<MarketingChannelDto> {
    assertChannelScope(viewer, input.facilityId ?? null);
    // El enlace corto solo aporta valor a canales sin URL propia clicable
    // (publicidad física: carteles, flyers) — se genera siempre, es barato y
    // así el canal puede pasar a físico más tarde sin perder el enlace.
    const shortCode = await this.uniqueShortCode();
    // Sin origen escrito: el de su tipo (Google Ads → `google`…) o el nombre.
    const utmSourceMatch =
      input.utmSourceMatch?.trim() ||
      defaultChannelSource({
        type: input.type,
        name: input.name,
        externalUrl: input.externalUrl ?? null,
        fallback: normalizeLeadSource(input.name).slice(0, 60),
      });
    const campaignId = input.externalCampaignId?.trim() || null;
    return this.prisma.withTenant(async (tx) => {
      await assertRefs(tx, {
        facilityId: input.facilityId ?? null,
        promotionId: input.promotionId ?? null,
      });
      if (input.promoLandingId) await assertPromoLanding(tx, input.promoLandingId);
      await assertCampaignFree(tx, input.type, campaignId);
      const row = await tx.marketingChannel.create({
        data: {
          tenantId,
          facilityId: input.facilityId ?? null,
          promotionId: input.promotionId ?? null,
          promoLandingId: input.promoLandingId ?? null,
          type: input.type,
          name: input.name,
          status: input.status,
          externalUrl: input.externalUrl?.trim() || null,
          monthlyCost: input.monthlyCost ?? null,
          renewsOn: input.renewsOn ? asDay(input.renewsOn) : null,
          renewalMonths: input.renewalMonths ?? null,
          utmSourceMatch,
          externalCampaignId: campaignId,
          shortCode,
          notes: input.notes?.trim() || null,
        },
        include: CHANNEL_INCLUDE,
      });
      return this.toDto(row, (await this.conflicts(tx)).get(row.id) ?? null, viewer);
    }, tenantId);
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateMarketingChannelInput,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<MarketingChannelDto> {
    return this.prisma.withTenant(async (tx) => {
      const existing = await tx.marketingChannel.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          type: true,
          facilityId: true,
          externalCampaignId: true,
          renewsOn: true,
        },
      });
      if (!existing || !inViewerScope(viewer, existing.facilityId)) {
        throw new NotFoundException({
          code: 'marketing_channel_not_found',
          message: 'No encontrado',
        });
      }
      assertChannelScope(viewer, existing.facilityId);
      if (input.facilityId !== undefined) assertChannelScope(viewer, input.facilityId ?? null);
      await assertRefs(tx, {
        ...(input.facilityId !== undefined ? { facilityId: input.facilityId } : {}),
        ...(input.promotionId !== undefined ? { promotionId: input.promotionId } : {}),
      });
      const type = input.type ?? existing.type;
      const campaignId =
        input.externalCampaignId !== undefined
          ? input.externalCampaignId?.trim() || null
          : existing.externalCampaignId;
      if (input.externalCampaignId !== undefined || input.type !== undefined) {
        await assertCampaignFree(tx, type, campaignId, id);
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
      if (input.promoLandingId !== undefined) {
        if (input.promoLandingId) await assertPromoLanding(tx, input.promoLandingId);
        data.promoLanding = input.promoLandingId
          ? { connect: { id: input.promoLandingId } }
          : { disconnect: true };
      }
      if (input.type !== undefined) data.type = input.type;
      if (input.name !== undefined) data.name = input.name;
      if (input.status !== undefined) data.status = input.status;
      if (input.externalUrl !== undefined) data.externalUrl = input.externalUrl?.trim() || null;
      // null lo borra (antes no había forma de quitarlo).
      if (input.monthlyCost !== undefined) data.monthlyCost = input.monthlyCost ?? null;
      if (input.renewsOn !== undefined) {
        const renewsOn = input.renewsOn ? asDay(input.renewsOn) : null;
        data.renewsOn = renewsOn;
        // Fecha nueva: se avisará de ella.
        if (renewsOn?.getTime() !== existing.renewsOn?.getTime()) data.renewalNotifiedOn = null;
      }
      if (input.renewalMonths !== undefined) data.renewalMonths = input.renewalMonths ?? null;
      if (input.utmSourceMatch !== undefined) {
        data.utmSourceMatch = input.utmSourceMatch?.trim() || null;
      }
      if (input.externalCampaignId !== undefined) {
        data.externalCampaignId = campaignId;
        // Otra campaña: el estado de la sincronización era de la anterior.
        if (campaignId !== existing.externalCampaignId) {
          data.lastSyncAt = null;
          data.lastSyncError = null;
          data.syncFailingSince = null;
          data.syncFailureNotifiedAt = null;
        }
      }
      if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
      const row = await tx.marketingChannel.update({
        where: { id },
        data,
        include: CHANNEL_INCLUDE,
      });
      return this.toDto(row, (await this.conflicts(tx)).get(row.id) ?? null, viewer);
    }, tenantId);
  }

  /**
   * Borrado lógico: conserva el gasto y los resultados ya vinculados (salen en
   * Rendimiento como «borrado») y su QR sigue llevando a la web sin contar. Sus
   * gastos recurrentes se pausan: si no, se seguían generando.
   */
  async remove(
    tenantId: string,
    id: string,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const existing = await tx.marketingChannel.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, facilityId: true },
      });
      if (!existing || !inViewerScope(viewer, existing.facilityId)) {
        throw new NotFoundException({
          code: 'marketing_channel_not_found',
          message: 'No encontrado',
        });
      }
      assertChannelScope(viewer, existing.facilityId);
      await tx.marketingChannel.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.recurringExpense.updateMany({
        where: { marketingChannelId: id, active: true },
        data: { active: false },
      });
    }, tenantId);
  }

  /**
   * Resuelve el enlace corto público `/g/<code>` (carteles, flyers, QR) y dice
   * a dónde redirigir: la landing del canal o la reserva del negocio, con su
   * origen ya puesto para que la reserva se atribuya al canal.
   *
   * Un canal pausado, finalizado o borrado sigue llevando a la web (el papel
   * sigue en la calle) pero no cuenta el clic. Tampoco cuentan los robots, las
   * vistas previas de WhatsApp o Facebook, las peticiones que solo comprueban
   * el enlace ni el mismo visitante dos veces en 30 minutos.
   */
  async resolveShortLink(
    shortCode: string,
    /** Si llega desde un dominio propio: el enlace tiene que ser de ese negocio. */
    tenantSlug?: string,
    visitor: ShortLinkVisitor = {},
  ): Promise<MarketingShortLinkResolveDto> {
    const channel = await this.admin.marketingChannel.findUnique({
      where: { shortCode },
      select: {
        id: true,
        name: true,
        status: true,
        deletedAt: true,
        type: true,
        utmSourceMatch: true,
        externalCampaignId: true,
        createdAt: true,
        tenant: {
          select: {
            slug: true,
            customDomain: true,
            customDomainVerifiedAt: true,
            deletedAt: true,
            status: true,
          },
        },
        promoLanding: { select: { slug: true, shortPath: true } },
      },
    });
    if (
      !channel ||
      channel.tenant.deletedAt ||
      channel.tenant.status === 'cancelled' ||
      (tenantSlug && channel.tenant.slug !== tenantSlug)
    ) {
      throw new NotFoundException({
        code: 'short_link_not_found',
        message: 'Enlace no encontrado',
      });
    }
    const live = !channel.deletedAt && channel.status === 'active';
    if (
      live &&
      visitor.count !== false &&
      !isBotUserAgent(visitor.userAgent) &&
      (await this.firstClick(channel.id, visitor.ip))
    ) {
      // Best-effort: si el incremento falla no debe romper la redirección.
      await this.admin.marketingChannel
        .update({ where: { id: channel.id }, data: { clickCount: { increment: 1 } } })
        .catch(() => undefined);
    }

    // Canal ligado a una landing de promoción: el enlace corto / QR lleva allí.
    if (channel.promoLanding) {
      return {
        targetUrl: promoLandingUrl(
          channel.tenant,
          channel.promoLanding.slug,
          linkSource(channel, 'web'),
          channel.type as MarketingChannelType,
          channel.promoLanding.shortPath,
        ),
      };
    }
    const utm = new URLSearchParams({
      utm_source: linkSource(channel, 'physical'),
      utm_medium: promoUtmMedium(channel.type as MarketingChannelType),
      utm_campaign: channel.id,
    });
    const base =
      channel.tenant.customDomain && channel.tenant.customDomainVerifiedAt
        ? `https://${channel.tenant.customDomain}/reservar`
        : `${(process.env.WEB_BASE_URL || WEB_BASE_URL_FALLBACK).replace(/\/$/, '')}/book/${channel.tenant.slug}`;
    return { targetUrl: `${base}?${utm.toString()}` };
  }

  /** ¿Primer clic de este visitante en 30 minutos? Sin IP o sin Redis, sí. */
  private async firstClick(channelId: string, ip: string | undefined): Promise<boolean> {
    if (!ip) return true;
    try {
      const client = await this.queue.client;
      const hashed = createHash('sha256').update(ip).digest('hex').slice(0, 24);
      const set = await client.set(
        `mk:click:${channelId}:${hashed}`,
        '1',
        'EX',
        CLICK_DEDUPE_SECONDS,
        'NX',
      );
      return set === 'OK';
    } catch (err) {
      this.logger.warn(
        `[short-link] sin Redis para no repetir clics: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  /**
   * Rendimiento por canal en un periodo (días en la zona del negocio):
   * - Coste: los gastos vinculados al canal.
   * - Contactos: los creados en el periodo y atribuidos al canal.
   * - Clientes: los contratos firmados en el periodo (sin cancelar) de
   *   contactos del canal, o con la promoción del canal si no llegaron por
   *   ningún canal (flyers, buzoneo: el cliente llama o va al local).
   * - Cuota y payback: con los clientes que siguen.
   * Los canales borrados salen si tuvieron gasto o resultados en el periodo.
   */
  async getPerformance(
    tenantId: string,
    filters: { from?: string; to?: string },
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<MarketingPerformanceDto> {
    assertReportDay(filters.from);
    assertReportDay(filters.to);
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new BadRequestException({
        code: 'invalid_date',
        message: 'La fecha de inicio va después de la de fin',
      });
    }
    const scope = viewer.facilityScope;
    const facilityIn = scope ? { OR: [{ facilityId: null }, { facilityId: { in: scope } }] } : {};
    return this.prisma.withTenant(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true },
        });
        const tz = tenant?.timezone || 'Europe/Madrid';
        const since = filters.from ? zonedDayStart(filters.from, tz) : undefined;
        const until = filters.to ? zonedNextDayStart(filters.to, tz) : undefined;
        const at =
          since || until
            ? { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) }
            : undefined;
        const days =
          filters.from || filters.to
            ? {
                ...(filters.from ? { gte: asDay(filters.from) } : {}),
                ...(filters.to ? { lte: asDay(filters.to) } : {}),
              }
            : undefined;

        // También los borrados: su gasto y sus clientes no desaparecen del informe.
        const channels = await tx.marketingChannel.findMany({
          where: facilityIn,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            utmSourceMatch: true,
            externalCampaignId: true,
            externalUrl: true,
            createdAt: true,
            deletedAt: true,
            promotionId: true,
          },
        });

        const [expenses, unassigned, leads, contracts] = await Promise.all([
          viewer.cost
            ? tx.expense.groupBy({
                by: ['marketingChannelId'],
                where: {
                  marketingChannelId: { not: null },
                  ...(days ? { expenseDate: days } : {}),
                  ...facilityIn,
                },
                _sum: { amount: true },
              })
            : Promise.resolve([]),
          viewer.cost
            ? tx.expense.aggregate({
                where: {
                  category: 'marketing',
                  marketingChannelId: null,
                  ...(days ? { expenseDate: days } : {}),
                  ...facilityIn,
                },
                _sum: { amount: true },
              })
            : Promise.resolve({ _sum: { amount: null } }),
          tx.lead.findMany({
            where: {
              deletedAt: null,
              ...(at ? { createdAt: at } : {}),
              ...(scope
                ? {
                    OR: [{ preferredFacilityId: null }, { preferredFacilityId: { in: scope } }],
                  }
                : {}),
            },
            select: { source: true, utmSource: true, utmMedium: true, utmCampaign: true },
          }),
          tx.contract.findMany({
            where: {
              deletedAt: null,
              signedAt: at ?? { not: null },
              status: { not: 'cancelled' },
              ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
            },
            select: {
              id: true,
              status: true,
              promotionId: true,
              priceMonthly: true,
              discountAmount: true,
            },
          }),
        ]);
        const wonLeads = contracts.length
          ? await tx.lead.findMany({
              where: {
                deletedAt: null,
                convertedContractId: { in: contracts.map((c) => c.id) },
              },
              select: {
                convertedContractId: true,
                source: true,
                utmSource: true,
                utmMedium: true,
                utmCampaign: true,
              },
            })
          : [];

        const touch = (l: {
          source: string;
          utmSource: string | null;
          utmMedium: string | null;
          utmCampaign: string | null;
        }) => ({ source: l.utmSource ?? l.source, medium: l.utmMedium, campaign: l.utmCampaign });

        const leadsBy = new Map<string, number>();
        for (const l of leads) {
          const channel = attributeChannel(channels, touch(l));
          if (channel) leadsBy.set(channel.id, (leadsBy.get(channel.id) ?? 0) + 1);
        }
        // Cada cliente, a un canal: el de su contacto o, sin él, el de su promoción.
        const contractChannel = new Map<string, string>();
        for (const l of wonLeads) {
          const cid = l.convertedContractId!;
          if (contractChannel.has(cid)) continue;
          const channel = attributeChannel(channels, touch(l));
          if (channel) contractChannel.set(cid, channel.id);
        }
        const byPromotion = new Map<string, string>();
        const promoChannels = channels
          .filter((c) => c.promotionId && !c.deletedAt)
          .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active'));
        for (const c of promoChannels) {
          if (!byPromotion.has(c.promotionId!)) byPromotion.set(c.promotionId!, c.id);
        }
        for (const c of contracts) {
          if (contractChannel.has(c.id) || !c.promotionId) continue;
          const channelId = byPromotion.get(c.promotionId);
          if (channelId) contractChannel.set(c.id, channelId);
        }
        const contractById = new Map(contracts.map((c) => [c.id, c]));
        const wonBy = new Map<string, string[]>();
        for (const [cid, channelId] of contractChannel) {
          wonBy.set(channelId, [...(wonBy.get(channelId) ?? []), cid]);
        }
        const costBy = new Map(
          expenses.map((e) => [e.marketingChannelId!, num(e._sum.amount ?? 0)]),
        );

        const rows: MarketingPerformanceRowDto[] = channels
          .map((c) => {
            const cost = viewer.cost ? round2(costBy.get(c.id) ?? 0) : 0;
            const leadsCount = leadsBy.get(c.id) ?? 0;
            const won = wonBy.get(c.id) ?? [];
            let mrr = 0;
            let live = 0;
            for (const cid of won) {
              const k = contractById.get(cid);
              if (k && (k.status === 'active' || k.status === 'ending')) {
                live += 1;
                mrr += Math.max(0, num(k.priceMonthly) - num(k.discountAmount));
              }
            }
            const cac = viewer.cost && won.length > 0 ? round2(cost / won.length) : null;
            const avgMrr = live > 0 ? mrr / live : 0;
            return {
              channelId: c.id,
              channelName: c.name,
              type: c.type as MarketingChannelType,
              status: c.status as MarketingChannelStatus,
              deleted: !!c.deletedAt,
              cost,
              leadsCount,
              wonCount: won.length,
              costPerLead: viewer.cost && leadsCount > 0 ? round2(cost / leadsCount) : null,
              cac,
              mrrGenerated: viewer.revenue ? round2(mrr) : 0,
              liveCount: live,
              paybackMonths:
                viewer.cost && viewer.revenue && cac !== null && avgMrr > 0
                  ? round2(cac / avgMrr)
                  : null,
            };
          })
          .filter((r) => !r.deleted || r.cost > 0 || r.leadsCount > 0 || r.wonCount > 0)
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

        return {
          from: filters.from ?? '',
          to: filters.to ?? '',
          rows,
          totals,
          unassignedCost: viewer.cost ? round2(num(unassigned._sum.amount ?? 0)) : 0,
          money: { revenue: viewer.revenue, cost: viewer.cost },
        };
      },
      tenantId,
      { timeout: 20_000 },
    );
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

  /** Canales que comparten origen con otro (nombre del otro). */
  private async conflicts(tx: Prisma.TransactionClient): Promise<Map<string, string>> {
    const all = await tx.marketingChannel.findMany({
      where: { deletedAt: null, status: { not: 'ended' } },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        utmSourceMatch: true,
        externalCampaignId: true,
        externalUrl: true,
        createdAt: true,
      },
    });
    return channelSourceConflicts(all);
  }

  private toDto(
    r: ChannelRow,
    sourceConflictWith: string | null = null,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): MarketingChannelDto {
    // Con dominio propio verificado, el enlace corto va con él (queda mejor en
    // un cartel): `guardalobox.es/g/<código>` en vez de `trasteros.pro/g/…`.
    const base =
      r.tenant.customDomain && r.tenant.customDomainVerifiedAt
        ? `https://${r.tenant.customDomain}`
        : process.env.WEB_BASE_URL || WEB_BASE_URL_FALLBACK;
    return {
      id: r.id,
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      promotionId: r.promotionId,
      promotionCode: r.promotion?.code ?? null,
      promoLandingId: r.promoLandingId,
      promoLandingName: r.promoLanding?.name ?? null,
      landingUrl: r.promoLanding
        ? promoLandingUrl(
            r.promoLanding.tenant,
            r.promoLanding.slug,
            linkSource(r, 'web'),
            r.type as MarketingChannelType,
            r.promoLanding.shortPath,
          )
        : null,
      type: r.type as MarketingChannelType,
      name: r.name,
      status: r.status as MarketingChannelStatus,
      externalUrl: r.externalUrl,
      // El coste es un gasto: solo con permiso para verlos.
      monthlyCost: viewer.cost && r.monthlyCost !== null ? num(r.monthlyCost) : null,
      renewsOn: r.renewsOn ? r.renewsOn.toISOString().slice(0, 10) : null,
      renewalMonths: r.renewalMonths,
      utmSourceMatch: r.utmSourceMatch,
      sourceConflictWith,
      externalCampaignId: r.externalCampaignId,
      shortCode: r.shortCode,
      shortUrl: r.shortCode ? `${base.replace(/\/$/, '')}/g/${r.shortCode}` : null,
      clickCount: r.clickCount,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      lastSyncError: r.lastSyncError,
      syncFailingSince: r.syncFailingSince?.toISOString() ?? null,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
