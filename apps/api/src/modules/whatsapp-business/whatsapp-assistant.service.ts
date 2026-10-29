import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AdminTenantWhatsappAiDto,
  assistantRespondsNow,
  isWhatsappAiProvider,
  isWhatsappIntent,
  OpeningHoursSchema,
  type WhatsappIntent,
  WHATSAPP_INTENT_LABELS,
  type PlatformWhatsappAiDto,
  type PublicLandingDto,
  type UpdateAdminTenantWhatsappAiInput,
  type UpdatePlatformWhatsappAiInput,
  type UpdateWhatsappAssistantInput,
  PublicBookingSchema,
  type WhatsappAiMode,
  type WhatsappAiTestResultDto,
  type WhatsappAiUsageDto,
  type WhatsappAssistantDto,
  whatsappAssistantNotice,
  whatsappTextLanguage,
  type WhatsappTextLanguage,
} from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { currentMonth } from '../../common/format';
import { tenantHasFeature } from '../../common/tenant-features';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { LandingService } from '../landing/landing.service';
import { bookingCodes, publicBusinessContextLines } from '../landing/public-business-context';
import { BookingService } from '../move-in/booking.service';
import { NotificationsService } from '../notifications/notifications.service';

import {
  BOOKING_MARKER_RE,
  HANDOFF_MARKER,
  INTENT_MARKER_RE,
  LANGUAGE_MARKER_RE,
  type WhatsappAiSystem,
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

export { bookingCodes } from '../landing/public-business-context';

export { currentMonth } from '../../common/format';

/** Máximo de respuestas del asistente por conversación en 24 h (abuso o bucles). */
const DAILY_REPLIES_PER_CONVERSATION = 30;

/** Instrucción para el resumen que acompaña al paso a una persona. */
const HANDOFF_SUMMARY_PROMPT =
  'Resume para el equipo de un negocio de alquiler de trasteros lo que quiere este cliente, en dos frases cortas en español: qué busca (tamaño, local, fecha, precio) y qué tiene pendiente o le preocupa. Sin saludos ni introducciones. Solo el resumen.';

/** El horario del equipo guardado (jsonb), validado. */
function teamHoursOf(v: unknown) {
  const parsed = OpeningHoursSchema.safeParse(v ?? {});
  return parsed.success ? parsed.data : {};
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
    private readonly booking: BookingService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly panelAi: AiService,
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
      assistantBookingsEnabled: row?.assistantBookingsEnabled ?? true,
      reminderTemplateName: row?.reminderTemplateName ?? null,
      reminderTemplateLanguage: row?.reminderTemplateLanguage ?? 'es',
      privacyUrl: row?.privacyUrl ?? null,
      assistantHoursMode:
        row?.assistantHoursMode === 'outside' || row?.assistantHoursMode === 'inside'
          ? row.assistantHoursMode
          : 'always',
      teamHours: teamHoursOf(row?.teamHours),
      alertIntents: (row?.alertIntents ?? ['reclamacion', 'baja']).filter(isWhatsappIntent),
      followupEnabled: row?.followupEnabled ?? false,
      followupTemplateName: row?.followupTemplateName ?? null,
      followupTemplateLanguage: row?.followupTemplateLanguage ?? 'es',
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
      ...(input.assistantBookingsEnabled !== undefined
        ? { assistantBookingsEnabled: input.assistantBookingsEnabled }
        : {}),
      ...(input.reminderTemplateName !== undefined
        ? { reminderTemplateName: input.reminderTemplateName || null }
        : {}),
      ...(input.reminderTemplateLanguage !== undefined
        ? { reminderTemplateLanguage: input.reminderTemplateLanguage }
        : {}),
      ...(input.privacyUrl !== undefined ? { privacyUrl: input.privacyUrl || null } : {}),
      ...(input.assistantHoursMode !== undefined
        ? { assistantHoursMode: input.assistantHoursMode }
        : {}),
      ...(input.teamHours !== undefined ? { teamHours: input.teamHours } : {}),
      ...(input.alertIntents !== undefined ? { alertIntents: input.alertIntents } : {}),
      ...(input.followupEnabled !== undefined ? { followupEnabled: input.followupEnabled } : {}),
      ...(input.followupTemplateName !== undefined
        ? { followupTemplateName: input.followupTemplateName || null }
        : {}),
      ...(input.followupTemplateLanguage !== undefined
        ? { followupTemplateLanguage: input.followupTemplateLanguage }
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (latestIn?.id !== args.messageId) return; // llegó otro después: responde a ese
    if (!(await tenantHasFeature(this.admin, tenantId, 'whatsapp_business'))) return;

    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, name: true, timezone: true },
    });
    if (!tenant) return;
    // Dentro del horario del equipo (o fuera, según el ajuste) responde una persona.
    if (
      !assistantRespondsNow(
        settings.assistantHoursMode,
        teamHoursOf(settings.teamHours),
        tenant.timezone || 'Europe/Madrid',
      )
    ) {
      return;
    }

    // Tope por conversación: si alguien escribe sin parar, pasa a una persona.
    const recentReplies = await this.admin.whatsappMessage.count({
      where: {
        conversationId,
        sender: 'assistant',
        aiKeySource: { not: null },
        createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
    });
    if (recentReplies >= DAILY_REPLIES_PER_CONVERSATION) {
      await this.handOff(tenantId, conversationId, conversation.contactName ?? null);
      return;
    }

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

    const landing = await this.landing.getBySlug(tenant.slug).catch(() => null);
    const faqs = await this.admin.faqEntry.findMany({
      where: { tenantId, isPublished: true },
      select: { question: true, answer: true },
      orderBy: { position: 'asc' },
      take: 30,
    });
    const history = await this.admin.whatsappMessage.findMany({
      where: { conversationId, status: { not: 'failed' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_MESSAGES,
      select: { direction: true, body: true, sender: true },
    });
    const turns = this.toTurns(history.reverse());
    if (turns.length === 0) return;
    const firstReply = !history.some((m) => m.sender === 'assistant');

    // Una reserva viva por conversación; si caducó o se canceló, puede reservar otra.
    const linkedContract = conversation.contractId
      ? await this.admin.contract.findUnique({
          where: { id: conversation.contractId },
          select: { status: true, deletedAt: true },
        })
      : null;
    const bookingAlive =
      !!linkedContract &&
      !linkedContract.deletedAt &&
      ['draft', 'active', 'ending'].includes(linkedContract.status);
    const bookingsEnabled = settings.assistantBookingsEnabled && !bookingAlive;
    const system = this.buildSystemPrompt({
      tenantName: tenant.name,
      landing,
      faqs,
      instructions: settings.assistantInstructions,
      bookingUrl: this.bookingUrl(tenant.slug, landing?.customDomain ?? null),
      firstReply,
      bookingsEnabled,
      contactPhone: `+${conversation.waId}`,
    });
    const completion = await this.ai.complete(resolved.config, system, turns);
    // Mientras el modelo pensaba (segundos) pudo escribir otra vez el cliente o
    // responder el equipo: entonces esta respuesta ya no toca.
    const [stillOn, newest] = await Promise.all([
      this.admin.whatsappConversation.findUnique({
        where: { id: conversationId },
        select: { assistantEnabled: true },
      }),
      this.admin.whatsappMessage.findFirst({
        where: { conversationId, direction: 'in' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      }),
    ]);
    if (!stillOn?.assistantEnabled || newest?.id !== args.messageId) return;
    let handoff = completion.text.includes(HANDOFF_MARKER);
    const intentRaw = INTENT_MARKER_RE.exec(completion.text)?.[1]?.toLowerCase() ?? null;
    const intent: WhatsappIntent | null = isWhatsappIntent(intentRaw) ? intentRaw : null;
    if (intent && intent !== conversation.intent) {
      await this.admin.whatsappConversation.update({
        where: { id: conversationId },
        data: { intent },
      });
      if (settings.alertIntents.includes(intent)) {
        await this.notifications
          .create(tenantId, {
            type: 'whatsapp.intent',
            title: `WhatsApp: ${conversation.contactName ?? 'un contacto'} · ${WHATSAPP_INTENT_LABELS[intent]}`,
            body: `Ha escrito por WhatsApp sobre: ${WHATSAPP_INTENT_LABELS[intent].toLowerCase()}.`,
            link: `/whatsapp?c=${conversationId}`,
          })
          .catch(() => undefined);
      }
    }
    const bookingMatch = BOOKING_MARKER_RE.exec(completion.text);
    const detected = LANGUAGE_MARKER_RE.exec(completion.text)?.[1]?.toLowerCase() ?? null;
    if (detected && detected !== conversation.language) {
      await this.admin.whatsappConversation.update({
        where: { id: conversationId },
        data: { language: detected },
      });
    }
    const lang = whatsappTextLanguage(detected ?? conversation.language);
    let text = completion.text
      .replace(BOOKING_MARKER_RE, '')
      .replace(new RegExp(LANGUAGE_MARKER_RE.source, 'gi'), '')
      .replace(new RegExp(INTENT_MARKER_RE.source, 'gi'), '')
      .split(HANDOFF_MARKER)
      .join('')
      .trim();
    if (bookingMatch && bookingsEnabled && landing) {
      const booked = await this.createBooking({
        tenantId,
        tenantSlug: tenant.slug,
        conversationId,
        contactName: conversation.contactName,
        waId: conversation.waId,
        landing,
        raw: bookingMatch[1] ?? '',
        lang,
      });
      text = [text, booked.message].filter(Boolean).join('\n\n');
      if (!booked.ok) handoff = true;
    }

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

    // Primera respuesta: aviso fijo de que responde una IA (no depende del modelo).
    if (text && firstReply) {
      text = `${text}\n\n${whatsappAssistantNotice(settings.privacyUrl, lang)}`;
    }
    if (text) await this.send(settings, conversation, text, resolved.source);
    if (handoff) {
      await this.handOff(tenantId, conversationId, conversation.contactName ?? null, {
        config: resolved.config,
        turns,
      });
    }
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

  /**
   * Reserva preparada por el asistente: usa la misma reserva online de la web
   * (retiene el trastero 72 h) y devuelve el enlace de firma y pago. Los
   * locales y tamaños llegan como códigos del contexto (L1, L1-T2…).
   */
  private async createBooking(args: {
    tenantId: string;
    tenantSlug: string;
    conversationId: string;
    contactName: string | null;
    waId: string;
    landing: PublicLandingDto;
    raw: string;
    lang: WhatsappTextLanguage;
  }): Promise<{ ok: boolean; message: string }> {
    const en = args.lang === 'en';
    const reasons = {
      missing: en ? 'some details are missing' : 'faltan datos',
      size: en ? "I can't find that size" : 'no encuentro ese tamaño',
      invalid: en ? 'some details are not valid' : 'algún dato no es válido',
      past: en ? 'the move-in date has already passed' : 'la fecha de entrada ya ha pasado',
      soldOut: en ? 'that size has just sold out' : 'ese tamaño acaba de agotarse',
      error: en ? 'something went wrong' : 'ha habido un problema al reservar',
    };
    const fail = (reason: string) => ({
      ok: false,
      message: en
        ? `I couldn't complete the booking (${reason}). I'm passing you to the team to finish it.`
        : `No he podido completar la reserva (${reason}). Te paso con el equipo para terminarla.`,
    });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(args.raw) as Record<string, unknown>;
    } catch {
      return fail(reasons.missing);
    }
    const codes = bookingCodes(args.landing);
    const target = codes.get(String(data.tipo ?? '').toUpperCase());
    if (!target) return fail(reasons.size);
    const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string).trim() : '');
    const parsed = PublicBookingSchema.safeParse({
      facilityId: target.facilityId,
      unitTypeId: target.unitTypeId,
      startDate: str('fecha'),
      customer: {
        firstName: str('nombre'),
        lastName: str('apellidos'),
        email: str('email'),
        phone: str('telefono') || `+${args.waId}`,
        documentNumber: str('documento'),
      },
      utmSource: 'whatsapp',
      utmMedium: 'asistente',
    });
    if (!parsed.success) return fail(reasons.invalid);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
      new Date(),
    );
    if (parsed.data.startDate < today) return fail(reasons.past);

    let result: {
      contractId: string;
      signingToken: string | null;
      signingLinkSentTo: string | null;
    };
    try {
      result = await this.booking.createBooking(args.tenantSlug, parsed.data, {});
    } catch (err) {
      const code = (err as { response?: { code?: string } } | null)?.response?.code ?? 'error';
      this.logger.warn(`whatsapp-assistant: reserva fallida (${code})`);
      return fail(
        code === 'no_availability' || code === 'unit_not_available'
          ? reasons.soldOut
          : reasons.error,
      );
    }
    const created = await this.admin.contract.findUnique({
      where: { id: result.contractId },
      select: { customerId: true },
    });
    await this.admin.whatsappConversation.update({
      where: { id: args.conversationId },
      // La conversación pasa a la ficha del inquilino; el recordatorio vuelve a
      // estar disponible para esta reserva.
      data: {
        contractId: result.contractId,
        bookingReminderSentAt: null,
        ...(created?.customerId ? { customerId: created.customerId } : {}),
      },
    });
    const url = result.signingToken
      ? `${this.publicBase(args.landing.customDomain)}/sign/${result.signingToken}`
      : null;
    await this.notifications
      .create(args.tenantId, {
        type: 'whatsapp.booking',
        title: `Reserva por WhatsApp: ${target.unitTypeName} en ${target.facilityName}`,
        body: `${args.contactName ?? `+${args.waId}`} ha reservado desde WhatsApp; falta que firme y pague.`,
        link: `/contracts/${result.contractId}`,
        contractId: result.contractId,
      })
      .catch(() => undefined);
    return {
      ok: true,
      // Si el email ya era de un inquilino, el enlace solo va a su correo (no
      // se puede dar en el chat: daría acceso a su área de clientes).
      message: url
        ? en
          ? `Done! I've booked you a ${target.unitTypeName} unit at ${target.facilityName}. To confirm it, sign the contract and pay here: ${url}\nWe'll hold it for 72 hours.`
          : `¡Listo! Te he reservado un trastero ${target.unitTypeName} en ${target.facilityName}. Para confirmarlo, firma el contrato y paga aquí: ${url}\nTe lo guardamos 72 horas.`
        : en
          ? `Done! I've booked you a ${target.unitTypeName} unit at ${target.facilityName}. We've sent the link to sign and pay to your email${result.signingLinkSentTo ? ` (${result.signingLinkSentTo})` : ''}. We'll hold it for 72 hours.`
          : `¡Listo! Te he reservado un trastero ${target.unitTypeName} en ${target.facilityName}. Te hemos enviado el enlace para firmar y pagar a tu email${result.signingLinkSentTo ? ` (${result.signingLinkSentTo})` : ''}. Te lo guardamos 72 horas.`,
    };
  }

  /**
   * Borrador de respuesta para el equipo con la información pública del negocio
   * (gasta una consulta del asistente del panel: lo pide una persona).
   */
  async suggestReply(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<{ suggestion: string }> {
    const conversation = await this.admin.whatsappConversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true, tenant: { select: { slug: true } } },
    });
    if (!conversation) {
      throw new NotFoundException({ code: 'conversation_not_found', message: 'No encontrada' });
    }
    const [rows, faqs, landing] = await Promise.all([
      this.admin.whatsappMessage.findMany({
        where: { conversationId, status: { not: 'failed' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: HISTORY_MESSAGES,
        select: { direction: true, body: true },
      }),
      this.admin.faqEntry.findMany({
        where: { tenantId, isPublished: true },
        select: { question: true, answer: true },
        orderBy: { position: 'asc' },
        take: 30,
      }),
      this.landing.getBySlug(conversation.tenant.slug).catch(() => null),
    ]);
    return this.panelAi.suggestConversationReply({
      tenantId,
      userId,
      channel: 'whatsapp',
      businessContext: publicBusinessContextLines({ landing, faqs }).join('\n'),
      thread: rows.reverse().map((m) => ({
        from: m.direction === 'in' ? 'contact' : 'us',
        text: m.body,
      })),
    });
  }

  /** El asistente se calla en esta conversación y avisa al equipo. */
  private async handOff(
    tenantId: string,
    conversationId: string,
    name: string | null,
    summarize?: { config: WhatsappAiConfig; turns: WhatsappAiTurn[] },
  ) {
    // Resumen en dos frases para que el equipo no tenga que leerlo todo.
    let summary: string | null = null;
    if (summarize) {
      const transcript = summarize.turns
        .map((t) => `${t.role === 'user' ? 'Cliente' : 'Asistente'}: ${t.content}`)
        .join('\n')
        .slice(-6000);
      try {
        const res = await this.ai.complete(summarize.config, HANDOFF_SUMMARY_PROMPT, [
          { role: 'user', content: `RESUMEN:\n${transcript}` },
        ]);
        summary =
          res.text
            .replace(/\[\[[^\]]*\]\]/g, '')
            .trim()
            .slice(0, 600) || null;
      } catch {
        summary = null;
      }
    }
    await this.admin.whatsappConversation.update({
      where: { id: conversationId },
      data: { assistantEnabled: false, ...(summary ? { handoffSummary: summary } : {}) },
    });
    await this.notifications
      .create(tenantId, {
        type: 'whatsapp.handoff',
        title: `WhatsApp: ${name ?? 'un contacto'} necesita a una persona`,
        body: summary ?? 'El asistente ha pasado la conversación al equipo.',
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
    return `${this.publicBase(null)}/book/${slug}`;
  }

  /** Dominio propio del tenant (si está verificado) o la web de la plataforma. */
  private publicBase(customDomain: string | null): string {
    if (customDomain) return `https://${customDomain}`;
    return this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  private buildSystemPrompt(args: {
    tenantName: string;
    landing: PublicLandingDto | null;
    faqs: { question: string; answer: string }[];
    instructions: string | null;
    bookingUrl: string;
    firstReply: boolean;
    bookingsEnabled: boolean;
    contactPhone: string;
  }): WhatsappAiSystem {
    const today = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date());
    const lines: string[] = [];
    lines.push(
      `Eres el asistente automático de WhatsApp de «${args.tenantName}», una empresa de alquiler de trasteros.`,
      'Empieza SIEMPRE tu respuesta con [[IDIOMA xx]], donde xx es el código ISO de 2 letras del idioma en que escribe el cliente (es, en, fr, de…). El sistema lo quita antes de enviarla.',
      `Después añade [[INTENCION x]] con lo que busca el cliente en su último mensaje: ${Object.keys(WHATSAPP_INTENT_LABELS).join(', ')}. También lo quita el sistema.`,
      'Responde SOLO con la información de abajo. Si no está, no la inventes: di que lo consultas con el equipo.',
      'Escribe como en WhatsApp: mensajes breves, cordiales, sin listas largas ni formato Markdown (como mucho *negrita*). Responde en el idioma del cliente.',
      'Los precios son al mes con IVA incluido. No prometas descuentos que no estén abajo.',
      `Para reservar, envía este enlace (en él se elige el trastero, se firma y se paga): ${args.bookingUrl}`,
      'No pidas datos bancarios ni contraseñas. No hables de otros clientes.',
      'Los mensajes «[Foto]», «[Audio]», «[Nota de voz]», «[Vídeo]», «[Documento: …]» o «[Sticker]» son archivos que no puedes ver ni escuchar: pide amablemente que lo escriban o, si hace falta verlo, pasa la conversación al equipo.',
      `Si el cliente pide hablar con una persona, quiere reclamar, tiene un problema con su contrato o sus pagos, o no sabes responder, contesta en una frase que le pasas con el equipo y termina con ${HANDOFF_MARKER}.`,
    );
    const dynamic = [`Hoy es ${today}.`];
    if (args.firstReply) {
      dynamic.push(
        'Es tu primera respuesta: saluda en una frase (el aviso de que eres un asistente automático se añade solo).',
      );
    }
    const l = args.landing;
    // Locales, tamaños y promoción (las preguntas frecuentes van después de la reserva).
    lines.push(...publicBusinessContextLines({ landing: l, faqs: [], codes: true }));
    if (args.bookingsEnabled && l && l.facilities.length > 0) {
      lines.push(
        '',
        '## Reservar desde el chat',
        'Si el cliente quiere reservar, puedes prepararle la reserva aquí mismo (si prefiere hacerlo solo, dale el enlace de reserva).',
        `Pide el local y el tamaño (solo los que tienen trasteros libres), la fecha de entrada, nombre, apellidos, email y DNI/NIE. El teléfono es el de este WhatsApp (${args.contactPhone}).`,
        'Antes de reservar, resume los datos y pregunta si está todo bien. SOLO cuando el cliente confirme, escribe una frase corta y añade al final, en una sola línea:',
        '[[RESERVA {"tipo":"L1-T2","fecha":"AAAA-MM-DD","nombre":"…","apellidos":"…","email":"…","documento":"…"}]]',
        'usando el código entre corchetes del tamaño elegido. No escribas el enlace de firma: lo añade el sistema.',
      );
    }
    lines.push(...publicBusinessContextLines({ landing: null, faqs: args.faqs }));
    if (args.instructions) {
      lines.push('', '## Indicaciones del negocio', args.instructions);
    }
    return { stable: lines.join('\n'), dynamic: dynamic.join('\n') };
  }

  private decrypt(value: string, aad: string): string | null {
    try {
      return this.crypto.decryptString(value, aad);
    } catch {
      return null;
    }
  }
}
