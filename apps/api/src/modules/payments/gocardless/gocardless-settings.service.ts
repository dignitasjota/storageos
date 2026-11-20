import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../database/prisma.service';

import type { GoCardlessEnvironment } from './gocardless-client';
import type { Env } from '../../../config/env.schema';
import type { GoCardlessSettingsDto, UpdateGoCardlessSettingsInput } from '@storageos/shared';

@Injectable()
export class GoCardlessSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async get(tenantId: string): Promise<GoCardlessSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.goCardlessSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      environment: (row?.environment as GoCardlessEnvironment) ?? 'sandbox',
      enabled: row?.enabled ?? false,
      hasAccessToken: !!row?.accessTokenEncrypted,
      hasWebhookSecret: !!row?.webhookSecretEncrypted,
      webhookUrl: `${this.config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '')}/webhooks/gocardless/${tenantId}`,
    };
  }

  async update(
    tenantId: string,
    input: UpdateGoCardlessSettingsInput,
  ): Promise<GoCardlessSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.goCardlessSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    const accessTokenEncrypted = input.accessToken
      ? this.crypto.encryptString(input.accessToken, tenantId)
      : existing?.accessTokenEncrypted;
    const webhookSecretEncrypted = input.webhookSecret
      ? this.crypto.encryptString(input.webhookSecret, tenantId)
      : existing?.webhookSecretEncrypted;
    if (input.enabled && (!accessTokenEncrypted || !webhookSecretEncrypted)) {
      throw new BadRequestException({
        code: 'gocardless_credentials_required',
        message: 'Necesitas el access token y el webhook secret de GoCardless para activar',
      });
    }

    await this.prisma.withTenant(
      (tx) =>
        tx.goCardlessSettings.upsert({
          where: { tenantId },
          create: {
            tenantId,
            accessTokenEncrypted: accessTokenEncrypted ?? '',
            webhookSecretEncrypted: webhookSecretEncrypted ?? '',
            environment: input.environment,
            enabled: input.enabled,
          },
          update: {
            ...(accessTokenEncrypted ? { accessTokenEncrypted } : {}),
            ...(webhookSecretEncrypted ? { webhookSecretEncrypted } : {}),
            environment: input.environment,
            enabled: input.enabled,
          },
        }),
      tenantId,
    );
    return this.get(tenantId);
  }

  /** Config completa (con secretos descifrados) para llamar a la API / verificar webhooks. Null si falta. */
  async getResolved(tenantId: string): Promise<{
    accessToken: string;
    webhookSecret: string;
    environment: GoCardlessEnvironment;
    enabled: boolean;
  } | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.goCardlessSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row?.accessTokenEncrypted) return null;
    return {
      accessToken: this.crypto.decryptString(row.accessTokenEncrypted, tenantId),
      webhookSecret: row.webhookSecretEncrypted
        ? this.crypto.decryptString(row.webhookSecretEncrypted, tenantId)
        : '',
      environment: row.environment as GoCardlessEnvironment,
      enabled: row.enabled,
    };
  }
}
