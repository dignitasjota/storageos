import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../database/prisma.service';

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
    const row = await this.prisma.withTenant(
      (tx) => tx.metaAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      enabled: row?.enabled ?? false,
      hasAccessToken: !!row?.accessTokenEncrypted,
      adAccountId: row?.adAccountId ?? null,
      lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
    };
  }

  async update(tenantId: string, input: UpdateMetaAdsSettingsInput): Promise<MetaAdsSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.metaAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    const accessTokenEncrypted = input.accessToken
      ? this.crypto.encryptString(input.accessToken)
      : (existing?.accessTokenEncrypted ?? null);
    const adAccountId = input.adAccountId ?? existing?.adAccountId ?? null;

    if (input.enabled && !(accessTokenEncrypted && adAccountId)) {
      throw new BadRequestException({
        code: 'meta_ads_credentials_required',
        message: 'Faltan credenciales de Meta Ads para activar la integración',
      });
    }

    await this.prisma.withTenant(
      (tx) =>
        tx.metaAdsSettings.upsert({
          where: { tenantId },
          create: { tenantId, accessTokenEncrypted, adAccountId, enabled: input.enabled },
          update: {
            accessTokenEncrypted,
            adAccountId,
            enabled: input.enabled,
            ...(input.accessToken ? { lastError: null } : {}),
          },
        }),
      tenantId,
    );
    return this.get(tenantId);
  }

  async getCredentials(tenantId: string): Promise<MetaAdsCredentials | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.metaAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row?.enabled || !row.accessTokenEncrypted || !row.adAccountId) return null;
    return {
      accessToken: this.crypto.decryptString(row.accessTokenEncrypted),
      adAccountId: row.adAccountId,
    };
  }

  async test(tenantId: string): Promise<AdPlatformTestResultDto> {
    const creds = await this.getCredentials(tenantId);
    if (!creds) {
      return { ok: false, message: 'Faltan credenciales o la integración no está activa' };
    }
    try {
      await new MetaAdsClient(creds).testConnection();
      return { ok: true, message: 'Conexión correcta con Meta Ads' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Error de conexión' };
    }
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
