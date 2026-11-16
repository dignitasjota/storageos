import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../database/prisma.service';

import { adConversionStats, retryFailedConversions } from './ad-conversion-stats';
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
    const [row, conversions] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.googleAdsSettings.findUnique({ where: { tenantId } }),
          adConversionStats(tx, 'google_ads'),
        ]),
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
      conversionActionId: row?.conversionActionId ?? null,
      lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      conversions,
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
      ? this.crypto.encryptString(input.clientSecret, tenantId)
      : (existing?.clientSecretEncrypted ?? null);
    const developerTokenEncrypted = input.developerToken
      ? this.crypto.encryptString(input.developerToken, tenantId)
      : (existing?.developerTokenEncrypted ?? null);
    const refreshTokenEncrypted = input.refreshToken
      ? this.crypto.encryptString(input.refreshToken, tenantId)
      : (existing?.refreshTokenEncrypted ?? null);
    const customerId = input.customerId ?? existing?.customerId ?? null;
    const loginCustomerId =
      input.loginCustomerId !== undefined
        ? input.loginCustomerId || null
        : (existing?.loginCustomerId ?? null);
    const conversionActionId =
      input.conversionActionId !== undefined
        ? input.conversionActionId || null
        : (existing?.conversionActionId ?? null);

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

    await this.prisma.withTenant(async (tx) => {
      await tx.googleAdsSettings.upsert({
        where: { tenantId },
        create: {
          tenantId,
          clientId,
          clientSecretEncrypted,
          developerTokenEncrypted,
          refreshTokenEncrypted,
          customerId,
          loginCustomerId,
          conversionActionId,
          enabled: input.enabled,
        },
        update: {
          clientId,
          clientSecretEncrypted,
          developerTokenEncrypted,
          refreshTokenEncrypted,
          customerId,
          loginCustomerId,
          conversionActionId,
          enabled: input.enabled,
          // Al reconfigurar limpiamos el último error.
          ...(input.clientId || input.refreshToken ? { lastError: null } : {}),
        },
      });
      // Otra configuración: los envíos que fallaron se vuelven a intentar.
      await retryFailedConversions(tx, 'google_ads');
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
  ): Promise<GoogleAdsCredentials | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.googleAdsSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (
      !row ||
      (requireEnabled && !row.enabled) ||
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
      clientSecret: this.crypto.decryptString(row.clientSecretEncrypted, tenantId),
      developerToken: this.crypto.decryptString(row.developerTokenEncrypted, tenantId),
      refreshToken: this.crypto.decryptString(row.refreshTokenEncrypted, tenantId),
      customerId: row.customerId,
      loginCustomerId: row.loginCustomerId,
    };
  }

  /** Credenciales y acción de conversión, si está activa y completa. */
  async getConversionTarget(
    tenantId: string,
  ): Promise<{ credentials: GoogleAdsCredentials; conversionActionId: string } | null> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.googleAdsSettings.findUnique({
          where: { tenantId },
          select: { conversionActionId: true },
        }),
      tenantId,
    );
    if (!row?.conversionActionId) return null;
    const credentials = await this.getCredentials(tenantId);
    return credentials ? { credentials, conversionActionId: row.conversionActionId } : null;
  }

  /** Prueba las credenciales guardadas, también antes de activar la integración. */
  async test(tenantId: string): Promise<AdPlatformTestResultDto> {
    const creds = await this.getCredentials(tenantId, false);
    if (!creds) {
      return { ok: false, message: 'Faltan credenciales: guárdalas antes de probar' };
    }
    try {
      await new GoogleAdsClient(creds).testConnection();
      return { ok: true, message: 'Conexión correcta con Google Ads' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Error de conexión' };
    }
  }

  /** Borra las credenciales (la integración queda desactivada). */
  async remove(tenantId: string): Promise<GoogleAdsSettingsDto> {
    await this.prisma.withTenant(
      (tx) => tx.googleAdsSettings.deleteMany({ where: { tenantId } }),
      tenantId,
    );
    return this.get(tenantId);
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
