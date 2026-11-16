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
  suggestChannelForSource,
  trafficKey,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { assertFacilityAllowed, assertWholeBusiness } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { QUEUE_BILLING } from '../queues/queues.module';

import { FULL_MARKETING_VIEWER, inViewerScope, type MarketingViewer } from './marketing-viewer';

import type {
  CreateMarketingChannelInput,
  MarketingAttributionModel,
  MarketingChannelDto,
  MarketingChannelStatus,
  MarketingChannelType,
  MarketingPerformanceDto,
  MarketingPerformanceRowDto,
  MarketingShortLinkResolveDto,
  MarketingUnassignedSourceDto,
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
  coupon: { select: { code: true } },
  promoLanding: {
    select: {
      name: true,
      slug: true,
      shortPath: true,
      tenant: { select: { slug: true, customDomain: true, customDomainVerifiedAt: true } },
    },
  },
  tenant: { select: { slug: true, customDomain: true, customDomainVerifiedAt: true } },
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

const EASY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Letras y cifras sin las que se confunden al teclearlas. */
function easyCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += EASY_ALPHABET[b % EASY_ALPHABET.length];
  return out;
}

/**
 * Dirección de la web del negocio con el origen y la campaña del canal: para
 * pegar en un anuncio, un portal o la biografía de Instagram.
 */
function trackingUrl(
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  channel: LinkChannel,
): string {
  const base =
    tenant.customDomain && tenant.customDomainVerifiedAt
      ? `https://${tenant.customDomain}/`
      : `${(process.env.WEB_BASE_URL || WEB_BASE_URL_FALLBACK).replace(/\/$/, '')}/s/${tenant.slug}`;
  const utm = new URLSearchParams({
    utm_source: linkSource(channel, 'web'),
    utm_medium: promoUtmMedium(channel.type as MarketingChannelType),
    utm_campaign: channel.id,
  });
  return `${base}?${utm.toString()}`;
}

/** Lo gastado este mes (en la zona del negocio) por canal. */
async function spentThisMonth(
  tx: Prisma.TransactionClient,
  tenantId: string,
  channelIds: string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const today = todayInTimezone(tenant?.timezone || 'Europe/Madrid')
    .toISOString()
    .slice(0, 10);
  const rows = await tx.expense.groupBy({
    by: ['marketingChannelId'],
    where: {
      marketingChannelId: { in: channelIds },
      expenseDate: { gte: asDay(`${today.slice(0, 7)}-01`), lte: asDay(today) },
    },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.marketingChannelId!, num(r._sum.amount ?? 0)]));
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
  refs: { facilityId?: string | null; promotionId?: string | null; couponId?: string | null },
): Promise<void> {
  if (refs.couponId) {
    const found = await tx.coupon.count({ where: { id: refs.couponId } });
    if (found === 0) {
      throw new BadRequestException({ code: 'coupon_not_found', message: 'El cupón no existe' });
    }
  }
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
    facilityId: string | null = null,
  ): Promise<MarketingChannelDto[]> {
    if (facilityId) assertFacilityAllowed(viewer.facilityScope, facilityId);
    // Un local: los suyos y los de todo el negocio (como el alcance por local).
    const scope = facilityId ? [facilityId] : viewer.facilityScope;
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
      const spent = viewer.cost
        ? await spentThisMonth(
            tx,
            tenantId,
            rows.map((r) => r.id),
          )
        : new Map<string, number>();
      return rows.map((r) =>
        this.toDto(r, conflicts.get(r.id) ?? null, viewer, spent.get(r.id) ?? 0),
      );
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
        couponId: input.couponId ?? null,
      });
      if (input.promoLandingId) await assertPromoLanding(tx, input.promoLandingId);
      await assertCampaignFree(tx, input.type, campaignId);
      const row = await tx.marketingChannel.create({
        data: {
          tenantId,
          facilityId: input.facilityId ?? null,
          promotionId: input.promotionId ?? null,
          couponId: input.couponId ?? null,
          promoLandingId: input.promoLandingId ?? null,
          type: input.type,
          name: input.name,
          status: input.status,
          externalUrl: input.externalUrl?.trim() || null,
          monthlyCost: input.monthlyCost ?? null,
          monthlyBudget: input.monthlyBudget ?? null,
          renewsOn: input.renewsOn ? asDay(input.renewsOn) : null,
          renewalMonths: input.renewalMonths ?? null,
          utmSourceMatch,
          externalCampaignId: campaignId,
          shortCode,
          notes: input.notes?.trim() || null,
        },
        include: CHANNEL_INCLUDE,
      });
      return this.toDto(row, (await this.conflicts(tx)).get(row.id) ?? null, viewer, 0);
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
        ...(input.couponId !== undefined ? { couponId: input.couponId } : {}),
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
      if (input.couponId !== undefined) {
        data.coupon = input.couponId ? { connect: { id: input.couponId } } : { disconnect: true };
      }
      if (input.monthlyBudget !== undefined) {
        data.monthlyBudget = input.monthlyBudget ?? null;
        // Otro presupuesto: se vuelve a avisar si se pasa este mes.
        data.budgetNotifiedMonth = null;
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
      const spent = viewer.cost ? await spentThisMonth(tx, tenantId, [row.id]) : new Map();
      return this.toDto(
        row,
        (await this.conflicts(tx)).get(row.id) ?? null,
        viewer,
        spent.get(row.id) ?? 0,
      );
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
    // Los códigos nuevos van en mayúsculas: quien lo teclea en minúsculas también llega.
    const exact = await this.admin.marketingChannel.findUnique({
      where: { shortCode },
      select: { id: true },
    });
    const code = exact || !/^[a-z0-9]+$/i.test(shortCode) ? shortCode : shortCode.toUpperCase();
    const channel = await this.admin.marketingChannel.findUnique({
      where: { shortCode: code },
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
   * - Visitantes: los de la web con el origen del canal.
   * - Contactos: los creados en el periodo con el canal (el guardado al
   *   llegar o, en los antiguos, el de su origen).
   * - Reservas: las reservas online del periodo que siguen en pie.
   * - Clientes: los contratos firmados en el periodo (sin cancelar) de
   *   contactos del canal, o con la promoción o el cupón del canal si no
   *   llegaron por ningún canal (flyers, buzoneo: el cliente llama o va al local).
   * - Cobrado: lo que han pagado esos clientes hasta hoy, sin IVA ni devoluciones.
   * - Cuota y payback: con los clientes que siguen.
   * Con `model = last`, reservas y clientes van al canal de la visita en la que
   * se reservó (si no hay, al del primer contacto).
   * Los canales borrados salen si tuvieron gasto o resultados en el periodo.
   */
  async getPerformance(
    tenantId: string,
    filters: {
      from?: string;
      to?: string;
      model?: MarketingAttributionModel;
      facilityId?: string;
    },
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
    const model: MarketingAttributionModel = filters.model ?? 'first';
    const facilityId = filters.facilityId ?? null;
    if (facilityId) assertFacilityAllowed(viewer.facilityScope, facilityId);
    // Un local elegido o, sin él, los del alcance del usuario.
    const scope = facilityId ? [facilityId] : viewer.facilityScope;
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
        const leadScope = scope
          ? { OR: [{ preferredFacilityId: null }, { preferredFacilityId: { in: scope } }] }
          : {};

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
            couponId: true,
          },
        });
        const channelById = new Map(channels.map((c) => [c.id, c]));

        const visitsFilter = days
          ? Prisma.sql`AND day >= ${asDay(filters.from ?? '2000-01-01')}::date
                       AND day <= ${asDay(filters.to ?? '2999-12-31')}::date`
          : Prisma.empty;
        const [expenses, unassigned, leads, contracts, bookedLeads, visitGroups] =
          await Promise.all([
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
              where: { deletedAt: null, ...(at ? { createdAt: at } : {}), ...leadScope },
              select: {
                source: true,
                utmSource: true,
                utmMedium: true,
                utmCampaign: true,
                marketingChannelId: true,
              },
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
            // Reservas online del periodo: las caducadas se cancelan y no cuentan.
            tx.lead.findMany({
              where: {
                deletedAt: null,
                bookedAt: at ?? { not: null },
                convertedContractId: { not: null },
                convertedContract: {
                  deletedAt: null,
                  status: { not: 'cancelled' },
                  ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
                },
              },
              select: {
                convertedContractId: true,
                source: true,
                utmSource: true,
                utmMedium: true,
                utmCampaign: true,
                marketingChannelId: true,
                metadata: true,
              },
            }),
            tx.$queryRaw<
              { source: string; medium: string; campaign: string; n: number }[]
            >`SELECT source, medium, campaign, COUNT(DISTINCT visitor_id)::int AS n
                FROM web_visits
               WHERE tenant_id = ${tenantId}::uuid ${visitsFilter}
               GROUP BY 1, 2, 3`,
          ]);
        const contractIds = contracts.map((c) => c.id);
        const [wonLeads, couponRows, payments] = contractIds.length
          ? await Promise.all([
              tx.lead.findMany({
                where: { deletedAt: null, convertedContractId: { in: contractIds } },
                select: {
                  convertedContractId: true,
                  source: true,
                  utmSource: true,
                  utmMedium: true,
                  utmCampaign: true,
                  marketingChannelId: true,
                  metadata: true,
                },
              }),
              tx.couponRedemption.findMany({
                where: { contractId: { in: contractIds } },
                select: { contractId: true, couponId: true },
              }),
              viewer.revenue
                ? tx.$queryRaw<{ contract_id: string; net: number }[]>`
                    SELECT i.contract_id,
                           SUM((p.amount - p.refunded_amount)
                               * CASE WHEN i.total > 0 THEN i.subtotal / i.total ELSE 1 END)::float AS net
                      FROM payments p
                      JOIN invoices i ON i.id = p.invoice_id
                     WHERE i.tenant_id = ${tenantId}::uuid
                       AND i.contract_id = ANY(${contractIds}::uuid[])
                       AND i.kind = 'invoice'
                       AND p.status IN ('succeeded', 'partially_refunded', 'refunded')
                       AND p.method_type::text NOT IN ('credit_note', 'withholding')
                     GROUP BY 1`
                : Promise.resolve([]),
            ])
          : [[], [], []];

        type Touched = {
          source: string;
          utmSource: string | null;
          utmMedium: string | null;
          utmCampaign: string | null;
          marketingChannelId: string | null;
          metadata?: unknown;
        };
        // El canal guardado al llegar (si está en el informe) o el de su origen.
        const firstChannel = (l: Touched) =>
          l.marketingChannelId
            ? (channelById.get(l.marketingChannelId) ?? null)
            : attributeChannel(channels, {
                source: l.utmSource ?? l.source,
                medium: l.utmMedium,
                campaign: l.utmCampaign,
              });
        // Último contacto: la visita en la que reservó, si la hay.
        const channelOf = (l: Touched) => {
          if (model === 'last') {
            const utm = (l.metadata as { bookingUtm?: Record<string, string | null> } | null)
              ?.bookingUtm;
            if (utm && (utm.source || utm.utmSource || utm.campaign || utm.utmCampaign)) {
              const last = attributeChannel(channels, {
                source: utm.source ?? utm.utmSource ?? null,
                medium: utm.medium ?? utm.utmMedium ?? null,
                campaign: utm.campaign ?? utm.utmCampaign ?? null,
              });
              if (last) return last;
            }
          }
          return firstChannel(l);
        };

        const leadsBy = new Map<string, number>();
        for (const l of leads) {
          const channel = firstChannel(l);
          if (channel) leadsBy.set(channel.id, (leadsBy.get(channel.id) ?? 0) + 1);
        }
        const bookingsBy = new Map<string, number>();
        const countedBookings = new Set<string>();
        for (const l of bookedLeads) {
          if (countedBookings.has(l.convertedContractId!)) continue;
          countedBookings.add(l.convertedContractId!);
          const channel = channelOf(l);
          if (channel) bookingsBy.set(channel.id, (bookingsBy.get(channel.id) ?? 0) + 1);
        }
        const visitorsBy = new Map<string, number>();
        for (const g of visitGroups) {
          const channel = attributeChannel(channels, {
            source: g.source || null,
            medium: g.medium || null,
            campaign: g.campaign || null,
          });
          if (channel) visitorsBy.set(channel.id, (visitorsBy.get(channel.id) ?? 0) + g.n);
        }

        // Cada cliente, a un canal: el de su contacto o, sin él, el de su promoción o su cupón.
        const contractChannel = new Map<string, string>();
        for (const l of wonLeads) {
          const cid = l.convertedContractId!;
          if (contractChannel.has(cid)) continue;
          const channel = channelOf(l);
          if (channel) contractChannel.set(cid, channel.id);
        }
        const live = channels
          .filter((c) => !c.deletedAt)
          .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active'));
        const byPromotion = new Map<string, string>();
        const byCoupon = new Map<string, string>();
        for (const c of live) {
          if (c.promotionId && !byPromotion.has(c.promotionId))
            byPromotion.set(c.promotionId, c.id);
          if (c.couponId && !byCoupon.has(c.couponId)) byCoupon.set(c.couponId, c.id);
        }
        const couponOf = new Map(couponRows.map((r) => [r.contractId!, r.couponId]));
        for (const c of contracts) {
          if (contractChannel.has(c.id)) continue;
          const channelId =
            (c.promotionId ? byPromotion.get(c.promotionId) : undefined) ??
            (couponOf.has(c.id) ? byCoupon.get(couponOf.get(c.id)!) : undefined);
          if (channelId) contractChannel.set(c.id, channelId);
        }
        const contractById = new Map(contracts.map((c) => [c.id, c]));
        const paidBy = new Map(payments.map((p) => [p.contract_id, Number(p.net)]));
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
            let liveCount = 0;
            let paidCount = 0;
            let collected = 0;
            for (const cid of won) {
              const k = contractById.get(cid);
              if (k && (k.status === 'active' || k.status === 'ending')) {
                liveCount += 1;
                mrr += Math.max(0, num(k.priceMonthly) - num(k.discountAmount));
              }
              const paid = paidBy.get(cid) ?? 0;
              if (paid > 0) paidCount += 1;
              collected += paid;
            }
            const cac = viewer.cost && won.length > 0 ? round2(cost / won.length) : null;
            const avgMrr = liveCount > 0 ? mrr / liveCount : 0;
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
              liveCount,
              paybackMonths:
                viewer.cost && viewer.revenue && cac !== null && avgMrr > 0
                  ? round2(cac / avgMrr)
                  : null,
              visitors: visitorsBy.get(c.id) ?? 0,
              bookings: bookingsBy.get(c.id) ?? 0,
              paidCount,
              collected: viewer.revenue ? round2(collected) : 0,
              roas: viewer.cost && viewer.revenue && cost > 0 ? round2(collected / cost) : null,
            };
          })
          .filter(
            (r) => !r.deleted || r.cost > 0 || r.leadsCount > 0 || r.wonCount > 0 || r.bookings > 0,
          )
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
          model,
          facilityId,
        };
      },
      tenantId,
      { timeout: 20_000 },
    );
  }

  /**
   * Orígenes con visitas, contactos o reservas en los últimos `days` días que
   * no recoge ningún canal: para crear su canal con un clic. Sin las visitas
   * directas (sin origen).
   */
  async unassignedSources(
    tenantId: string,
    daysInput: number,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<MarketingUnassignedSourceDto[]> {
    const days = [30, 90, 365].includes(daysInput) ? daysInput : 90;
    const scope = viewer.facilityScope;
    return this.prisma.withTenant(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true },
        });
        const tz = tenant?.timezone || 'Europe/Madrid';
        const today = todayInTimezone(tz).toISOString().slice(0, 10);
        const from = new Date(asDay(today).getTime() - (days - 1) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const since = zonedDayStart(from, tz);
        const [channels, visits, leads] = await Promise.all([
          tx.marketingChannel.findMany({
            where: { deletedAt: null },
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
          }),
          tx.$queryRaw<{ source: string; medium: string; campaign: string; n: number }[]>`
            SELECT source, medium, campaign, COUNT(DISTINCT visitor_id)::int AS n
              FROM web_visits
             WHERE tenant_id = ${tenantId}::uuid AND day >= ${asDay(from)}::date AND source <> ''
             GROUP BY 1, 2, 3`,
          tx.lead.findMany({
            where: {
              deletedAt: null,
              utmSource: { not: null },
              OR: [{ createdAt: { gte: since } }, { bookedAt: { gte: since } }],
              ...(scope
                ? {
                    AND: [
                      {
                        OR: [{ preferredFacilityId: null }, { preferredFacilityId: { in: scope } }],
                      },
                    ],
                  }
                : {}),
            },
            select: {
              utmSource: true,
              utmMedium: true,
              utmCampaign: true,
              marketingChannelId: true,
              createdAt: true,
              bookedAt: true,
            },
          }),
        ]);
        const rows = new Map<string, MarketingUnassignedSourceDto>();
        const row = (touch: { source: string; medium: string | null }) => {
          const k = trafficKey(touch);
          if (k.source === 'web') return null;
          const key = `${k.source}|${k.paid}`;
          let r = rows.get(key);
          if (!r) {
            const suggested = suggestChannelForSource(k.source, k.paid);
            r = {
              source: k.source,
              paidTraffic: k.paid,
              visitors: 0,
              contacts: 0,
              bookings: 0,
              suggestedType: suggested.type,
              suggestedName: suggested.name,
            };
            rows.set(key, r);
          }
          return r;
        };
        for (const v of visits) {
          const touch = {
            source: v.source,
            medium: v.medium || null,
            campaign: v.campaign || null,
          };
          if (attributeChannel(channels, touch)) continue;
          const r = row(touch);
          if (r) r.visitors += v.n;
        }
        for (const l of leads) {
          if (l.marketingChannelId) continue;
          const touch = { source: l.utmSource!, medium: l.utmMedium, campaign: l.utmCampaign };
          if (attributeChannel(channels, touch)) continue;
          const r = row(touch);
          if (!r) continue;
          if (l.createdAt >= since) r.contacts += 1;
          if (l.bookedAt && l.bookedAt >= since) r.bookings += 1;
        }
        return [...rows.values()]
          .sort(
            (a, b) => b.bookings - a.bookings || b.contacts - a.contacts || b.visitors - a.visitors,
          )
          .slice(0, 10);
      },
      tenantId,
      { timeout: 20_000 },
    );
  }

  /**
   * Código corto único y fácil de teclear desde un cartel: 6 letras y cifras
   * en mayúsculas, sin las que se confunden (0/O, 1/I/L). Reintenta ante
   * colisión (el índice único de la BD es la red de seguridad).
   */
  private async uniqueShortCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = easyCode(attempt < 3 ? 6 : 8);
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
    return easyCode(10);
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
    spent = 0,
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
      couponId: r.couponId,
      couponCode: r.coupon?.code ?? null,
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
      trackingUrl: trackingUrl(r.tenant, r),
      type: r.type as MarketingChannelType,
      name: r.name,
      status: r.status as MarketingChannelStatus,
      externalUrl: r.externalUrl,
      // El coste es un gasto: solo con permiso para verlos.
      monthlyCost: viewer.cost && r.monthlyCost !== null ? num(r.monthlyCost) : null,
      monthlyBudget: viewer.cost && r.monthlyBudget !== null ? num(r.monthlyBudget) : null,
      spentThisMonth: viewer.cost ? round2(spent) : null,
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
