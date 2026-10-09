import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PLATFORM_EMAIL_KIND_INFO,
  PLATFORM_SENDER_PARENT,
  PLATFORM_EMAIL_KINDS,
  renderSenderName,
  type PlatformEmailKind,
} from '@storageos/shared';

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
  'subscription',
  'billing',
  'admin_messages',
  'web_contact',
  'staff_notices',
];

interface StoredSettings {
  provider: PlatformEmailProvider | null;
  fallbackEnabled: boolean;
  senders: Partial<Record<SenderKey, PlatformSenderDto>>;
  /** Texto de `{tipo}` cambiado por correo (ausente = el de por defecto). */
  tipoLabels: Partial<Record<PlatformEmailKind, string>>;
}

const EMPTY_STORED: StoredSettings = {
  provider: null,
  fallbackEnabled: true,
  senders: {},
  tipoLabels: {},
};

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
    const stored = await this.stored();
    return this.sendersDto(stored.senders, stored.tipoLabels);
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
    // Textos de {tipo}: solo cambian los que llegan (null = volver al de por defecto).
    const tipoLabels = { ...parseTipoLabels(current?.tipoLabels) };
    for (const [k, v] of Object.entries(input.tipoLabels ?? {})) {
      if (!(PLATFORM_EMAIL_KINDS as readonly string[]).includes(k)) continue;
      const kind = k as PlatformEmailKind;
      if (v === null || v === undefined) delete tipoLabels[kind];
      else tipoLabels[kind] = sanitizeDisplayName(v);
    }
    const data = {
      senders: senders as Prisma.InputJsonValue,
      tipoLabels: tipoLabels as Prisma.InputJsonValue,
    };
    if (current) {
      await this.admin.platformEmailSettings.update({ where: { id: current.id }, data });
    } else {
      await this.admin.platformEmailSettings.create({ data });
    }
    this.cache.clear();
    return this.sendersDto(senders, tipoLabels);
  }

  /**
   * Remitente de un correo de la plataforma. El correo concreto (`kind`)
   * decide el tipo y el texto de `{tipo}` del nombre; sin él se usa `category`
   * (o el común) y la variable desaparece del nombre. Campo a campo: lo del
   * tipo, si no lo común, si no las variables `EMAIL_FROM_*`. Nunca lanza.
   */
  async platformSender(
    category?: PlatformSenderCategory,
    kind?: PlatformEmailKind,
  ): Promise<PlatformSender> {
    const stored = await this.stored().catch((): StoredSettings => EMPTY_STORED);
    const key: SenderKey = kind ? PLATFORM_EMAIL_KIND_INFO[kind].category : (category ?? 'default');
    const e = this.effective(stored.senders, key);
    const name = renderSenderName(e.name, kind ? tipoFor(stored.tipoLabels, kind) : '');
    return {
      from: { email: e.email, ...(name ? { name } : {}) },
      ...(e.replyTo ? { replyTo: { email: e.replyTo, ...(name ? { name } : {}) } } : {}),
    };
  }

  private effective(
    senders: Partial<Record<SenderKey, PlatformSenderDto>>,
    key: SenderKey,
  ): EffectivePlatformSenderDto {
    const env = platformFrom(this.config);
    const own = key === 'default' ? undefined : senders[key];
    // Un tipo sin remitente propio usa antes el de su «padre» (el formulario de
    // contacto → Mensajes del administrador) y después el común.
    const parentKey = key === 'default' ? undefined : PLATFORM_SENDER_PARENT[key];
    const parent = parentKey ? senders[parentKey] : undefined;
    const common = senders.default;
    return {
      name: own?.name ?? parent?.name ?? common?.name ?? env.name ?? '',
      email: own?.email ?? parent?.email ?? common?.email ?? env.email,
      replyTo: own?.replyTo ?? parent?.replyTo ?? common?.replyTo ?? null,
    };
  }

  private sendersDto(
    senders: Partial<Record<SenderKey, PlatformSenderDto>>,
    tipoLabels: Partial<Record<PlatformEmailKind, string>>,
  ): PlatformSendersDto {
    const empty: PlatformSenderDto = { name: null, email: null, replyTo: null };
    const env = platformFrom(this.config);
    const kinds = Object.fromEntries(
      PLATFORM_EMAIL_KINDS.map((kind) => {
        const e = this.effective(senders, PLATFORM_EMAIL_KIND_INFO[kind].category);
        const tipo = tipoFor(tipoLabels, kind);
        return [
          kind,
          {
            tipo,
            isDefault: tipoLabels[kind] === undefined,
            fromName: renderSenderName(e.name, tipo),
            fromEmail: e.email,
          },
        ];
      }),
    ) as PlatformSendersDto['kinds'];
    return {
      env: { name: env.name ?? '', email: env.email },
      default: senders.default ?? empty,
      categories: {
        account: senders.account ?? empty,
        subscription: senders.subscription ?? empty,
        billing: senders.billing ?? empty,
        admin_messages: senders.admin_messages ?? empty,
        web_contact: senders.web_contact ?? empty,
        staff_notices: senders.staff_notices ?? empty,
      },
      effective: {
        default: this.effective(senders, 'default'),
        account: this.effective(senders, 'account'),
        subscription: this.effective(senders, 'subscription'),
        billing: this.effective(senders, 'billing'),
        admin_messages: this.effective(senders, 'admin_messages'),
        web_contact: this.effective(senders, 'web_contact'),
        staff_notices: this.effective(senders, 'staff_notices'),
      },
      kinds,
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
      (): StoredSettings => ({ ...EMPTY_STORED, fallbackEnabled: false }),
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
        tipoLabels: parseTipoLabels(row?.tipoLabels),
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

function parseTipoLabels(raw: unknown): Partial<Record<PlatformEmailKind, string>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<PlatformEmailKind, string>> = {};
  for (const kind of PLATFORM_EMAIL_KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (typeof v === 'string') out[kind] = v;
  }
  return out;
}

/** Texto de `{tipo}` de un correo: el cambiado o el de por defecto. */
function tipoFor(
  labels: Partial<Record<PlatformEmailKind, string>>,
  kind: PlatformEmailKind,
): string {
  return labels[kind] ?? PLATFORM_EMAIL_KIND_INFO[kind].defaultTipo;
}
