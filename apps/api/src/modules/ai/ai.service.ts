import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import {
  AI_PROVIDER,
  type AiMessageParam,
  type AiProvider,
  type AiToolResultBlock,
} from './ai-provider';
import { AiToolsService } from './ai-tools.service';

import type {
  AiConversationDetailDto,
  AiConversationDto,
  AiMessageDto,
  ChatInput,
  ChatResultDto,
} from '@storageos/shared';

const SYSTEM_PROMPT = `Eres el asistente de StorageOS, un SaaS de gestión de self-storage (trasteros), integrado en el panel del equipo de un negocio.

Ayudas al staff a: resumir información, redactar comunicaciones (emails, WhatsApp) y responder preguntas sobre el negocio.

Cuando la pregunta requiera datos reales (ocupación, facturas vencidas, métricas, un cliente concreto), USA las herramientas disponibles; no inventes cifras. Si necesitas el id de un cliente, búscalo primero con search_customers.

Responde en español, de forma concisa y profesional. Usa euros (€) y el formato español. Si no tienes datos suficientes, dilo claramente.`;

const SUGGEST_REPLY_SYSTEM_PROMPT = `Eres un agente de atención al cliente de un negocio de self-storage (alquiler de trasteros). Redacta una respuesta breve, cordial y profesional EN ESPAÑOL para el inquilino, basada en la conversación y sus datos.

Reglas:
- No inventes cifras, fechas ni promesas que no estén en los datos aportados.
- Si el inquilino pregunta algo que no puedes saber con los datos, ofrece ayuda y di que lo revisarás.
- Tono humano y resolutivo. Sin florituras.
- Devuelve SOLO el texto del mensaje (sin asunto, sin "Estimado", sin firma).`;

const MAX_TOOL_ITERATIONS = 5;

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: AiToolsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async chat(args: { tenantId: string; userId: string; input: ChatInput }): Promise<ChatResultDto> {
    if (!this.provider.available) {
      throw new ServiceUnavailableException({
        code: 'ai_not_configured',
        message: 'El asistente IA no está configurado en este entorno',
      });
    }
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
    const toolDefs = this.tools.definitions();

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const completion = await this.provider.createMessage({
        system: SYSTEM_PROMPT,
        messages,
        tools: toolDefs,
      });
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
        const output = await this.tools.execute(tenantId, use.name, use.input);
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

    return { conversationId, message: this.messageDto(assistant) };
  }

  /**
   * Redacta (sin enviar) una respuesta sugerida para el staff en el chat con un
   * inquilino, a partir del hilo reciente + los datos del cliente (contratos,
   * deuda). Single-shot (sin herramientas). El staff la revisa y envía.
   */
  async suggestReply(args: {
    tenantId: string;
    customerId: string;
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

    const completion = await this.provider.createMessage({
      system: SUGGEST_REPLY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contextText }],
      tools: [],
    });
    const suggestion = completion.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { suggestion: suggestion || 'No he podido redactar una respuesta. Escríbela a mano.' };
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
    return {
      ...this.conversationDto(conv),
      messages: conv.messages.map((m) => this.messageDto(m)),
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

  private messageDto(m: {
    id: string;
    role: string;
    content: string;
    toolsUsed: unknown;
    createdAt: Date;
  }): AiMessageDto {
    return {
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      toolsUsed: Array.isArray(m.toolsUsed) ? (m.toolsUsed as string[]) : null,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
