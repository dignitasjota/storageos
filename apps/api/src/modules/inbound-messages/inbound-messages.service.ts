import { Injectable, Logger } from '@nestjs/common';

import { CustomerMessagesService } from '../customer-messages/customer-messages.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

type InboundChannel = 'whatsapp' | 'email';

/**
 * Mensajes ENTRANTES del inquilino por WhatsApp o email (respuestas a los
 * envíos salientes del staff). El WABA/email de la plataforma es compartido por
 * todos los tenants, así que resolvemos el tenant+customer por el remitente
 * (teléfono o email) vía `PrismaAdminService` (bypass RLS: el webhook llega sin
 * contexto de tenant). El mensaje se registra en el mismo hilo de chat que el
 * portal (`customer_messages`), marcado con su canal de origen.
 */
@Injectable()
export class InboundMessagesService {
  private readonly logger = new Logger(InboundMessagesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly messages: CustomerMessagesService,
  ) {}

  /** Últimos 9 dígitos (número nacional español) para casar formatos variados. */
  private phoneSuffix(phone: string): string | null {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : null;
  }

  /**
   * Resuelve un remitente ambiguo (mismo teléfono/email en varios tenants —
   * el canal WABA/email es compartido por toda la plataforma, así que esto
   * pasa de verdad) por la comunicación SALIENTE más reciente de ese canal a
   * alguno de los candidatos: una respuesta entrante casi siempre pertenece a
   * la conversación que un tenant inició de verdad. Si ningún candidato tiene
   * ese rastro, NO hay señal fiable para elegir uno — devolver `null` en vez
   * de adivinar (p.ej. el primero que devuelva la BD, orden no garantizado)
   * evita filtrar el mensaje de un inquilino al panel de un tenant ajeno.
   */
  private async disambiguate(
    channel: InboundChannel,
    candidates: { id: string; tenantId: string }[],
  ): Promise<{ tenantId: string; customerId: string } | null> {
    if (candidates.length === 0) return null;
    if (candidates.length === 1)
      return { tenantId: candidates[0]!.tenantId, customerId: candidates[0]!.id };
    const recent = await this.admin.communication.findFirst({
      where: { channel, customerId: { in: candidates.map((c) => c.id) } },
      orderBy: { createdAt: 'desc' },
      select: { customerId: true, tenantId: true },
    });
    if (recent?.customerId) return { tenantId: recent.tenantId, customerId: recent.customerId };
    this.logger.warn(
      `inbound ${channel}: remitente ambiguo entre ${candidates.length} tenants sin conversación previa — descartado`,
    );
    return null;
  }

  private async resolveByPhone(
    from: string,
  ): Promise<{ tenantId: string; customerId: string } | null> {
    const suffix = this.phoneSuffix(from);
    if (!suffix) return null;
    const candidates = await this.admin.customer.findMany({
      where: { phone: { contains: suffix }, deletedAt: null },
      select: { id: true, tenantId: true },
      take: 25,
    });
    return this.disambiguate('whatsapp', candidates);
  }

  private async resolveByEmail(
    from: string,
  ): Promise<{ tenantId: string; customerId: string } | null> {
    const email = from.trim().toLowerCase();
    const candidates = await this.admin.customer.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, tenantId: true },
      take: 25,
    });
    return this.disambiguate('email', candidates);
  }

  /**
   * Registra un mensaje entrante. Best-effort: si no se resuelve el remitente o
   * el cuerpo está vacío, se descarta con un log (no rompe el webhook, que debe
   * responder 200 para que el proveedor no reintente en bucle).
   */
  async record(args: { channel: InboundChannel; from: string; body: string }): Promise<boolean> {
    const body = args.body.trim();
    if (!body) return false;
    const resolved =
      args.channel === 'whatsapp'
        ? await this.resolveByPhone(args.from)
        : await this.resolveByEmail(args.from);
    if (!resolved) {
      this.logger.warn(`inbound ${args.channel}: remitente no resoluble (${args.from})`);
      return false;
    }
    await this.messages.sendFromCustomer(
      resolved.tenantId,
      resolved.customerId,
      body.slice(0, 5000),
      args.channel,
    );
    return true;
  }
}
