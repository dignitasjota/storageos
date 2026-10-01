import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TtlCache } from '../../common/cache/ttl-cache';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { platformFrom, sanitizeDisplayName, type EmailAddress } from './providers/email-provider';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';
import type {
  EffectivePlatformSenderDto,
  PlatformEmailProvider,
  PlatformEmailSettingsDto,
  PlatformSenderCategory,
  PlatformSenderDto,
  PlatformSendersDto,
  UpdatePlatformEmailSettingsInput,
  UpdatePlatformSendersInput,
} from '@storageos/shared';

export type EmailProviderKey = 'smtp' | 'brevo' | 'resend';

type SenderKey = 'default' | PlatformSenderCategory;
const SENDER_KEYS: SenderKey[] = [
  'default',
  'account',
  'billing',
  'admin_messages',
  'staff_notices',
];

interface StoredSettings {
  provider: PlatformEmailProvider | null;
  fallbackEnabled: boolean;
  senders: Partial<Record<SenderKey, PlatformSenderDto>>;
}

/** Remitente y dirección de respuesta de un correo de la plataforma. */
export interface PlatformSender {
  from: EmailAddress;
  replyTo?: EmailAddress;
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
    return this.get();
  }

  // -------------------------------------------------------------------------
  // Remitentes de la plataforma
  // -------------------------------------------------------------------------

  async getSenders(): Promise<PlatformSendersDto> {
    return this.sendersDto((await this.stored()).senders);
  }

  async updateSenders(input: UpdatePlatformSendersInput): Promise<PlatformSendersDto> {
    const senders: Partial<Record<SenderKey, PlatformSenderDto>> = {};
    for (const key of SENDER_KEYS) {
      const v = input[key];
      if (!v) continue;
      const clean: PlatformSenderDto = {
        name: v.name?.trim() ? sanitizeDisplayName(v.name) : null,
        email: v.email?.trim() || null,
        replyTo: v.replyTo?.trim() || null,
      };
      if (clean.name || clean.email || clean.replyTo) senders[key] = clean;
    }
    const current = await this.admin.platformEmailSettings.findFirst();
    const data = { senders: senders as Prisma.InputJsonValue };
    if (current) {
      await this.admin.platformEmailSettings.update({ where: { id: current.id }, data });
    } else {
      await this.admin.platformEmailSettings.create({ data });
    }
    this.cache.clear();
    return this.sendersDto(senders);
  }

  /**
   * Remitente de un correo de la plataforma: lo del tipo de correo, si no lo
   * común, si no las variables `EMAIL_FROM_*` (campo a campo). Nunca lanza.
   */
  async platformSender(category?: PlatformSenderCategory): Promise<PlatformSender> {
    const stored = await this.stored().catch(
      (): StoredSettings => ({ provider: null, fallbackEnabled: true, senders: {} }),
    );
    const e = this.effective(stored.senders, category ?? 'default');
    return {
      from: { email: e.email, ...(e.name ? { name: e.name } : {}) },
      ...(e.replyTo ? { replyTo: { email: e.replyTo, ...(e.name ? { name: e.name } : {}) } } : {}),
    };
  }

  private effective(
    senders: Partial<Record<SenderKey, PlatformSenderDto>>,
    key: SenderKey,
  ): EffectivePlatformSenderDto {
    const env = platformFrom(this.config);
    const own = key === 'default' ? undefined : senders[key];
    const common = senders.default;
    return {
      name: own?.name ?? common?.name ?? env.name ?? '',
      email: own?.email ?? common?.email ?? env.email,
      replyTo: own?.replyTo ?? common?.replyTo ?? null,
    };
  }

  private sendersDto(senders: Partial<Record<SenderKey, PlatformSenderDto>>): PlatformSendersDto {
    const empty: PlatformSenderDto = { name: null, email: null, replyTo: null };
    const env = platformFrom(this.config);
    return {
      env: { name: env.name ?? '', email: env.email },
      default: senders.default ?? empty,
      categories: {
        account: senders.account ?? empty,
        billing: senders.billing ?? empty,
        admin_messages: senders.admin_messages ?? empty,
        staff_notices: senders.staff_notices ?? empty,
      },
      effective: {
        default: this.effective(senders, 'default'),
        account: this.effective(senders, 'account'),
        billing: this.effective(senders, 'billing'),
        admin_messages: this.effective(senders, 'admin_messages'),
        staff_notices: this.effective(senders, 'staff_notices'),
      },
    };
  }

  /**
   * Orden de proveedores a intentar en un envío. Nunca lanza: si no se puede
   * leer el ajuste, usa el de la variable de entorno.
   */
  async sendOrder(force?: PlatformEmailProvider): Promise<EmailProviderKey[]> {
    // Envío que solo puede salir por un proveedor (dominio del tenant en Brevo):
    // sin respaldo, porque el otro rechazaría el remitente.
    if (force && this.isConfigured(force)) return [force];
    const stored = await this.stored().catch(
      (): StoredSettings => ({ provider: null, fallbackEnabled: false, senders: {} }),
    );
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
        senders: parseSenders(row?.senders),
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
      fromAddress: this.effective(stored.senders, 'default').email,
      deliveryWebhooks: {
        brevo: {
          url: `${this.apiBase()}/webhooks/email-events/brevo`,
          configured: Boolean(this.config.get('EMAIL_WEBHOOK_TOKEN', { infer: true })),
        },
        resend: {
          url: `${this.apiBase()}/webhooks/email-events/resend`,
          configured: Boolean(this.config.get('RESEND_WEBHOOK_SECRET', { infer: true })),
        },
      },
    };
  }

  private apiBase(): string {
    return this.config.get('API_BASE_URL', { infer: true }).replace(/\/$/, '');
  }
}

function parseSenders(raw: unknown): Partial<Record<SenderKey, PlatformSenderDto>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<SenderKey, PlatformSenderDto>> = {};
  for (const key of SENDER_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
    out[key] = { name: str(r.name), email: str(r.email), replyTo: str(r.replyTo) };
  }
  return out;
}
