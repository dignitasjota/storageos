import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { isValidCreditorId } from '@storageos/shared';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import type { PlatformSepaSettingsDto, UpdatePlatformSepaSettingsInput } from '@storageos/shared';

/** AAD fijo para el IBAN del acreedor de plataforma (sin scope de tenant). */
const CREDITOR_AAD = 'platform-sepa-settings';

/**
 * Config del acreedor SEPA de LA PLATAFORMA (la cuenta bancaria de Jota,
 * p.ej. BBVA) usada para domiciliar la cuota de los tenants en modo 'sepa'.
 * Singleton — mismo patrón que `PlatformDunningService.getSettings()`
 * (`findFirst() ?? create()`, sin id fijo).
 */
@Injectable()
export class PlatformSepaSettingsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
  ) {}

  async getSettings(): Promise<PlatformSepaSettingsDto> {
    const row = await this.admin.platformSepaSettings.findFirst();
    if (!row?.creditorIbanEncrypted) {
      return {
        configured: false,
        creditorName: row?.creditorName ?? '',
        creditorId: row?.creditorId ?? '',
        creditorIbanLast4: null,
        creditorBic: row?.creditorBic ?? null,
        enabled: row?.enabled ?? false,
        creditorAddress: row?.creditorAddress ?? null,
        creditorPostalCode: row?.creditorPostalCode ?? null,
        creditorCity: row?.creditorCity ?? null,
        creditorCountry: row?.creditorCountry ?? 'ES',
        prenoticeDays: row?.prenoticeDays ?? 5,
        autoPrepare: row?.autoPrepare ?? false,
      };
    }
    const iban = this.crypto.decryptString(row.creditorIbanEncrypted, CREDITOR_AAD);
    return {
      configured: true,
      creditorName: row.creditorName,
      creditorId: row.creditorId,
      creditorIbanLast4: iban.slice(-4),
      creditorBic: row.creditorBic,
      enabled: row.enabled,
      creditorAddress: row.creditorAddress,
      creditorPostalCode: row.creditorPostalCode,
      creditorCity: row.creditorCity,
      creditorCountry: row.creditorCountry,
      prenoticeDays: row.prenoticeDays,
      autoPrepare: row.autoPrepare,
    };
  }

  async updateSettings(input: UpdatePlatformSepaSettingsInput): Promise<PlatformSepaSettingsDto> {
    const existing = await this.admin.platformSepaSettings.findFirst();
    // El IBAN es opcional al actualizar: si no se reescribe, se conserva el actual.
    if (!input.creditorIban && !existing?.creditorIbanEncrypted) {
      throw new BadRequestException({
        code: 'iban_required',
        message: 'El IBAN del acreedor es obligatorio en la primera configuración',
      });
    }
    // El identificador va impreso en los mandatos firmados: cambiarlo obligaría
    // a presentar cada adeudo siguiente como una modificación del mandato.
    if (
      existing?.creditorId &&
      existing.creditorId !== input.creditorId &&
      isValidCreditorId(existing.creditorId)
    ) {
      const signed = await this.admin.platformSepaMandate.count({
        where: { status: 'active', signatureStatus: { in: ['signed', 'external'] } },
      });
      if (signed > 0) {
        throw new ConflictException({
          code: 'creditor_id_locked',
          message:
            'No puedes cambiar el identificador del acreedor: aparece en los mandatos ya firmados por los tenants.',
          details: { signedMandates: signed },
        });
      }
    }
    const creditorIbanEncrypted = input.creditorIban
      ? this.crypto.encryptString(input.creditorIban, CREDITOR_AAD)
      : existing!.creditorIbanEncrypted;
    const data = {
      creditorName: input.creditorName,
      creditorId: input.creditorId,
      creditorIbanEncrypted,
      creditorBic: input.creditorBic || null,
      enabled: input.enabled,
      ...(input.creditorAddress !== undefined
        ? { creditorAddress: input.creditorAddress || null }
        : {}),
      ...(input.creditorPostalCode !== undefined
        ? { creditorPostalCode: input.creditorPostalCode || null }
        : {}),
      ...(input.creditorCity !== undefined ? { creditorCity: input.creditorCity || null } : {}),
      ...(input.creditorCountry ? { creditorCountry: input.creditorCountry } : {}),
      ...(input.prenoticeDays ? { prenoticeDays: input.prenoticeDays } : {}),
      ...(input.autoPrepare !== undefined ? { autoPrepare: input.autoPrepare } : {}),
    };
    if (existing) {
      await this.admin.platformSepaSettings.update({ where: { id: existing.id }, data });
    } else {
      await this.admin.platformSepaSettings.create({ data });
    }
    return this.getSettings();
  }
}
