import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../database/prisma.service';

import { HoldedClient } from './holded.client';

import type {
  HoldedSettingsDto,
  HoldedTestResultDto,
  UpdateHoldedSettingsInput,
} from '@storageos/shared';

@Injectable()
export class HoldedSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get(tenantId: string): Promise<HoldedSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.holdedSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      enabled: row?.enabled ?? false,
      hasApiKey: !!row?.apiKeyEncrypted,
      lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
    };
  }

  async update(tenantId: string, input: UpdateHoldedSettingsInput): Promise<HoldedSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.holdedSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (input.enabled && !input.apiKey && !existing?.apiKeyEncrypted) {
      throw new BadRequestException({
        code: 'holded_api_key_required',
        message: 'Necesitas una API key de Holded para activar la integración',
      });
    }
    const apiKeyEncrypted = input.apiKey
      ? this.crypto.encryptString(input.apiKey)
      : existing?.apiKeyEncrypted;

    await this.prisma.withTenant(
      (tx) =>
        tx.holdedSettings.upsert({
          where: { tenantId },
          create: {
            tenantId,
            apiKeyEncrypted: apiKeyEncrypted ?? '',
            enabled: input.enabled,
          },
          update: {
            ...(apiKeyEncrypted ? { apiKeyEncrypted } : {}),
            enabled: input.enabled,
            // Al reconfigurar limpiamos el último error.
            ...(input.apiKey ? { lastError: null } : {}),
          },
        }),
      tenantId,
    );
    return this.get(tenantId);
  }

  /** Devuelve la API key descifrada, o null si no hay. */
  async getApiKey(tenantId: string): Promise<string | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.holdedSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row?.apiKeyEncrypted) return null;
    return this.crypto.decryptString(row.apiKeyEncrypted);
  }

  async test(tenantId: string): Promise<HoldedTestResultDto> {
    const apiKey = await this.getApiKey(tenantId);
    if (!apiKey) {
      return { ok: false, message: 'No hay API key configurada' };
    }
    try {
      await new HoldedClient(apiKey).testConnection();
      return { ok: true, message: 'Conexión correcta con Holded' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Error de conexión' };
    }
  }
}
