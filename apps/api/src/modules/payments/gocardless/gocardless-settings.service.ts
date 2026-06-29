import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../database/prisma.service';

import type { GoCardlessEnvironment } from './gocardless-client';
import type { GoCardlessSettingsDto, UpdateGoCardlessSettingsInput } from '@storageos/shared';

@Injectable()
export class GoCardlessSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
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
      ? this.crypto.encryptString(input.accessToken)
      : existing?.accessTokenEncrypted;
    const webhookSecretEncrypted = input.webhookSecret
      ? this.crypto.encryptString(input.webhookSecret)
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
      accessToken: this.crypto.decryptString(row.accessTokenEncrypted),
      webhookSecret: row.webhookSecretEncrypted
        ? this.crypto.decryptString(row.webhookSecretEncrypted)
        : '',
      environment: row.environment as GoCardlessEnvironment,
      enabled: row.enabled,
    };
  }
}
