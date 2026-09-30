import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TtlCache } from '../../common/cache/ttl-cache';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type {
  PlatformEmailProvider,
  PlatformEmailSettingsDto,
  UpdatePlatformEmailSettingsInput,
} from '@storageos/shared';

export type EmailProviderKey = 'smtp' | 'brevo' | 'resend';

interface StoredSettings {
  provider: PlatformEmailProvider | null;
  fallbackEnabled: boolean;
}

/**
 * Qué proveedor de correo usa la plataforma. Las claves viven en variables de
 * entorno (`BREVO_API_KEY`, `RESEND_API_KEY`); el super admin elige en el panel
 * cuál es el principal y si, al fallar, se reintenta con el otro (p. ej. al
 * agotar el cupo gratuito diario). La elección se cachea 30 s: el cambio llega
 * al API y al worker en menos de un minuto.
 */
@Injectable()
export class PlatformEmailSettingsService {
  private readonly cache = new TtlCache<StoredSettings>(
    process.env.NODE_ENV === 'test' ? 0 : 30_000,
  );

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async get(): Promise<PlatformEmailSettingsDto> {
    const stored = await this.stored();
    return this.toDto(stored);
  }

  async update(input: UpdatePlatformEmailSettingsInput): Promise<PlatformEmailSettingsDto> {
    const current = await this.admin.platformEmailSettings.findFirst();
    const data = { provider: input.provider, fallbackEnabled: input.fallbackEnabled };
    if (current) {
      await this.admin.platformEmailSettings.update({ where: { id: current.id }, data });
    } else {
      await this.admin.platformEmailSettings.create({ data });
    }
    this.cache.clear();
    return this.toDto({ provider: input.provider, fallbackEnabled: input.fallbackEnabled });
  }

  /**
   * Orden de proveedores a intentar en un envío. Nunca lanza: si no se puede
   * leer el ajuste, usa el de la variable de entorno.
   */
  async sendOrder(force?: PlatformEmailProvider): Promise<EmailProviderKey[]> {
    // Envío que solo puede salir por un proveedor (dominio del tenant en Brevo):
    // sin respaldo, porque el otro rechazaría el remitente.
    if (force && this.isConfigured(force)) return [force];
    const stored = await this.stored().catch(() => ({ provider: null, fallbackEnabled: false }));
    return this.computeOrder(stored);
  }

  private computeOrder(stored: StoredSettings): EmailProviderKey[] {
    const envProvider = this.config.get('EMAIL_PROVIDER', { infer: true });
    const available = (['brevo', 'resend'] as const).filter((p) => this.isConfigured(p));
    // Sin ninguna API configurada (dev/test con Mailpit, o relay SMTP): la variable manda.
    if (available.length === 0) return [envProvider];

    const primary: EmailProviderKey =
      stored.provider && available.includes(stored.provider)
        ? stored.provider
        : envProvider !== 'smtp' && available.includes(envProvider)
          ? envProvider
          : available[0]!;
    const order: EmailProviderKey[] = [primary];
    if (stored.fallbackEnabled) {
      for (const p of available) if (!order.includes(p)) order.push(p);
    }
    return order;
  }

  private isConfigured(provider: PlatformEmailProvider): boolean {
    const key =
      provider === 'brevo'
        ? this.config.get('BREVO_API_KEY', { infer: true })
        : this.config.get('RESEND_API_KEY', { infer: true });
    return Boolean(key);
  }

  private stored(): Promise<StoredSettings> {
    return this.cache.get('settings', async () => {
      const row = await this.admin.platformEmailSettings.findFirst();
      return {
        provider: (row?.provider as PlatformEmailProvider | null | undefined) ?? null,
        fallbackEnabled: row?.fallbackEnabled ?? true,
      };
    });
  }

  private toDto(stored: StoredSettings): PlatformEmailSettingsDto {
    return {
      provider: stored.provider,
      fallbackEnabled: stored.fallbackEnabled,
      envProvider: this.config.get('EMAIL_PROVIDER', { infer: true }),
      configured: { brevo: this.isConfigured('brevo'), resend: this.isConfigured('resend') },
      effectiveOrder: this.computeOrder(stored),
      fromAddress: this.config.get('EMAIL_FROM_ADDRESS', { infer: true }),
    };
  }
}
