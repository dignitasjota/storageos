import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { closedQuarters, isClosed } from '../../../common/fiscal-closure';
import { todayInTimezone } from '../../../common/format';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { FULL_MARKETING_VIEWER, inViewerScope, type MarketingViewer } from '../marketing-viewer';

import { round2, type AdDailyStats } from './ad-stats';
import { GoogleAdsSettingsService } from './google-ads-settings.service';
import { GoogleAdsClient } from './google-ads.client';
import { MetaAdsSettingsService } from './meta-ads-settings.service';
import { MetaAdsClient } from './meta-ads.client';

import type { SyncAdSpendResultDto } from '@storageos/shared';

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Como mucho, días de una sincronización (y los que se importan al vincular la campaña). */
export const MAX_SYNC_DAYS = 90;
/** Días ya guardados que se vuelven a pedir: las plataformas ajustan el gasto 1-2 días después. */
const RESYNC_DAYS = 3;
/** Días seguidos fallando antes de avisar al equipo. */
const FAILING_NOTICE_DAYS = 3;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const shiftDay = (d: string, n: number) => isoDate(new Date(asDate(d).getTime() + n * DAY_MS));

type Platform = 'google_ads' | 'meta_ads';

interface SyncChannel {
  id: string;
  name: string;
  facilityId: string | null;
  type: string;
  externalCampaignId: string | null;
}

/** El gasto se importa en euros: una cuenta en otra moneda daría importes falsos. */
function assertEuros(rows: AdDailyStats[], label: string): void {
  const other = rows.find((r) => r.currency && r.currency.toUpperCase() !== 'EUR');
  if (other) {
    throw new Error(
      `${label}: la cuenta está en ${other.currency} y TrasterOS solo importa el gasto en euros`,
    );
  }
}

@Injectable()
export class AdSpendSyncService {
  private readonly logger = new Logger(AdSpendSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly googleSettings: GoogleAdsSettingsService,
    private readonly metaSettings: MetaAdsSettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Escribe/actualiza un `Expense` (categoría `marketing`, vinculado al
   * canal) por cada día con gasto > 0, idempotente vía `external_ref`
   * (`<plataforma>:<campaña>:<fecha>`): re-sincronizar un rango que se solapa
   * actualiza el importe (y el canal, si la campaña pasó a otro) en vez de
   * duplicar la fila. Con `range`, los días que tenían gasto y ya no (la
   * plataforma lo rebajó a 0 por clics no válidos) se borran. Lo de un
   * trimestre cerrado en Fiscalidad no se toca.
   */
  async upsertSpendExpenses(
    tenantId: string,
    channel: SyncChannel,
    platform: Platform,
    campaignId: string,
    rows: Array<{ date: string; cost: number }>,
    range?: { from: string; to: string },
  ): Promise<SyncAdSpendResultDto> {
    const label = platform === 'google_ads' ? 'Google Ads' : 'Meta Ads';
    const prefix = `${platform}:${campaignId}:`;
    let synced = 0;
    let totalCost = 0;
    await this.prisma.withTenant(async (tx) => {
      const closed = await closedQuarters(tx);
      const withCost = new Set<string>();
      for (const row of rows) {
        if (!(row.cost > 0)) continue;
        withCost.add(row.date);
        if (isClosed(closed, asDate(row.date))) continue;
        const externalRef = `${prefix}${row.date}`;
        await tx.expense.upsert({
          // Única por empresa: dos empresas pueden tener el mismo id de campaña.
          where: { tenantId_externalRef: { tenantId, externalRef } },
          create: {
            tenantId,
            facilityId: channel.facilityId,
            category: 'marketing',
            description: `${label} — ${channel.name}`,
            amount: row.cost,
            expenseDate: asDate(row.date),
            marketingChannelId: channel.id,
            externalRef,
          },
          update: { amount: row.cost, marketingChannelId: channel.id },
        });
        synced += 1;
        totalCost += row.cost;
      }
      if (range) {
        const stored = await tx.expense.findMany({
          where: {
            externalRef: { startsWith: prefix },
            expenseDate: { gte: asDate(range.from), lte: asDate(range.to) },
          },
          select: { id: true, expenseDate: true },
        });
        const gone = stored
          .filter((e) => !withCost.has(isoDate(e.expenseDate)) && !isClosed(closed, e.expenseDate))
          .map((e) => e.id);
        if (gone.length > 0) await tx.expense.deleteMany({ where: { id: { in: gone } } });
      }
    }, tenantId);
    return { synced, totalCost: round2(totalCost) };
  }

  /**
   * Guarda el rendimiento diario de la campaña (impresiones, clics,
   * conversiones y gasto) — uno por canal y día, también los días sin gasto.
   */
  async upsertAdMetrics(
    tenantId: string,
    channel: SyncChannel,
    platform: Platform,
    campaignId: string,
    rows: AdDailyStats[],
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      for (const row of rows) {
        const date = asDate(row.date);
        const metrics = {
          campaignId,
          platform,
          cost: row.cost,
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: row.conversions,
        };
        await tx.adMetricDaily.upsert({
          where: { marketingChannelId_date: { marketingChannelId: channel.id, date } },
          create: { tenantId, marketingChannelId: channel.id, date, ...metrics },
          update: metrics,
        });
      }
    }, tenantId);
  }

  /**
   * Sincroniza un canal (a mano desde el panel o desde el cron). Sin fechas,
   * desde unos días antes del último con datos (recupera los días que se
   * perdieron si el worker estuvo parado) y, la primera vez, los últimos 90.
   */
  async syncChannel(
    tenantId: string,
    channelId: string,
    from?: string,
    to?: string,
    opts: { viewer?: MarketingViewer } = {},
  ): Promise<SyncAdSpendResultDto> {
    const viewer = opts.viewer ?? FULL_MARKETING_VIEWER;
    const found = await this.prisma.withTenant(async (tx) => {
      const channel = await tx.marketingChannel.findFirst({
        where: { id: channelId, deletedAt: null },
        select: { id: true, name: true, facilityId: true, type: true, externalCampaignId: true },
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      });
      const last = channel?.externalCampaignId
        ? await tx.adMetricDaily.findFirst({
            where: { marketingChannelId: channel.id, campaignId: channel.externalCampaignId },
            orderBy: { date: 'desc' },
            select: { date: true },
          })
        : null;
      return { channel, tz: tenant?.timezone || 'Europe/Madrid', lastDate: last?.date ?? null };
    }, tenantId);
    const channel = found.channel;
    if (!channel || !inViewerScope(viewer, channel.facilityId)) {
      throw new NotFoundException({ code: 'channel_not_found', message: 'Canal no encontrado' });
    }
    if (!channel.externalCampaignId) {
      throw new BadRequestException({
        code: 'no_external_campaign',
        message: 'El canal no tiene una campaña externa vinculada',
      });
    }
    if (channel.type !== 'google_ads' && channel.type !== 'meta_ads') {
      throw new BadRequestException({
        code: 'unsupported_platform',
        message: 'Solo se sincroniza el gasto de canales Google Ads o Meta Ads',
      });
    }
    const platform: Platform = channel.type;
    const range = this.range(from, to, found.tz, found.lastDate);
    const campaignId = channel.externalCampaignId;
    const label = platform === 'google_ads' ? 'Google Ads' : 'Meta Ads';

    let rows: AdDailyStats[];
    if (platform === 'google_ads') {
      const creds = await this.googleSettings.getCredentials(tenantId);
      if (!creds) {
        throw new BadRequestException({
          code: 'google_ads_not_enabled',
          message: 'La integración con Google Ads no está activa',
        });
      }
      try {
        rows = await new GoogleAdsClient(creds).getCampaignStats(campaignId, range.from, range.to);
        assertEuros(rows, label);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de sincronización';
        await this.recordChannelSync(tenantId, channel, message);
        throw new BadRequestException({ code: 'google_ads_sync_failed', message });
      }
    } else {
      const creds = await this.metaSettings.getCredentials(tenantId);
      if (!creds) {
        throw new BadRequestException({
          code: 'meta_ads_not_enabled',
          message: 'La integración con Meta Ads no está activa',
        });
      }
      try {
        rows = await new MetaAdsClient(creds).getCampaignStats(campaignId, range.from, range.to);
        assertEuros(rows, label);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de sincronización';
        await this.recordChannelSync(tenantId, channel, message);
        throw new BadRequestException({ code: 'meta_ads_sync_failed', message });
      }
    }
    const result = await this.upsertSpendExpenses(
      tenantId,
      channel,
      platform,
      campaignId,
      rows,
      range,
    );
    await this.upsertAdMetrics(tenantId, channel, platform, campaignId, rows);
    await this.recordChannelSync(tenantId, channel, null);
    return result;
  }

  /** Días a pedir: los que se piden, o desde poco antes del último guardado (90 como mucho). */
  private range(
    from: string | undefined,
    to: string | undefined,
    tz: string,
    lastDate: Date | null,
  ): { from: string; to: string } {
    if (from || to) {
      if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
        throw new BadRequestException({
          code: 'invalid_range',
          message: 'Indica la fecha de inicio y la de fin (AAAA-MM-DD)',
        });
      }
      const days = Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY_MS) + 1;
      if (days > MAX_SYNC_DAYS) {
        throw new BadRequestException({
          code: 'sync_range_too_long',
          message: `Como mucho ${MAX_SYNC_DAYS} días en cada sincronización`,
        });
      }
      return { from, to };
    }
    const today = isoDate(todayInTimezone(tz));
    const earliest = shiftDay(today, -(MAX_SYNC_DAYS - 1));
    const resume = lastDate ? shiftDay(isoDate(lastDate), -(RESYNC_DAYS - 1)) : earliest;
    return { from: resume < earliest ? earliest : resume, to: today };
  }

  /**
   * Estado de la sincronización de cada canal (el error de uno no lo tapa
   * otro que va bien). A los 3 días seguidos fallando, un aviso a quien puede
   * arreglarlo, una sola vez hasta que vuelva a funcionar.
   */
  private async recordChannelSync(
    tenantId: string,
    channel: SyncChannel,
    error: string | null,
  ): Promise<void> {
    const now = new Date();
    const notify = await this.prisma.withTenant(async (tx) => {
      if (!error) {
        await tx.marketingChannel.update({
          where: { id: channel.id },
          data: {
            lastSyncAt: now,
            lastSyncError: null,
            syncFailingSince: null,
            syncFailureNotifiedAt: null,
          },
        });
        return false;
      }
      const current = await tx.marketingChannel.findUnique({
        where: { id: channel.id },
        select: { syncFailingSince: true },
      });
      const since = current?.syncFailingSince ?? now;
      await tx.marketingChannel.update({
        where: { id: channel.id },
        data: { lastSyncAt: now, lastSyncError: error.slice(0, 500), syncFailingSince: since },
      });
      if (now.getTime() - since.getTime() < FAILING_NOTICE_DAYS * DAY_MS) return false;
      // Reserva el aviso: dos sincronizaciones a la vez no avisan dos veces.
      const claimed = await tx.marketingChannel.updateMany({
        where: { id: channel.id, syncFailureNotifiedAt: null },
        data: { syncFailureNotifiedAt: now },
      });
      return claimed.count === 1;
    }, tenantId);
    if (notify && error) {
      await this.notifications
        .createForPermission(tenantId, 'marketing:manage', {
          type: 'marketing.ad_sync_failing',
          title: `El gasto de «${channel.name}» no se sincroniza`,
          body: `Lleva ${FAILING_NOTICE_DAYS} días fallando: ${error.slice(0, 300)}`,
          link: '/marketing/channels',
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `Aviso de sincronización fallida no enviado: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
    await this.refreshPlatformStatus(tenantId, channel.type);
  }

  /** El estado de la integración resume el de sus canales: el primer error, o ninguno. */
  private async refreshPlatformStatus(tenantId: string, type: string): Promise<void> {
    if (type !== 'google_ads' && type !== 'meta_ads') return;
    const failing = await this.prisma.withTenant(
      (tx) =>
        tx.marketingChannel.findFirst({
          where: {
            type,
            deletedAt: null,
            externalCampaignId: { not: null },
            lastSyncError: { not: null },
          },
          orderBy: { name: 'asc' },
          select: { name: true, lastSyncError: true },
        }),
      tenantId,
    );
    const lastError = failing ? `«${failing.name}»: ${failing.lastSyncError}` : null;
    if (type === 'google_ads') await this.googleSettings.recordSyncResult(tenantId, lastError);
    else await this.metaSettings.recordSyncResult(tenantId, lastError);
  }

  /** Cron cross-tenant: sincroniza todos los canales con la integración activa. */
  async syncDueAll(): Promise<void> {
    for (const platform of ['google_ads', 'meta_ads'] as const) {
      const where = {
        enabled: true,
        // Sin los negocios dados de baja o anonimizados.
        tenant: { deletedAt: null, status: { not: 'cancelled' as const } },
      };
      const tenants =
        platform === 'google_ads'
          ? await this.admin.googleAdsSettings.findMany({ where, select: { tenantId: true } })
          : await this.admin.metaAdsSettings.findMany({ where, select: { tenantId: true } });
      for (const { tenantId } of tenants) {
        const channels = await this.admin.marketingChannel.findMany({
          where: {
            tenantId,
            type: platform,
            externalCampaignId: { not: null },
            deletedAt: null,
            // Uno finalizado ya no gasta.
            status: { not: 'ended' },
          },
          select: { id: true },
        });
        for (const c of channels) {
          try {
            await this.syncChannel(tenantId, c.id);
          } catch (err) {
            this.logger.warn(
              `Sync ${platform} falló (tenant ${tenantId}, canal ${c.id}): ${(err as Error).message}`,
            );
          }
        }
      }
    }
  }
}
