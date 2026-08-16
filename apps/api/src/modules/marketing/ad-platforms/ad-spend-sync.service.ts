import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';

import { GoogleAdsSettingsService } from './google-ads-settings.service';
import { GoogleAdsClient } from './google-ads.client';
import { MetaAdsSettingsService } from './meta-ads-settings.service';
import { MetaAdsClient } from './meta-ads.client';

import type { GoogleAdsSpendRow } from './google-ads.client';
import type { MetaAdsSpendRow } from './meta-ads.client';
import type { SyncAdSpendResultDto } from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Ventana por defecto de una sincronización manual/automática (días). */
const DEFAULT_SYNC_DAYS = 7;
/** Ventana del cron: corta pero solapada, para capturar el gasto que las
 * plataformas de anuncios terminan de asentar 1-2 días después. */
const CRON_SYNC_DAYS = 3;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(days: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - (days - 1) * 86_400_000);
  return { from: isoDate(from), to: isoDate(now) };
}

interface SyncChannel {
  id: string;
  name: string;
  facilityId: string | null;
  type: string;
  externalCampaignId: string | null;
}

@Injectable()
export class AdSpendSyncService {
  private readonly logger = new Logger(AdSpendSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly googleSettings: GoogleAdsSettingsService,
    private readonly metaSettings: MetaAdsSettingsService,
  ) {}

  /**
   * Escribe/actualiza un `Expense` (categoría `marketing`, vinculado al
   * canal) por cada día con gasto > 0, idempotente vía `external_ref`
   * (`<plataforma>:<campaña>:<fecha>`) — re-sincronizar un rango que se
   * solapa actualiza el importe en vez de duplicar la fila.
   */
  async upsertSpendExpenses(
    tenantId: string,
    channel: SyncChannel,
    platform: 'google_ads' | 'meta_ads',
    campaignId: string,
    rows: Array<{ date: string; cost: number }>,
  ): Promise<SyncAdSpendResultDto> {
    const label = platform === 'google_ads' ? 'Google Ads' : 'Meta Ads';
    let synced = 0;
    let totalCost = 0;
    await this.prisma.withTenant(async (tx) => {
      for (const row of rows) {
        if (!(row.cost > 0)) continue;
        const externalRef = `${platform}:${campaignId}:${row.date}`;
        await tx.expense.upsert({
          where: { externalRef },
          create: {
            tenantId,
            facilityId: channel.facilityId,
            category: 'marketing',
            description: `${label} — ${channel.name}`,
            amount: row.cost,
            expenseDate: new Date(`${row.date}T00:00:00.000Z`),
            marketingChannelId: channel.id,
            externalRef,
          },
          update: { amount: row.cost },
        });
        synced += 1;
        totalCost += row.cost;
      }
    }, tenantId);
    return { synced, totalCost: round2(totalCost) };
  }

  /** Sincroniza un canal concreto (llamada manual desde el panel o el cron). */
  async syncChannel(
    tenantId: string,
    channelId: string,
    from?: string,
    to?: string,
  ): Promise<SyncAdSpendResultDto> {
    const channel = await this.prisma.withTenant(
      (tx) =>
        tx.marketingChannel.findFirst({
          where: { id: channelId, deletedAt: null },
          select: { id: true, name: true, facilityId: true, type: true, externalCampaignId: true },
        }),
      tenantId,
    );
    if (!channel) {
      throw new NotFoundException({ code: 'channel_not_found', message: 'Canal no encontrado' });
    }
    if (!channel.externalCampaignId) {
      throw new BadRequestException({
        code: 'no_external_campaign',
        message: 'El canal no tiene una campaña externa vinculada',
      });
    }
    const range = from && to ? { from, to } : defaultRange(DEFAULT_SYNC_DAYS);

    if (channel.type === 'google_ads') {
      return this.syncGoogleAdsChannel(tenantId, channel, range.from, range.to);
    }
    if (channel.type === 'meta_ads') {
      return this.syncMetaAdsChannel(tenantId, channel, range.from, range.to);
    }
    throw new BadRequestException({
      code: 'unsupported_platform',
      message: 'Solo se sincroniza el gasto de canales Google Ads o Meta Ads',
    });
  }

  private async syncGoogleAdsChannel(
    tenantId: string,
    channel: SyncChannel,
    from: string,
    to: string,
  ): Promise<SyncAdSpendResultDto> {
    const creds = await this.googleSettings.getCredentials(tenantId);
    if (!creds) {
      throw new BadRequestException({
        code: 'google_ads_not_enabled',
        message: 'La integración con Google Ads no está activa',
      });
    }
    let rows: GoogleAdsSpendRow[];
    try {
      rows = await new GoogleAdsClient(creds).getCampaignSpend(
        channel.externalCampaignId!,
        from,
        to,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error de sincronización';
      await this.googleSettings.recordSyncResult(tenantId, message);
      throw new BadRequestException({ code: 'google_ads_sync_failed', message });
    }
    const result = await this.upsertSpendExpenses(
      tenantId,
      channel,
      'google_ads',
      channel.externalCampaignId!,
      rows,
    );
    await this.googleSettings.recordSyncResult(tenantId, null);
    return result;
  }

  private async syncMetaAdsChannel(
    tenantId: string,
    channel: SyncChannel,
    from: string,
    to: string,
  ): Promise<SyncAdSpendResultDto> {
    const creds = await this.metaSettings.getCredentials(tenantId);
    if (!creds) {
      throw new BadRequestException({
        code: 'meta_ads_not_enabled',
        message: 'La integración con Meta Ads no está activa',
      });
    }
    let rows: MetaAdsSpendRow[];
    try {
      rows = await new MetaAdsClient(creds).getCampaignSpend(channel.externalCampaignId!, from, to);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error de sincronización';
      await this.metaSettings.recordSyncResult(tenantId, message);
      throw new BadRequestException({ code: 'meta_ads_sync_failed', message });
    }
    const result = await this.upsertSpendExpenses(
      tenantId,
      channel,
      'meta_ads',
      channel.externalCampaignId!,
      rows,
    );
    await this.metaSettings.recordSyncResult(tenantId, null);
    return result;
  }

  /** Cron cross-tenant: sincroniza todos los canales con la integración activa. */
  async syncDueAll(): Promise<void> {
    const { from, to } = defaultRange(CRON_SYNC_DAYS);

    const googleTenants = await this.admin.googleAdsSettings.findMany({
      where: { enabled: true },
      select: { tenantId: true },
    });
    for (const { tenantId } of googleTenants) {
      const channels = await this.admin.marketingChannel.findMany({
        where: { tenantId, type: 'google_ads', externalCampaignId: { not: null }, deletedAt: null },
        select: { id: true },
      });
      for (const c of channels) {
        try {
          await this.syncChannel(tenantId, c.id, from, to);
        } catch (err) {
          this.logger.warn(
            `Sync Google Ads falló (tenant ${tenantId}, canal ${c.id}): ${(err as Error).message}`,
          );
        }
      }
    }

    const metaTenants = await this.admin.metaAdsSettings.findMany({
      where: { enabled: true },
      select: { tenantId: true },
    });
    for (const { tenantId } of metaTenants) {
      const channels = await this.admin.marketingChannel.findMany({
        where: { tenantId, type: 'meta_ads', externalCampaignId: { not: null }, deletedAt: null },
        select: { id: true },
      });
      for (const c of channels) {
        try {
          await this.syncChannel(tenantId, c.id, from, to);
        } catch (err) {
          this.logger.warn(
            `Sync Meta Ads falló (tenant ${tenantId}, canal ${c.id}): ${(err as Error).message}`,
          );
        }
      }
    }
  }
}
