import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../database/prisma.service';

import { GoogleAdsClient } from './google-ads.client';

import type { GoogleAdsCredentials } from './google-ads.client';
import type {
  AdPlatformTestResultDto,
  GoogleAdsSettingsDto,
  UpdateGoogleAdsSettingsInput,
} from '@storageos/shared';

@Injectable()
export class GoogleAdsSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get(tenantId: string): Promise<GoogleAdsSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.googleAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      enabled: row?.enabled ?? false,
      hasCredentials: !!(
        row?.clientId &&
        row.clientSecretEncrypted &&
        row.developerTokenEncrypted &&
        row.refreshTokenEncrypted &&
        row.customerId
      ),
      customerId: row?.customerId ?? null,
      loginCustomerId: row?.loginCustomerId ?? null,
      lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
    };
  }

  async update(
    tenantId: string,
    input: UpdateGoogleAdsSettingsInput,
  ): Promise<GoogleAdsSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.googleAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    const clientId = input.clientId ?? existing?.clientId ?? null;
    const clientSecretEncrypted = input.clientSecret
      ? this.crypto.encryptString(input.clientSecret)
      : (existing?.clientSecretEncrypted ?? null);
    const developerTokenEncrypted = input.developerToken
      ? this.crypto.encryptString(input.developerToken)
      : (existing?.developerTokenEncrypted ?? null);
    const refreshTokenEncrypted = input.refreshToken
      ? this.crypto.encryptString(input.refreshToken)
      : (existing?.refreshTokenEncrypted ?? null);
    const customerId = input.customerId ?? existing?.customerId ?? null;
    const loginCustomerId =
      input.loginCustomerId !== undefined
        ? input.loginCustomerId || null
        : (existing?.loginCustomerId ?? null);

    if (
      input.enabled &&
      !(
        clientId &&
        clientSecretEncrypted &&
        developerTokenEncrypted &&
        refreshTokenEncrypted &&
        customerId
      )
    ) {
      throw new BadRequestException({
        code: 'google_ads_credentials_required',
        message: 'Faltan credenciales de Google Ads para activar la integración',
      });
    }

    await this.prisma.withTenant(
      (tx) =>
        tx.googleAdsSettings.upsert({
          where: { tenantId },
          create: {
            tenantId,
            clientId,
            clientSecretEncrypted,
            developerTokenEncrypted,
            refreshTokenEncrypted,
            customerId,
            loginCustomerId,
            enabled: input.enabled,
          },
          update: {
            clientId,
            clientSecretEncrypted,
            developerTokenEncrypted,
            refreshTokenEncrypted,
            customerId,
            loginCustomerId,
            enabled: input.enabled,
            // Al reconfigurar limpiamos el último error.
            ...(input.clientId || input.refreshToken ? { lastError: null } : {}),
          },
        }),
      tenantId,
    );
    return this.get(tenantId);
  }

  /** Credenciales descifradas, o null si la integración no está activa/completa. */
  async getCredentials(tenantId: string): Promise<GoogleAdsCredentials | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.googleAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (
      !row?.enabled ||
      !row.clientId ||
      !row.clientSecretEncrypted ||
      !row.developerTokenEncrypted ||
      !row.refreshTokenEncrypted ||
      !row.customerId
    ) {
      return null;
    }
    return {
      clientId: row.clientId,
      clientSecret: this.crypto.decryptString(row.clientSecretEncrypted),
      developerToken: this.crypto.decryptString(row.developerTokenEncrypted),
      refreshToken: this.crypto.decryptString(row.refreshTokenEncrypted),
      customerId: row.customerId,
      loginCustomerId: row.loginCustomerId,
    };
  }

  async test(tenantId: string): Promise<AdPlatformTestResultDto> {
    const creds = await this.getCredentials(tenantId);
    if (!creds) {
      return { ok: false, message: 'Faltan credenciales o la integración no está activa' };
    }
    try {
      await new GoogleAdsClient(creds).testConnection();
      return { ok: true, message: 'Conexión correcta con Google Ads' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Error de conexión' };
    }
  }

  async recordSyncResult(tenantId: string, error: string | null): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.googleAdsSettings.updateMany({
          where: { tenantId },
          data: { lastSyncAt: new Date(), lastError: error },
        }),
      tenantId,
    );
  }
}
