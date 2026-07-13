import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../database/prisma.service';

import type { RedsysSettingsDto, UpdateRedsysSettingsInput } from '@storageos/shared';

@Injectable()
export class RedsysSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get(tenantId: string): Promise<RedsysSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.redsysSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      merchantCode: row?.merchantCode ?? '',
      terminal: row?.terminal ?? '1',
      environment: (row?.environment as 'test' | 'live') ?? 'test',
      enabled: row?.enabled ?? false,
      bizumEnabled: row?.bizumEnabled ?? false,
      hasSecretKey: !!row?.secretKeyEncrypted,
    };
  }

  async update(tenantId: string, input: UpdateRedsysSettingsInput): Promise<RedsysSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.redsysSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    const secretKeyEncrypted = input.secretKey
      ? this.crypto.encryptString(input.secretKey)
      : existing?.secretKeyEncrypted;
    if (input.enabled && !secretKeyEncrypted) {
      throw new BadRequestException({
        code: 'redsys_secret_required',
        message: 'Necesitas la clave secreta de Redsys para activar',
      });
    }

    await this.prisma.withTenant(
      (tx) =>
        tx.redsysSettings.upsert({
          where: { tenantId },
          create: {
            tenantId,
            merchantCode: input.merchantCode,
            terminal: input.terminal,
            secretKeyEncrypted: secretKeyEncrypted ?? '',
            environment: input.environment,
            enabled: input.enabled,
            bizumEnabled: input.bizumEnabled,
          },
          update: {
            merchantCode: input.merchantCode,
            terminal: input.terminal,
            ...(secretKeyEncrypted ? { secretKeyEncrypted } : {}),
            environment: input.environment,
            enabled: input.enabled,
            bizumEnabled: input.bizumEnabled,
          },
        }),
      tenantId,
    );
    return this.get(tenantId);
  }

  /** Config completa (con clave descifrada) para firmar/verificar. Null si falta. */
  async getResolved(tenantId: string): Promise<{
    merchantCode: string;
    terminal: string;
    secretKey: string;
    environment: 'test' | 'live';
    enabled: boolean;
    bizumEnabled: boolean;
  } | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.redsysSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row?.secretKeyEncrypted) return null;
    return {
      merchantCode: row.merchantCode,
      terminal: row.terminal,
      secretKey: this.crypto.decryptString(row.secretKeyEncrypted),
      environment: row.environment as 'test' | 'live',
      enabled: row.enabled,
      bizumEnabled: row.bizumEnabled,
    };
  }
}
