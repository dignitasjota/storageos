import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AdminTenantWhatsappAiDto,
  isWhatsappAiProvider,
  type PlatformWhatsappAiDto,
  type PublicLandingDto,
  type UpdateAdminTenantWhatsappAiInput,
  type UpdatePlatformWhatsappAiInput,
  type UpdateWhatsappAssistantInput,
  type WhatsappAiMode,
  type WhatsappAiTestResultDto,
  type WhatsappAiUsageDto,
  type WhatsappAssistantDto,
} from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { LandingService } from '../landing/landing.service';
import { NotificationsService } from '../notifications/notifications.service';

import {
  HANDOFF_MARKER,
  type WhatsappAiConfig,
  WhatsappAiClient,
  type WhatsappAiTurn,
} from './whatsapp-ai.client';
import { WhatsappCloudClient } from './whatsapp-cloud.client';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';

const PLATFORM_AAD = 'platform-whatsapp-ai';
const HISTORY_MESSAGES = 20;
const PREVIEW_LENGTH = 120;

type ResolvedAi =
  | { ok: true; config: WhatsappAiConfig; source: 'platform' | 'own' }
  | { ok: false; reason: 'limit_reached' | 'no_ai' };

/** Mes en curso (AAAA-MM) y su comienzo, en hora de Madrid. */
function currentMonth(now = new Date()): { key: string; start: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  return { key: `${y}-${String(m).padStart(2, '0')}`, start: new Date(Date.UTC(y, m - 1, 1)) };
}

/**
 * Asistente de IA del WhatsApp Business de los tenants. Usa la IA de WhatsApp
 * de la plataforma (con un límite mensual de respuestas por tenant) o la clave
 * propia del tenant: el super admin decide el modo, y si con la de la
 * plataforma se llega al límite y el tenant tiene clave propia, se cambia sola
 * a la suya hasta el mes siguiente. Responde con los datos públicos del negocio
 * (locales, horarios, tamaños, precios con IVA, disponibilidad, promoción y
 * preguntas frecuentes); si no sabe o el cliente pide una persona, se calla en
 * esa conversación y avisa al equipo.
 */
@Injectable()
export class WhatsappAssistantService {
  private readonly logger = new Logger(WhatsappAssistantService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly ai: WhatsappAiClient,
    private readonly cloud: WhatsappCloudClient,
    private readonly landing: LandingService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ─── IA de WhatsApp de la plataforma (panel admin) ─────────────────────────

  private async platformRow() {
    return (
      (await this.admin.platformWhatsappAiSettings.findFirst()) ??
      (await this.admin.platformWhatsappAiSettings.create({ data: {} }))
    );
  }

  async getPlatform(): Promise<PlatformWhatsappAiDto> {
    const row = await this.platformRow();
    const key = row.apiKeyEncrypted ? this.decrypt(row.apiKeyEncrypted, PLATFORM_AAD) : null;
    return {
      enabled: row.enabled,
      provider: isWhatsappAiProvider(row.provider) ? row.provider : 'anthropic',
      model: row.model,
      baseUrl: row.baseUrl,
      keyLast4: key ? key.slice(-4) : null,
      monthlyReplyLimit: row.monthlyReplyLimit,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updatePlatform(input: UpdatePlatformWhatsappAiInput): Promise<PlatformWhatsappAiDto> {
    const row = await this.platformRow();
    const provider = input.provider ?? row.provider;
    const baseUrl = input.baseUrl !== undefined ? input.baseUrl || null : row.baseUrl;
    if (provider === 'openai_compatible' && !baseUrl) {
      throw new BadRequestException({
        code: 'ai_base_url_required',
        message: 'Indica la URL de la API del proveedor',
      });
    }
    const enabled = input.enabled ?? row.enabled;
    const hasKey = input.apiKey !== undefined || !!row.apiKeyEncrypted;
    if (enabled && (!hasKey || !(input.model ?? row.model))) {
      throw new BadRequestException({
        code: 'ai_config_incomplete',
        message: 'Para activarla hacen falta el modelo y la clave de API',
      });
    }
    await this.admin.platformWhatsappAiSettings.update({
      where: { id: row.id },
      data: {
        enabled,
        provider,
        baseUrl,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.apiKey !== undefined
          ? { apiKeyEncrypted: this.crypto.encryptString(input.apiKey, PLATFORM_AAD) }
          : {}),
        ...(input.monthlyReplyLimit !== undefined
          ? { monthlyReplyLimit: input.monthlyReplyLimit }
          : {}),
      },
    });
    return this.getPlatform();
  }

  async testPlatform(): Promise<WhatsappAiTestResultDto> {
    const config = await this.platformConfig();
    if (!config) {
      return { ok: false, sample: null, error: 'Falta el modelo o la clave de API' };
    }
    return this.test(config);
  }

  private async platformConfig(): Promise<WhatsappAiConfig | null> {
    const row = await this.platformRow();
    const apiKey = row.apiKeyEncrypted ? this.decrypt(row.apiKeyEncrypted, PLATFORM_AAD) : null;
    if (!apiKey || !row.model || !isWhatsappAiProvider(row.provider)) return null;
    return { provider: row.provider, model: row.model, baseUrl: row.baseUrl, apiKey };
  }

  private async test(config: WhatsappAiConfig): Promise<WhatsappAiTestResultDto> {
    try {
      const r = await this.ai.complete(config, 'Responde en una frase corta en español.', [
        { role: 'user', content: 'Di «hola, funciono».' },
      ]);
      return { ok: true, sample: r.text.trim().slice(0, 200), error: null };
    } catch (err) {
      return { ok: false, sample: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── IA de WhatsApp de un tenant (super admin) ─────────────────────────────

  async getForAdmin(tenantId: string): Promise<AdminTenantWhatsappAiDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    const row = await this.admin.tenantWhatsappSettings.findUnique({ where: { tenantId } });
    return {
      configured: !!row,
      displayPhone: row?.displayPhone ?? null,
      assistantEnabled: row?.assistantEnabled ?? false,
      aiMode: row?.aiMode === 'own' ? 'own' : 'platform',
      aiMonthlyLimit: row?.aiMonthlyLimit ?? null,
      ownKeyConfigured: !!row?.ownAiApiKeyEncrypted,
      ownProvider: isWhatsappAiProvider(row?.ownAiProvider) ? row.ownAiProvider : null,
      usage: await this.usage(tenantId, row?.aiMonthlyLimit ?? null),
    };
  }

  async updateForAdmin(
    tenantId: string,
    input: UpdateAdminTenantWhatsappAiInput,
  ): Promise<AdminTenantWhatsappAiDto> {
    const row = await this.admin.tenantWhatsappSettings.findUnique({ where: { tenantId } });
    if (!row) {
      throw new BadRequestException({
        code: 'whatsapp_not_configured',
        message: 'El tenant aún no ha conectado su número de WhatsApp',
      });
    }
    await this.admin.tenantWhatsappSettings.update({
      where: { tenantId },
      data: {
        ...(input.aiMode !== undefined ? { aiMode: input.aiMode } : {}),
        ...(input.aiMonthlyLimit !== undefined ? { aiMonthlyLimit: input.aiMonthlyLimit } : {}),
      },
    });
    return this.getForAdmin(tenantId);
  }

  // ─── Asistente del tenant ─────────────────────────────────────────────────

  async getForTenant(tenantId: string): Promise<WhatsappAssistantDto> {
    const row = await this.admin.tenantWhatsappSettings.findUnique({ where: { tenantId } });
    const platform = await this.platformRow();
    const ownKey = row?.ownAiApiKeyEncrypted
      ? this.decrypt(row.ownAiApiKeyEncrypted, tenantId)
      : null;
    return {
      assistantEnabled: row?.assistantEnabled ?? false,
      assistantInstructions: row?.assistantInstructions ?? null,
      aiMode: row?.aiMode === 'own' ? 'own' : 'platform',
      platformAiAvailable: platform.enabled && !!platform.apiKeyEncrypted && !!platform.model,
      ownAi:
        row && isWhatsappAiProvider(row.ownAiProvider)
          ? {
              provider: row.ownAiProvider,
              model: row.ownAiModel ?? '',
              baseUrl: row.ownAiBaseUrl,
              keyLast4: ownKey ? ownKey.slice(-4) : null,
            }
          : null,
      usage: await this.usage(tenantId, row?.aiMonthlyLimit ?? null),
    };
  }

  async updateForTenant(args: {
    tenantId: string;
    userId: string;
    input: UpdateWhatsappAssistantInput;
    meta: RequestMeta;
  }): Promise<WhatsappAssistantDto> {
    const { tenantId, input } = args;
    const row = await this.admin.tenantWhatsappSettings.findUnique({ where: { tenantId } });
    if (!row) {
      throw new BadRequestException({
        code: 'whatsapp_not_configured',
        message: 'Conecta primero tu número de WhatsApp',
      });
    }
    const provider = input.ownProvider ?? row.ownAiProvider;
    const baseUrl = input.ownBaseUrl !== undefined ? input.ownBaseUrl || null : row.ownAiBaseUrl;
    if (provider === 'openai_compatible' && !baseUrl && !input.removeOwnKey) {
      throw new BadRequestException({
        code: 'ai_base_url_required',
        message: 'Indica la URL de la API del proveedor',
      });
    }
    const data = {
      ...(input.assistantEnabled !== undefined ? { assistantEnabled: input.assistantEnabled } : {}),
      ...(input.assistantInstructions !== undefined
        ? { assistantInstructions: input.assistantInstructions || null }
        : {}),
      ...(input.removeOwnKey
        ? { ownAiProvider: null, ownAiModel: null, ownAiBaseUrl: null, ownAiApiKeyEncrypted: null }
        : {
            ...(input.ownProvider !== undefined ? { ownAiProvider: input.ownProvider } : {}),
            ...(input.ownModel !== undefined ? { ownAiModel: input.ownModel || null } : {}),
            ...(input.ownBaseUrl !== undefined ? { ownAiBaseUrl: baseUrl } : {}),
            ...(input.ownApiKey !== undefined
              ? { ownAiApiKeyEncrypted: this.crypto.encryptString(input.ownApiKey, tenantId) }
              : {}),
          }),
    };
    await this.admin.tenantWhatsappSettings.update({ where: { tenantId }, data });
    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'tenant.whatsapp.assistant_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        ...(input.assistantEnabled !== undefined
          ? { assistantEnabled: input.assistantEnabled }
          : {}),
        ...(input.ownProvider !== undefined ? { ownProvider: input.ownProvider } : {}),
        ownKeyChanged: input.ownApiKey !== undefined || !!input.removeOwnKey,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.getForTenant(tenantId);
  }

  /** Prueba la clave propia del tenant. */
  async testOwn(tenantId: string): Promise<WhatsappAiTestResultDto> {
    const config = await this.ownConfig(tenantId);
    if (!config)
      return { ok: false, sample: null, error: 'Falta el proveedor, el modelo o la clave' };
    return this.test(config);
  }

  private async ownConfig(tenantId: string): Promise<WhatsappAiConfig | null> {
    const row = await this.admin.tenantWhatsappSettings.findUnique({ where: { tenantId } });
    if (!row?.ownAiApiKeyEncrypted || !isWhatsappAiProvider(row.ownAiProvider)) return null;
    const apiKey = this.decrypt(row.ownAiApiKeyEncrypted, tenantId);
    const model = row.ownAiModel ?? '';
    if (!apiKey || !model) return null;
    return { provider: row.ownAiProvider, model, baseUrl: row.ownAiBaseUrl, apiKey };
  }

  private async usage(tenantId: string, tenantLimit: number | null): Promise<WhatsappAiUsageDto> {
    const { start } = currentMonth();
    const [platform, own, platformRow] = await Promise.all([
      this.admin.whatsappMessage.count({
        where: {
          tenantId,
          sender: 'assistant',
          aiKeySource: 'platform',
          createdAt: { gte: start },
        },
      }),
      this.admin.whatsappMessage.count({
        where: { tenantId, sender: 'assistant', aiKeySource: 'own', createdAt: { gte: start } },
      }),
      this.platformRow(),
    ]);
    return {
      platformRepliesThisMonth: platform,
      ownRepliesThisMonth: own,
      limit: tenantLimit ?? platformRow.monthlyReplyLimit,
    };
  }

  /**
   * Qué IA usar ahora. Modo «own» → siempre la del tenant. Modo «platform» →
   * la de la plataforma hasta el límite del mes; pasado el límite, la del
   * tenant si la tiene.
   */
  private async resolveAi(row: {
    tenantId: string;
    aiMode: string;
    aiMonthlyLimit: number | null;
  }): Promise<ResolvedAi> {
    const mode: WhatsappAiMode = row.aiMode === 'own' ? 'own' : 'platform';
    const own = await this.ownConfig(row.tenantId);
    if (mode === 'own') {
      return own ? { ok: true, config: own, source: 'own' } : { ok: false, reason: 'no_ai' };
    }
    const platformRow = await this.platformRow();
    const platform = platformRow.enabled ? await this.platformConfig() : null;
    if (platform) {
      const usage = await this.usage(row.tenantId, row.aiMonthlyLimit);
      if (usage.platformRepliesThisMonth < usage.limit) {
        return { ok: true, config: platform, source: 'platform' };
      }
      if (own) return { ok: true, config: own, source: 'own' };
      return { ok: false, reason: 'limit_reached' };
    }
    return own ? { ok: true, config: own, source: 'own' } : { ok: false, reason: 'no_ai' };
  }

  // ─── Respuesta a un mensaje entrante ──────────────────────────────────────

  /**
   * Llamado (sin esperar) tras guardar un mensaje entrante. Espera un momento
   * por si el contacto escribe varios mensajes seguidos: solo responde al último.
   */
  async handleInbound(args: {
    tenantId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const delay = process.env.NODE_ENV === 'test' ? 0 : 2500;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      await this.reply(args);
    } catch (err) {
      this.logger.warn(
        `whatsapp-assistant: ${args.tenantId}/${args.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async reply(args: {
    tenantId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const { tenantId, conversationId } = args;
    const settings = await this.admin.tenantWhatsappSettings.findUnique({ where: { tenantId } });
    if (!settings?.enabled || !settings.assistantEnabled) return;
    const conversation = await this.admin.whatsappConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation?.assistantEnabled) return;
    const latestIn = await this.admin.whatsappMessage.findFirst({
      where: { conversationId, direction: 'in' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (latestIn?.id !== args.messageId) return; // llegó otro después: responde a ese
    if (!(await tenantHasFeature(this.admin, tenantId, 'whatsapp_business'))) return;

    const resolved = await this.resolveAi(settings);
    if (!resolved.ok) {
      await this.notifyNoAi(
        tenantId,
        conversationId,
        resolved.reason,
        settings.aiLimitNotifiedMonth,
      );
      return;
    }

    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, name: true },
    });
    if (!tenant) return;
    const landing = await this.landing.getBySlug(tenant.slug).catch(() => null);
    const faqs = await this.admin.faqEntry.findMany({
      where: { tenantId, isPublished: true },
      select: { question: true, answer: true },
      orderBy: { position: 'asc' },
      take: 30,
    });
    const history = await this.admin.whatsappMessage.findMany({
      where: { conversationId, status: { not: 'failed' } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_MESSAGES,
      select: { direction: true, body: true, sender: true },
    });
    const turns = this.toTurns(history.reverse());
    if (turns.length === 0) return;
    const firstReply = !history.some((m) => m.sender === 'assistant');

    const system = this.buildSystemPrompt({
      tenantName: tenant.name,
      landing,
      faqs,
      instructions: settings.assistantInstructions,
      bookingUrl: this.bookingUrl(tenant.slug, landing?.customDomain ?? null),
      firstReply,
    });
    const completion = await this.ai.complete(resolved.config, system, turns);
    const handoff = completion.text.includes(HANDOFF_MARKER);
    const text = completion.text.split(HANDOFF_MARKER).join('').trim();

    void this.admin.aiUsageEvent
      .create({
        data: {
          tenantId,
          feature: resolved.source === 'platform' ? 'whatsapp' : 'whatsapp_own',
          model: resolved.config.model,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
        },
      })
      .catch(() => undefined);

    if (text) await this.send(settings, conversation, text, resolved.source);
    if (handoff) await this.handOff(tenantId, conversationId, conversation.contactName ?? null);
  }

  private async send(
    settings: { tenantId: string; phoneNumberId: string; accessTokenEncrypted: string },
    conversation: { id: string; waId: string },
    body: string,
    source: 'platform' | 'own',
  ): Promise<void> {
    const accessToken = this.decrypt(settings.accessTokenEncrypted, settings.tenantId);
    if (!accessToken) return;
    let waMessageId: string | null = null;
    let error: string | null = null;
    try {
      waMessageId = (
        await this.cloud.sendText({
          phoneNumberId: settings.phoneNumberId,
          accessToken,
          to: conversation.waId,
          body,
        })
      ).messageId;
    } catch (err) {
      error = err instanceof Error ? err.message : 'No se pudo enviar';
    }
    const now = new Date();
    await this.admin.whatsappMessage.create({
      data: {
        tenantId: settings.tenantId,
        conversationId: conversation.id,
        direction: 'out',
        sender: 'assistant',
        body,
        waMessageId,
        status: error ? 'failed' : 'sent',
        error,
        aiKeySource: source,
        createdAt: now,
      },
    });
    if (!error) {
      await this.admin.whatsappConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: now, lastMessagePreview: body.slice(0, PREVIEW_LENGTH) },
      });
    }
  }

  /** El asistente se calla en esta conversación y avisa al equipo. */
  private async handOff(tenantId: string, conversationId: string, name: string | null) {
    await this.admin.whatsappConversation.update({
      where: { id: conversationId },
      data: { assistantEnabled: false },
    });
    await this.notifications
      .create(tenantId, {
        type: 'whatsapp.handoff',
        title: `WhatsApp: ${name ?? 'un contacto'} necesita a una persona`,
        body: 'El asistente ha pasado la conversación al equipo.',
        link: `/whatsapp?c=${conversationId}`,
      })
      .catch(() => undefined);
  }

  private async notifyNoAi(
    tenantId: string,
    conversationId: string,
    reason: 'limit_reached' | 'no_ai',
    notifiedMonth: string | null,
  ): Promise<void> {
    const { key } = currentMonth();
    if (notifiedMonth === key) return;
    await this.admin.tenantWhatsappSettings.update({
      where: { tenantId },
      data: { aiLimitNotifiedMonth: key },
    });
    await this.notifications
      .create(tenantId, {
        type: 'whatsapp.ai_unavailable',
        title:
          reason === 'limit_reached'
            ? 'El asistente de WhatsApp ha llegado al límite del mes'
            : 'El asistente de WhatsApp no tiene IA configurada',
        body:
          reason === 'limit_reached'
            ? 'Hasta el mes que viene responde tu equipo. Si pones tu propia clave de IA, el asistente seguirá contestando.'
            : 'Configura tu clave de IA en Configuración → WhatsApp para que el asistente responda.',
        link: `/whatsapp?c=${conversationId}`,
      })
      .catch(() => undefined);
  }

  private toTurns(messages: { direction: string; body: string }[]): WhatsappAiTurn[] {
    // Los proveedores exigen alternar y empezar por el usuario: se juntan los
    // mensajes seguidos del mismo lado.
    const turns: WhatsappAiTurn[] = [];
    for (const m of messages) {
      const role = m.direction === 'in' ? 'user' : 'assistant';
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.content += `\n${m.body}`;
      else turns.push({ role, content: m.body });
    }
    while (turns[0]?.role === 'assistant') turns.shift();
    return turns;
  }

  private bookingUrl(slug: string, customDomain: string | null): string {
    if (customDomain) return `https://${customDomain}/reservar`;
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}/book/${slug}`;
  }

  private buildSystemPrompt(args: {
    tenantName: string;
    landing: PublicLandingDto | null;
    faqs: { question: string; answer: string }[];
    instructions: string | null;
    bookingUrl: string;
    firstReply: boolean;
  }): string {
    const today = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date());
    const lines: string[] = [];
    lines.push(
      `Eres el asistente automático de WhatsApp de «${args.tenantName}», una empresa de alquiler de trasteros. Hoy es ${today}.`,
      'Responde SOLO con la información de abajo. Si no está, no la inventes: di que lo consultas con el equipo.',
      'Escribe como en WhatsApp: mensajes breves, cordiales, sin listas largas ni formato Markdown (como mucho *negrita*). Responde en el idioma del cliente.',
      'Los precios son al mes con IVA incluido. No prometas descuentos que no estén abajo.',
      `Para reservar, envía este enlace (en él se elige el trastero, se firma y se paga): ${args.bookingUrl}`,
      'No pidas datos bancarios ni contraseñas. No hables de otros clientes.',
      `Si el cliente pide hablar con una persona, quiere reclamar, tiene un problema con su contrato o sus pagos, o no sabes responder, contesta en una frase que le pasas con el equipo y termina con ${HANDOFF_MARKER}.`,
    );
    if (args.firstReply) {
      lines.push('Es tu primera respuesta: preséntate en una frase como el asistente automático.');
    }
    const l = args.landing;
    if (l) {
      lines.push('', '## Locales');
      for (const f of l.facilities) {
        const hours = Object.entries(f.openingHours ?? {})
          .map(([day, h]) => {
            const v = h as { open?: string; close?: string } | null;
            return `${day}: ${v?.open && v.close ? `${v.open}-${v.close}` : 'cerrado'}`;
          })
          .join(', ');
        lines.push(
          `- ${f.name}${f.address ? `, ${f.address}` : ''}${f.city ? ` (${f.city})` : ''}${
            f.contactPhone ? ` · tel. ${f.contactPhone}` : ''
          }${hours ? ` · horario de atención: ${hours}` : ''}`,
        );
        for (const t of f.unitTypes) {
          const price = (t.priceMonthly * 1.21).toFixed(2).replace('.', ',');
          lines.push(
            `  · ${t.name}${t.areaM2 ? ` (unos ${t.areaM2} m²)` : ''}: ${price} €/mes · ${
              t.available > 0
                ? `${t.available} libres`
                : 'agotado (se puede apuntar a la lista de espera en la web)'
            }`,
          );
        }
      }
      if (l.activePromotion) {
        const p = l.activePromotion;
        const value =
          p.discountType === 'percentage'
            ? `${p.discountValue} % de descuento`
            : p.discountType === 'fixed'
              ? `${p.discountValue} € de descuento`
              : `${p.discountValue} meses gratis`;
        lines.push('', `## Promoción activa\n${p.name}: ${value} con el código ${p.code}.`);
      }
    }
    if (args.faqs.length > 0) {
      lines.push('', '## Preguntas frecuentes');
      for (const q of args.faqs) lines.push(`P: ${q.question}\nR: ${q.answer}`);
    }
    if (args.instructions) {
      lines.push('', '## Indicaciones del negocio', args.instructions);
    }
    return lines.join('\n');
  }

  private decrypt(value: string, aad: string): string | null {
    try {
      return this.crypto.decryptString(value, aad);
    } catch {
      return null;
    }
  }
}
