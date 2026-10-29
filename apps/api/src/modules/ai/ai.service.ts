import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  effectiveFeaturesFromList,
  rentTax,
  resolvePlanFeatures,
  WEB_CHAT_AI_FEATURE,
} from '@storageos/shared';

import { liveOverrideWhere } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { AiActionsService } from './ai-actions.service';
import {
  AI_PROVIDER,
  type AiCompletion,
  type AiMessageParam,
  type AiProvider,
  type AiToolResultBlock,
} from './ai-provider';
import { type AiReservation, AiQuotaService } from './ai-quota.service';
import { type AiToolContext, AiToolsService } from './ai-tools.service';
import { PlatformAiSettingsService } from './platform-ai-settings.service';
import {
  applySuggestedActionsRanking,
  buildSuggestedActionsPrompt,
  SUGGESTED_ACTIONS_SYSTEM_PROMPT,
} from './suggested-actions-ranking';

import type {
  AdCampaignDraftDto,
  AiConversationDetailDto,
  AiConversationDto,
  AiMessageDto,
  AiPendingActionDto,
  AiUsageDto,
  ChatInput,
  ChatResultDto,
  Permission,
  PortalAiChatInput,
  PortalAiChatResultDto,
  SuggestAdCampaignInput,
  SuggestedActionDto,
  TenantAiSettingsDto,
  TenantAiTestDto,
  TenantFeature,
  UpdateTenantAiSettingsInput,
} from '@storageos/shared';

const SYSTEM_PROMPT = `Eres el asistente de TrasterOS, un SaaS de gestión de self-storage (trasteros), integrado en el panel del equipo de un negocio.

Ayudas al staff a: resumir información, redactar comunicaciones (emails, WhatsApp) y responder preguntas sobre el negocio.

Tienes acceso a TODOS los datos del negocio que el usuario puede ver, a través de las herramientas. Cuando la pregunta requiera datos reales, USA las herramientas; no inventes cifras ni digas que no tienes acceso sin haberlo intentado:
- search_records para encontrar un inquilino, contrato, trastero, factura o contacto por nombre, número o código; después get_record para su ficha completa.
- list_records para listados con filtros (facturas, cobros, contratos, trasteros, reservas, lista de espera, accesos al local, contactos, tareas, incidencias, gastos, comunicaciones, campañas, vencimientos, cupones, promociones, valoraciones, cambios de trastero, planes de pago).
- get_collections_month, list_debtors, get_calendar, get_business_settings y get_contracts_trend para cobros, deudores, agenda, configuración y evolución; las demás para métricas, ocupación, ingresos, contactos y gastos.
Encadena varias herramientas si hace falta. Si una herramienta dice que el usuario no tiene permiso, díselo tal cual (no es un fallo tuyo).

Para ACCIONES (crear una tarea, enviar un recordatorio de pago, escribir a un inquilino) usa las herramientas propose_*: solo dejan la acción preparada y el usuario la confirma en pantalla. Nunca digas que ya está hecha; di que la has dejado lista para que la confirme.

Responde en español, de forma concisa y profesional. Usa euros (€) y el formato español. Si no tienes datos suficientes, dilo claramente.`;

const SUGGEST_REPLY_SYSTEM_PROMPT = `Eres un agente de atención al cliente de un negocio de self-storage (alquiler de trasteros). Redacta una respuesta breve, cordial y profesional EN ESPAÑOL para el inquilino, basada en la conversación y sus datos.

Reglas:
- No inventes cifras, fechas ni promesas que no estén en los datos aportados.
- Si el inquilino pregunta algo que no puedes saber con los datos, ofrece ayuda y di que lo revisarás.
- Tono humano y resolutivo. Sin florituras.
- Devuelve SOLO el texto del mensaje (sin asunto, sin "Estimado", sin firma).`;

const AD_CAMPAIGN_SYSTEM_PROMPTS: Record<'google_ads' | 'meta_ads', string> = {
  google_ads: `Eres un experto en Google Ads (Búsqueda) para negocios de self-storage (alquiler de trasteros) en España. A partir de los datos reales del negocio que se te dan, redacta un borrador de campaña EN ESPAÑOL con este formato EXACTO (texto plano, sin markdown):

TITULARES (máx. 30 caracteres cada uno, 8-10 titulares):
1. ...

DESCRIPCIONES (máx. 90 caracteres cada una, 3-4 descripciones):
1. ...

PALABRAS CLAVE SUGERIDAS:
- ...

PÚBLICO / SEGMENTACIÓN:
...

PRESUPUESTO DIARIO ORIENTATIVO:
...

Reglas: no inventes precios ni datos que no se te den; usa los reales aportados. No incluyas nada fuera de este formato ni expliques lo que vas a hacer.`,
  meta_ads: `Eres un experto en Meta Ads (Facebook/Instagram) para negocios de self-storage (alquiler de trasteros) en España. A partir de los datos reales del negocio que se te dan, redacta un borrador de campaña EN ESPAÑOL con este formato EXACTO (texto plano, sin markdown):

TITULARES (máx. 40 caracteres cada uno, 5 titulares):
1. ...

TEXTOS PRINCIPALES (máx. 125 caracteres cada uno, 3 variantes):
1. ...

DESCRIPCIÓN DEL ENLACE (máx. 30 caracteres):
...

PÚBLICO / SEGMENTACIÓN (edad, intereses, radio geográfico):
...

PRESUPUESTO DIARIO ORIENTATIVO:
...

Reglas: no inventes precios ni datos que no se te den; usa los reales aportados. No incluyas nada fuera de este formato ni expliques lo que vas a hacer.`,
};

const PORTAL_ASSISTANT_SYSTEM_PROMPT = `Eres el asistente virtual del portal de un inquilino de un negocio de self-storage (alquiler de trasteros). Ayudas al inquilino a resolver dudas sobre SU cuenta.

Reglas ESTRICTAS:
- Responde SOLO con la información de las «Preguntas frecuentes» y los «Datos del inquilino» que se te dan. NUNCA inventes precios, fechas, importes ni políticas.
- NUNCA reveles datos de otros clientes ni información interna del negocio.
- Si la duda no se puede resolver con lo dado (p. ej. requiere una gestión o una decisión), dile amablemente que escriba a su gestor desde la pestaña «Mensajes» del portal.
- Español, tono cercano y breve. Devuelve SOLO el texto de la respuesta.`;

const MAX_TOOL_ITERATIONS = 8;

/** Tope de la respuesta del chat de la web (respuestas cortas, menos coste). */
const WEB_CHAT_MAX_TOKENS = 450;

/** Áreas del negocio y el permiso para verlas (para decirle al modelo lo que el usuario no puede ver). */
const AREA_PERMISSIONS: [string, Permission][] = [
  ['inquilinos', 'customers:read'],
  ['contratos', 'contracts:read'],
  ['facturas', 'invoices:read'],
  ['cobros', 'payments:read'],
  ['trasteros', 'units:read'],
  ['locales', 'facilities:read'],
  ['reservas', 'reservations:read'],
  ['accesos al local', 'access:read'],
  ['contactos', 'leads:read'],
  ['tareas', 'tasks:read'],
  ['incidencias', 'incidents:read'],
  ['gastos', 'expenses:read'],
  ['comunicaciones', 'communications:read'],
  ['vencimientos', 'reminders:read'],
  ['cupones y promociones', 'promotions:read'],
  ['valoraciones', 'reviews:read'],
  ['analítica', 'analytics:read'],
];

interface ChatArgs {
  tenantId: string;
  userId: string;
  /** Permisos y locales del usuario: acotan las herramientas y sus datos. */
  permissions: readonly Permission[];
  facilityScope: string[] | null;
  input: ChatInput;
}

export interface ChatStreamHooks {
  onText: (delta: string) => void;
  onTool: (toolName: string) => void;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  /** Proveedor de la consulta en curso (clave de la plataforma o del tenant). */
  private readonly keyContext = new AsyncLocalStorage<{ provider: AiProvider; ownKey: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: AiToolsService,
    private readonly actions: AiActionsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly admin: PrismaAdminService,
    private readonly quota: AiQuotaService,
    private readonly audit: AuditService,
    private readonly platformSettings: PlatformAiSettingsService,
  ) {}

  usage(tenantId: string, userId: string): Promise<AiUsageDto> {
    return this.quota.usage(tenantId, userId);
  }

  tenantSettings(tenantId: string): Promise<TenantAiSettingsDto> {
    return this.quota.tenantSettings(tenantId);
  }

  async updateTenantSettings(
    tenantId: string,
    userId: string,
    input: UpdateTenantAiSettingsInput,
  ): Promise<TenantAiSettingsDto> {
    const result = await this.quota.updateTenantSettings(tenantId, input);
    await this.audit.write({
      tenantId,
      userId,
      action: 'tenant.ai_key_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      // Nunca la clave: solo qué cambió.
      changes: {
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey ? 'set' : 'removed' } : {}),
        ...(input.model !== undefined ? { model: input.model || null } : {}),
      },
    });
    return result;
  }

  /** Una llamada mínima con la clave propia del tenant. */
  async testOwnKey(tenantId: string): Promise<TenantAiTestDto> {
    const own = await this.quota.ownKey(tenantId);
    if (!own) {
      return { ok: false, model: '', message: 'No hay ninguna clave guardada.' };
    }
    if (process.env.NODE_ENV === 'test') {
      const ok = !own.apiKey.startsWith('invalid');
      return {
        ok,
        model: own.model,
        message: ok ? 'Conexión correcta (simulada).' : 'La clave no es válida (simulado).',
      };
    }
    try {
      await this.provider.forKey(own.apiKey, own.model).createMessage({
        system: 'Responde solo «ok».',
        messages: [{ role: 'user', content: 'ok' }],
        tools: [],
      });
      return { ok: true, model: own.model, message: 'Conexión correcta.' };
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      const message = code.endsWith('401')
        ? 'La clave no es válida.'
        : code.endsWith('404')
          ? `El modelo «${own.model}» no existe o la clave no tiene acceso a él.`
          : `No se pudo conectar (${code}).`;
      return { ok: false, model: own.model, message };
    }
  }

  /** Reserva la consulta del chat (antes de abrir el stream): 429 si no quedan. */
  reserveChat(tenantId: string, userId: string): Promise<AiReservation> {
    return this.quota.reserve({
      tenantId,
      userId,
      feature: 'chat',
      model: this.provider.modelName,
    });
  }

  /** Devuelve una consulta reservada si la respuesta no llegó a generarse. */
  releaseQuota(reservation: AiReservation): Promise<void> {
    return this.quota.release(reservation.id);
  }

  /**
   * El proveedor de la consulta en curso: el de la plataforma o, si la reserva
   * va con la clave del tenant, uno con ella. Todas las llamadas de una misma
   * pregunta (también las de las herramientas) usan la misma.
   */
  private get llm(): AiProvider {
    return this.keyContext.getStore()?.provider ?? this.provider;
  }

  /** Ejecuta `fn` con el proveedor que corresponde a la reserva. */
  private withReservation<T>(reservation: AiReservation, fn: () => Promise<T>): Promise<T> {
    const own = reservation.ownKey;
    const provider = own ? this.provider.forKey(own.apiKey, own.model) : this.provider;
    return this.keyContext.run({ provider, ownKey: !!own }, fn);
  }

  /** Reserva una consulta, llama al modelo y la devuelve si la llamada falla. */
  private async withQuota<T>(
    reserve: {
      tenantId: string;
      feature: string;
      userId?: string | null;
      customerId?: string | null;
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    const reservation = await this.quota.reserve({ ...reserve, model: this.provider.modelName });
    try {
      return await this.withReservation(reservation, fn);
    } catch (err) {
      await this.quota.release(reservation.id);
      throw err;
    }
  }

  /**
   * Guarda los tokens de una llamada al modelo (para el panel del super admin).
   * Best-effort y sin esperar: un fallo nunca afecta a la respuesta.
   */
  private recordUsage(
    tenantId: string,
    userId: string | null,
    feature: string,
    completion: AiCompletion,
  ): void {
    if (!completion.usage) return;
    void this.admin.aiUsageEvent
      .create({
        data: {
          tenantId,
          userId,
          feature,
          model: this.llm.modelName,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          // La consulta ya cuenta por su reserva; esto son solo los tokens.
          countsAsQuery: false,
          ownKey: this.keyContext.getStore()?.ownKey ?? false,
        },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[ai-usage] no se pudo registrar: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Llamada suelta al modelo, sin herramientas ni conversación: devuelve el
   * texto de la respuesta. Para redactar borradores (páginas de zona…).
   */
  async completeText(args: {
    tenantId: string;
    userId: string | null;
    feature: string;
    system: string;
    user: string;
  }): Promise<string> {
    this.assertAvailable();
    const completion = await this.withQuota(
      { tenantId: args.tenantId, userId: args.userId, feature: args.feature },
      () =>
        this.llm.createMessage({
          system: args.system,
          messages: [{ role: 'user', content: args.user }],
          tools: [],
        }),
    );
    this.recordUsage(args.tenantId, args.userId, args.feature, completion);
    return completion.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  /**
   * Respuesta del chat de la web pública (visitante anónimo): modelo barato,
   * respuesta corta, sin herramientas y con la cuota de la web (aparte de la
   * del panel). `limited` si el negocio gastó las del mes y no tiene clave
   * propia, o si la plataforma no tiene IA configurada.
   */
  async webChatComplete(args: {
    tenantId: string;
    system: string;
    messages: AiMessageParam[];
  }): Promise<{ text: string } | { limited: true }> {
    const web = this.platformSettings.web;
    const reserved = await this.quota.reserveWeb(args.tenantId, web.model);
    if (reserved.kind === 'limit') return { limited: true };
    const own = reserved.reservation.ownKey;
    // Sin clave de la plataforma (modo demo) no se responde a visitantes reales.
    if (!own && !this.platformSettings.resolved().apiKey && process.env.NODE_ENV !== 'test') {
      await this.quota.release(reserved.reservation.id);
      return { limited: true };
    }
    const provider = own
      ? this.provider.forKey(own.apiKey, own.model, WEB_CHAT_MAX_TOKENS)
      : this.provider.forModel(web.model, WEB_CHAT_MAX_TOKENS);
    let completion: AiCompletion;
    try {
      completion = await provider.createMessage({
        system: args.system,
        messages: args.messages,
        tools: [],
      });
    } catch (err) {
      await this.quota.release(reserved.reservation.id);
      throw err;
    }
    if (completion.usage) {
      void this.admin.aiUsageEvent
        .create({
          data: {
            tenantId: args.tenantId,
            feature: WEB_CHAT_AI_FEATURE,
            model: provider.modelName,
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
            countsAsQuery: false,
            ownKey: !!own,
          },
        })
        .catch(() => undefined);
    }
    const text = completion.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { text };
  }

  /** 503 si el provider no está configurado (antes de abrir un stream). */
  assertAvailable(): void {
    if (!this.provider.available) {
      throw new ServiceUnavailableException({
        code: 'ai_not_configured',
        message: 'El asistente IA no está configurado en este entorno',
      });
    }
  }

  async chat(args: ChatArgs): Promise<ChatResultDto> {
    this.assertAvailable();
    return this.withQuota({ tenantId: args.tenantId, userId: args.userId, feature: 'chat' }, () =>
      this.runChat(args),
    );
  }

  /**
   * Igual que `chat`, pero entrega el texto según se genera (`onText`) y avisa
   * de cada herramienta que se consulta (`onTool`). Si una iteración acaba
   * pidiendo herramientas, el texto que el modelo escribiera antes no forma
   * parte de la respuesta final (igual que en `chat`): el cliente lo descarta
   * al recibir `onTool`.
   */
  async chatStream(
    args: ChatArgs,
    hooks: ChatStreamHooks,
    reservation: AiReservation,
  ): Promise<ChatResultDto> {
    this.assertAvailable();
    return this.withReservation(reservation, () => this.runChat(args, hooks));
  }

  private async runChat(args: ChatArgs, hooks?: ChatStreamHooks): Promise<ChatResultDto> {
    const { tenantId, userId, input } = args;

    const conversationId = input.conversationId
      ? await this.assertOwnedConversation(tenantId, userId, input.conversationId)
      : await this.createConversation(tenantId, userId, input.content);

    // Persistimos el mensaje del usuario y cargamos el histórico (solo texto).
    await this.prisma.withTenant(
      (tx) =>
        tx.aiMessage.create({
          data: { tenantId, conversationId, role: 'user', content: input.content },
        }),
      tenantId,
    );
    const history = await this.prisma.withTenant(
      (tx) =>
        tx.aiMessage.findMany({
          where: { tenantId, conversationId },
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true },
        }),
      tenantId,
    );

    const messages: AiMessageParam[] = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const toolsUsed = new Set<string>();
    let finalText = '';
    const toolCtx: AiToolContext = {
      tenantId,
      permissions: args.permissions,
      facilityScope: args.facilityScope,
      userId,
      conversationId,
      proposedActionIds: [],
    };
    const toolDefs = this.tools.definitions(toolCtx);

    const system = `${SYSTEM_PROMPT}\n\n${await this.businessContext(tenantId, args.permissions, args.facilityScope)}`;
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const request = { system, messages, tools: toolDefs };
      const completion = hooks
        ? await this.llm.streamMessage(request, hooks.onText)
        : await this.llm.createMessage(request);
      // Solo la primera vuelta es la consulta; las de herramientas no cuentan.
      this.recordUsage(tenantId, userId, 'chat', completion);
      messages.push({ role: 'assistant', content: completion.content });

      const toolUses = completion.content.filter((b) => b.type === 'tool_use');
      if (completion.stopReason !== 'tool_use' || toolUses.length === 0) {
        finalText = completion.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        break;
      }

      const results: AiToolResultBlock[] = [];
      for (const use of toolUses) {
        toolsUsed.add(use.name);
        hooks?.onTool(use.name);
        const output = await this.tools.execute(toolCtx, use.name, use.input);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: output });
      }
      messages.push({ role: 'user', content: results });
    }

    if (!finalText) {
      finalText = 'No he podido completar la respuesta. Reformula la pregunta, por favor.';
    }

    const assistant = await this.prisma.withTenant(async (tx) => {
      const msg = await tx.aiMessage.create({
        data: {
          tenantId,
          conversationId,
          role: 'assistant',
          content: finalText,
          ...(toolsUsed.size > 0 ? { toolsUsed: [...toolsUsed] } : {}),
        },
      });
      await tx.aiConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      return msg;
    }, tenantId);

    // Las acciones propuestas en esta vuelta cuelgan del mensaje del asistente.
    const actionIds = toolCtx.proposedActionIds ?? [];
    await this.actions.attachToMessage(tenantId, actionIds, assistant.id);
    const actions =
      actionIds.length > 0
        ? ((await this.actions.listByMessage(tenantId, conversationId)).get(assistant.id) ?? [])
        : [];
    return { conversationId, message: this.messageDto(assistant, actions) };
  }

  /**
   * Contexto fijo de cada pregunta: el día y la hora en la zona del negocio,
   * su nombre, sus locales y lo que el usuario no tiene permiso para ver.
   */
  private async businessContext(
    tenantId: string,
    permissions: readonly Permission[],
    facilityScope: string[] | null,
  ): Promise<string> {
    const data = await this.prisma.withTenant(
      async (tx) => ({
        tenant: await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { name: true, timezone: true },
        }),
        facilities: await tx.facility.findMany({
          where: { deletedAt: null, ...(facilityScope ? { id: { in: facilityScope } } : {}) },
          select: { name: true, city: true, isActive: true, _count: { select: { units: true } } },
          orderBy: { name: 'asc' },
          take: 30,
        }),
      }),
      tenantId,
    );
    const tz = data.tenant?.timezone || 'Europe/Madrid';
    const now = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date());
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const lines = [
      `## Contexto`,
      `Negocio: ${data.tenant?.name ?? '—'}. Hoy es ${now} (${today}, zona ${tz}). Usa estas fechas para «hoy», «esta semana» o «este mes».`,
      `Locales${facilityScope ? ' que puede ver este usuario' : ''}: ${
        data.facilities
          .map(
            (f) =>
              `${f.name}${f.city ? ` (${f.city})` : ''}, ${f._count.units} trasteros${f.isActive ? '' : ', inactivo'}`,
          )
          .join('; ') || 'ninguno todavía'
      }.`,
    ];
    const missing = AREA_PERMISSIONS.filter(([, p]) => !permissions.includes(p)).map(([a]) => a);
    if (missing.length > 0) {
      lines.push(
        `Este usuario NO tiene permiso para ver: ${missing.join(', ')}. Si pregunta por eso, dile que su rol no se lo permite y que lo pida al propietario del negocio.`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Redacta (sin enviar) una respuesta sugerida para el staff en el chat con un
   * inquilino, a partir del hilo reciente + los datos del cliente (contratos,
   * deuda). Single-shot (sin herramientas). El staff la revisa y envía.
   */
  async suggestReply(args: {
    tenantId: string;
    customerId: string;
    userId?: string | null;
  }): Promise<{ suggestion: string }> {
    if (!this.provider.available) {
      throw new ServiceUnavailableException({
        code: 'ai_not_configured',
        message: 'El asistente IA no está configurado en este entorno',
      });
    }
    const { tenantId, customerId } = args;

    const ctx = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null },
        select: { customerType: true, firstName: true, lastName: true, companyName: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Cliente no encontrado',
        });
      }
      const [contracts, invoices, messages] = await Promise.all([
        tx.contract.findMany({
          where: { customerId, status: { in: ['active', 'ending'] } },
          select: {
            priceMonthly: true,
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
        }),
        tx.invoice.findMany({
          where: { customerId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
          select: { total: true, amountPaid: true },
        }),
        tx.customerMessage.findMany({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { senderType: true, body: true },
        }),
      ]);
      return { customer, contracts, invoices, thread: messages.reverse() };
    }, tenantId);

    const custName =
      ctx.customer.customerType === 'business'
        ? (ctx.customer.companyName ?? 'Cliente')
        : [ctx.customer.firstName, ctx.customer.lastName].filter(Boolean).join(' ') || 'Cliente';
    const debt = ctx.invoices.reduce(
      (s, i) => s + Math.max(0, Number(i.total) - Number(i.amountPaid)),
      0,
    );
    const contractsText =
      ctx.contracts
        .map(
          (c) =>
            `${c.unit?.code ?? '—'} (${c.unit?.facility?.name ?? '—'}) ${Number(c.priceMonthly)} €/mes`,
        )
        .join('; ') || 'ninguno';
    const threadText =
      ctx.thread
        .map((m) => `${m.senderType === 'customer' ? 'Inquilino' : 'Nosotros'}: ${m.body}`)
        .join('\n') || '(sin mensajes previos)';
    const contextText = `Datos del inquilino:
- Nombre: ${custName}
- Contratos activos: ${contractsText}
- Facturas pendientes: ${ctx.invoices.length}${debt > 0 ? ` (deuda ${Math.round(debt * 100) / 100} €)` : ''}

Conversación reciente (la última línea del inquilino es a lo que respondemos):
${threadText}

Redacta la respuesta al inquilino:`;

    const completion = await this.withQuota(
      { tenantId: args.tenantId, userId: args.userId ?? null, feature: 'suggest_reply' },
      () =>
        this.llm.createMessage({
          system: SUGGEST_REPLY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: contextText }],
          tools: [],
        }),
    );
    this.recordUsage(args.tenantId, args.userId ?? null, 'suggest_reply', completion);
    const suggestion = completion.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { suggestion: suggestion || 'No he podido redactar una respuesta. Escríbela a mano.' };
  }

  /**
   * Redacta (no publica) un borrador de campaña de Google Ads / Meta Ads a
   * partir de los datos reales del negocio (local, tipos de trastero,
   * precios, promoción activa). Ninguna de las dos plataformas se integra
   * para crear campañas por API — el staff copia el texto en su gestor.
   * Single-shot, sin herramientas.
   */
  async suggestAdCampaign(args: {
    tenantId: string;
    input: SuggestAdCampaignInput;
    userId?: string | null;
  }): Promise<AdCampaignDraftDto> {
    if (!this.provider.available) {
      throw new ServiceUnavailableException({
        code: 'ai_not_configured',
        message: 'El asistente IA no está configurado en este entorno',
      });
    }
    const { tenantId, input } = args;
    const ctx = await this.prisma.withTenant(async (tx) => {
      const [tenant, facilities, unitTypes, grouped, promotion] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        tx.facility.findMany({
          where: {
            tenantId,
            deletedAt: null,
            isActive: true,
            ...(input.facilityId ? { id: input.facilityId } : {}),
          },
          select: { id: true, name: true, city: true },
          take: input.facilityId ? 1 : 3,
        }),
        tx.unitType.findMany({
          where: { tenantId, isActive: true },
          select: { id: true, name: true, defaultPriceMonthly: true, propertyKind: true },
        }),
        tx.unit.groupBy({
          by: ['facilityId', 'unitTypeId'],
          where: { tenantId, status: 'available' },
          _count: { _all: true },
        }),
        tx.promotion.findFirst({
          where: {
            isActive: true,
            OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
          },
          select: { code: true, discountType: true, discountValue: true },
        }),
      ]);
      return { tenant, facilities, unitTypes, grouped, promotion };
    }, tenantId);

    if (input.facilityId && ctx.facilities.length === 0) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }

    const unitTypeById = new Map(ctx.unitTypes.map((t) => [t.id, t]));
    const availableByFacility = new Map<string, string[]>();
    for (const g of ctx.grouped) {
      if (g._count._all === 0) continue;
      const type = unitTypeById.get(g.unitTypeId);
      if (!type) continue;
      // Vivienda: exenta de IVA; trastero: 21 %.
      const { taxRate } = rentTax(type.propertyKind);
      const price = Math.round(Number(type.defaultPriceMonthly) * (1 + taxRate / 100));
      const entry = `${type.name} desde ${price} €/mes${taxRate > 0 ? ' (IVA incl.)' : ''}`;
      const list = availableByFacility.get(g.facilityId) ?? [];
      list.push(entry);
      availableByFacility.set(g.facilityId, list);
    }
    const facilitiesText =
      ctx.facilities
        .map((f) => {
          const prices = (availableByFacility.get(f.id) ?? []).join(', ');
          return `- ${f.name}${f.city ? ` (${f.city})` : ''}: ${prices || 'sin trasteros disponibles ahora mismo'}`;
        })
        .join('\n') || '(sin locales activos configurados)';
    const promoText = ctx.promotion
      ? `Promoción activa: código "${ctx.promotion.code}" (${ctx.promotion.discountType === 'percentage' ? `${Number(ctx.promotion.discountValue)}% de descuento` : ctx.promotion.discountType === 'fixed' ? `${Number(ctx.promotion.discountValue)} € de descuento` : `${Number(ctx.promotion.discountValue)} meses gratis`}).`
      : 'Sin promoción activa ahora mismo.';
    const contextText = `Negocio: ${ctx.tenant?.name ?? 'Self-storage'}.

Locales y precios:
${facilitiesText}

${promoText}

Redacta el borrador de campaña:`;

    const completion = await this.withQuota(
      { tenantId: args.tenantId, userId: args.userId ?? null, feature: 'ad_campaign' },
      () =>
        this.llm.createMessage({
          system: AD_CAMPAIGN_SYSTEM_PROMPTS[input.platform],
          messages: [{ role: 'user', content: contextText }],
          tools: [],
        }),
    );
    this.recordUsage(args.tenantId, args.userId ?? null, 'ad_campaign', completion);
    const draft = completion.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return {
      platform: input.platform,
      draft: draft || 'No he podido redactar el borrador. Inténtalo de nuevo.',
    };
  }

  /**
   * «Sugerencias de hoy» con IA: el modelo reordena y redacta las acciones que
   * ya calculó el motor heurístico. Devuelve `null` (→ lista heurística) si el
   * tenant no tiene IA, el modelo tarda más de `timeoutMs` o la respuesta no es
   * válida: nunca rompe el dashboard.
   */
  async rankSuggestedActions(
    tenantId: string,
    actions: SuggestedActionDto[],
    timeoutMs = 8_000,
  ): Promise<SuggestedActionDto[] | null> {
    if (actions.length < 2) return null;
    if (!(await this.isAiEnabled(tenantId))) return null;
    // Lo que la IA hace sola no gasta consultas, pero tampoco sigue si no quedan.
    if (!(await this.quota.hasRoom(tenantId))) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const completion = await Promise.race([
        this.llm.createMessage({
          system: SUGGESTED_ACTIONS_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildSuggestedActionsPrompt(actions) }],
          tools: [],
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (!completion) return null;
      this.recordUsage(tenantId, null, 'suggested_actions', completion);
      const text = completion.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return applySuggestedActionsRanking(actions, text);
    } catch (err) {
      this.logger.warn(
        `[suggested-actions] tenant=${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** ¿El tenant tiene la feature `ai_assistant` (plan + overrides)? */
  async isAiEnabled(tenantId: string): Promise<boolean> {
    if (!this.provider.available) return false;
    return this.prisma.withTenant(async (tx) => {
      const [subscription, overrides] = await Promise.all([
        tx.tenantSubscription.findUnique({
          where: { tenantId },
          include: { plan: { select: { slug: true, tenantFeatures: true } } },
        }),
        tx.tenantFeatureOverride.findMany({
          where: liveOverrideWhere(),
          select: { feature: true, enabled: true },
        }),
      ]);
      const base = subscription ? resolvePlanFeatures(subscription.plan) : [];
      const features = effectiveFeaturesFromList(
        base,
        overrides as { feature: TenantFeature; enabled: boolean }[],
      );
      return features.includes('ai_assistant');
    }, tenantId);
  }

  /**
   * Chatbot de autoservicio del PORTAL del inquilino: responde con la FAQ del
   * negocio + los datos del PROPIO inquilino (contratos, deuda). Single-shot,
   * sin herramientas (no accede a datos de otros clientes). Si no puede, deriva
   * a «Mensajes». No persiste (el hilo lo mantiene el cliente).
   */
  async portalAnswer(args: {
    tenantId: string;
    customerId: string;
    input: PortalAiChatInput;
  }): Promise<PortalAiChatResultDto> {
    if (!this.provider.available) {
      throw new ServiceUnavailableException({
        code: 'ai_not_configured',
        message: 'El asistente no está disponible',
      });
    }
    const { tenantId, customerId, input } = args;
    if (!(await this.isAiEnabled(tenantId))) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'El asistente no está activo',
      });
    }
    const ctx = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null },
        select: { customerType: true, firstName: true, lastName: true, companyName: true },
      });
      if (!customer) {
        throw new NotFoundException({ code: 'customer_not_found', message: 'No encontrado' });
      }
      const [tenant, faqs, contracts, invoices] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        tx.faqEntry.findMany({
          where: { isPublished: true },
          orderBy: { position: 'asc' },
          select: { question: true, answer: true },
          take: 50,
        }),
        tx.contract.findMany({
          where: { customerId, status: { in: ['active', 'ending'] } },
          select: {
            priceMonthly: true,
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
        }),
        tx.invoice.findMany({
          where: { customerId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
          select: { total: true, amountPaid: true, dueDate: true, status: true },
        }),
      ]);
      return { customer, tenant, faqs, contracts, invoices };
    }, tenantId);

    const custName =
      ctx.customer.customerType === 'business'
        ? (ctx.customer.companyName ?? 'Cliente')
        : [ctx.customer.firstName, ctx.customer.lastName].filter(Boolean).join(' ') || 'Cliente';
    const debt = ctx.invoices.reduce(
      (s, i) => s + Math.max(0, Number(i.total) - Number(i.amountPaid)),
      0,
    );
    const faqText =
      ctx.faqs.map((f, i) => `${i + 1}. P: ${f.question}\n   R: ${f.answer}`).join('\n') ||
      '(sin preguntas frecuentes)';
    const contractsText =
      ctx.contracts
        .map(
          (c) =>
            `Trastero ${c.unit?.code ?? '—'} en ${c.unit?.facility?.name ?? '—'}, ${Number(c.priceMonthly)} €/mes`,
        )
        .join('; ') || 'ninguno';
    const system = `${PORTAL_ASSISTANT_SYSTEM_PROMPT}

Negocio: ${ctx.tenant?.name ?? 'el operador'}.

Preguntas frecuentes:
${faqText}

Datos del inquilino (${custName}):
- Trasteros activos: ${contractsText}
- Facturas pendientes: ${ctx.invoices.length}${debt > 0 ? ` (importe pendiente ${Math.round(debt * 100) / 100} €)` : ''}`;

    const history = (input.history ?? []).slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // Cuenta para el tenant y para el tope diario de este inquilino.
    const completion = await this.withQuota({ tenantId, customerId, feature: 'portal' }, () =>
      this.llm.createMessage({
        system,
        messages: [...history, { role: 'user', content: input.message }],
        tools: [],
      }),
    );
    this.recordUsage(args.tenantId, null, 'portal', completion);
    const answer = completion.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return {
      answer:
        answer ||
        'No he podido resolver tu duda. Escríbenos desde la pestaña «Mensajes» y te ayudamos.',
    };
  }

  async listConversations(tenantId: string, userId: string): Promise<AiConversationDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.aiConversation.findMany({
          where: { tenantId, userId },
          orderBy: { updatedAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((c) => this.conversationDto(c));
  }

  async getConversation(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<AiConversationDetailDto> {
    const conv = await this.prisma.withTenant(
      (tx) =>
        tx.aiConversation.findFirst({
          where: { id, tenantId, userId },
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        }),
      tenantId,
    );
    if (!conv) {
      throw new NotFoundException({
        code: 'conversation_not_found',
        message: 'Conversación no encontrada',
      });
    }
    const actions = await this.actions.listByMessage(tenantId, conv.id);
    return {
      ...this.conversationDto(conv),
      messages: conv.messages.map((m) => this.messageDto(m, actions.get(m.id) ?? [])),
    };
  }

  async deleteConversation(tenantId: string, userId: string, id: string): Promise<void> {
    const res = await this.prisma.withTenant(
      (tx) => tx.aiConversation.deleteMany({ where: { id, tenantId, userId } }),
      tenantId,
    );
    if (res.count === 0) {
      throw new NotFoundException({
        code: 'conversation_not_found',
        message: 'Conversación no encontrada',
      });
    }
  }

  // -------------------------------------------------------------------------

  private async createConversation(
    tenantId: string,
    userId: string,
    firstMessage: string,
  ): Promise<string> {
    const title = firstMessage.slice(0, 60).trim() || 'Nueva conversación';
    const conv = await this.prisma.withTenant(
      (tx) => tx.aiConversation.create({ data: { tenantId, userId, title } }),
      tenantId,
    );
    return conv.id;
  }

  private async assertOwnedConversation(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<string> {
    const conv = await this.prisma.withTenant(
      (tx) =>
        tx.aiConversation.findFirst({ where: { id, tenantId, userId }, select: { id: true } }),
      tenantId,
    );
    if (!conv) {
      throw new NotFoundException({
        code: 'conversation_not_found',
        message: 'Conversación no encontrada',
      });
    }
    return conv.id;
  }

  private conversationDto(c: {
    id: string;
    title: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): AiConversationDto {
    return {
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private messageDto(
    m: {
      id: string;
      role: string;
      content: string;
      toolsUsed: unknown;
      createdAt: Date;
    },
    actions: AiPendingActionDto[] = [],
  ): AiMessageDto {
    return {
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      toolsUsed: Array.isArray(m.toolsUsed) ? (m.toolsUsed as string[]) : null,
      ...(actions.length > 0 ? { actions } : {}),
      createdAt: m.createdAt.toISOString(),
    };
  }
}
