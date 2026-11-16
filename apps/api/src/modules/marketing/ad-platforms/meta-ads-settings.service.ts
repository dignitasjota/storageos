import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../database/prisma.service';

import { adConversionStats, retryFailedConversions } from './ad-conversion-stats';
import { MetaAdsClient } from './meta-ads.client';

import type { MetaAdsCredentials } from './meta-ads.client';
import type {
  AdPlatformTestResultDto,
  MetaAdsSettingsDto,
  UpdateMetaAdsSettingsInput,
} from '@storageos/shared';

@Injectable()
export class MetaAdsSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get(tenantId: string): Promise<MetaAdsSettingsDto> {
    const [row, conversions] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.metaAdsSettings.findUnique({ where: { tenantId } }),
          adConversionStats(tx, 'meta'),
        ]),
      tenantId,
    );
    return {
      enabled: row?.enabled ?? false,
      hasAccessToken: !!row?.accessTokenEncrypted,
      adAccountId: row?.adAccountId ?? null,
      pixelId: row?.pixelId ?? null,
      lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      conversions,
    };
  }

  async update(tenantId: string, input: UpdateMetaAdsSettingsInput): Promise<MetaAdsSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.metaAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    const accessTokenEncrypted = input.accessToken
      ? this.crypto.encryptString(input.accessToken, tenantId)
      : (existing?.accessTokenEncrypted ?? null);
    const adAccountId = input.adAccountId ?? existing?.adAccountId ?? null;
    const pixelId =
      input.pixelId !== undefined ? input.pixelId || null : (existing?.pixelId ?? null);

    if (input.enabled && !(accessTokenEncrypted && adAccountId)) {
      throw new BadRequestException({
        code: 'meta_ads_credentials_required',
        message: 'Faltan credenciales de Meta Ads para activar la integración',
      });
    }

    await this.prisma.withTenant(async (tx) => {
      await tx.metaAdsSettings.upsert({
        where: { tenantId },
        create: { tenantId, accessTokenEncrypted, adAccountId, pixelId, enabled: input.enabled },
        update: {
          accessTokenEncrypted,
          adAccountId,
          pixelId,
          enabled: input.enabled,
          ...(input.accessToken ? { lastError: null } : {}),
        },
      });
      // Otra configuración: los envíos que fallaron se vuelven a intentar.
      await retryFailedConversions(tx, 'meta');
    }, tenantId);
    return this.get(tenantId);
  }

  /**
   * Credenciales descifradas, o null si están incompletas o (con
   * `requireEnabled`) la integración no está activa.
   */
  async getCredentials(
    tenantId: string,
    requireEnabled = true,
  ): Promise<MetaAdsCredentials | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.metaAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row || (requireEnabled && !row.enabled) || !row.accessTokenEncrypted || !row.adAccountId) {
      return null;
    }
    return {
      accessToken: this.crypto.decryptString(row.accessTokenEncrypted, tenantId),
      adAccountId: row.adAccountId,
    };
  }

  /** Token y píxel, si la integración está activa y completa. */
  async getConversionTarget(
    tenantId: string,
  ): Promise<{ credentials: MetaAdsCredentials; pixelId: string } | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.metaAdsSettings.findUnique({ where: { tenantId }, select: { pixelId: true } }),
      tenantId,
    );
    if (!row?.pixelId) return null;
    const credentials = await this.getCredentials(tenantId);
    return credentials ? { credentials, pixelId: row.pixelId } : null;
  }

  /** Prueba las credenciales guardadas, también antes de activar la integración. */
  async test(tenantId: string): Promise<AdPlatformTestResultDto> {
    const creds = await this.getCredentials(tenantId, false);
    if (!creds) {
      return { ok: false, message: 'Faltan credenciales: guárdalas antes de probar' };
    }
    try {
      await new MetaAdsClient(creds).testConnection();
      return { ok: true, message: 'Conexión correcta con Meta Ads' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Error de conexión' };
    }
  }

  /** Borra las credenciales (la integración queda desactivada). */
  async remove(tenantId: string): Promise<MetaAdsSettingsDto> {
    await this.prisma.withTenant(
      (tx) => tx.metaAdsSettings.deleteMany({ where: { tenantId } }),
      tenantId,
    );
    return this.get(tenantId);
  }

  async recordSyncResult(tenantId: string, error: string | null): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.metaAdsSettings.updateMany({
          where: { tenantId },
          data: { lastSyncAt: new Date(), lastError: error },
        }),
      tenantId,
    );
  }
}
