import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { QUEUE_BILLING } from '../queues/queues.module';

/** Lo que se cuenta por IP y día (y por negocio y hora). */
export type WebChatAbuseKind = 'message' | 'conversation' | 'handoff' | 'booking' | 'tenant_hour';

/** Conversaciones nuevas por IP y día (cada visitante nuevo abre una). */
export const WEB_CHAT_CONVERSATIONS_PER_IP = 10;
/** Peticiones de hablar con una persona por IP y día. */
export const WEB_CHAT_HANDOFFS_PER_IP = 3;
/** Reservas desde el chat por IP y día (cada una retiene un trastero 72 h). */
export const WEB_CHAT_BOOKINGS_PER_IP = 2;
/** Respuestas de la IA por negocio y hora: freno ante un ataque desde muchas IP. */
export const WEB_CHAT_ANSWERS_PER_TENANT_HOUR = 200;
/** Mensajes por IP y día: el tope por visitante, con margen para una oficina o una familia. */
export const webChatMessagesPerIp = (visitorDailyLimit: number) =>
  Math.max(30, visitorDailyLimit * 3);

/**
 * Límites del chat de la web que no dependen del identificador que pone el
 * navegador (que se puede cambiar en cada mensaje): por IP y día, y por negocio
 * y hora. Viven en Redis (la conexión de BullMQ) y caducan solos.
 *
 * Si Redis no responde, deja pasar (un fallo de infraestructura no debe callar
 * el chat de todos los negocios).
 */
@Injectable()
export class WebChatAbuseService {
  private readonly logger = new Logger(WebChatAbuseService.name);

  constructor(@InjectQueue(QUEUE_BILLING) private readonly queue: Queue) {}

  /**
   * Suma uno al contador y dice si sigue dentro del límite. Sin IP (no
   * debería pasar detrás del proxy) no se cuenta por IP.
   */
  async allow(
    kind: WebChatAbuseKind,
    tenantId: string,
    ip: string | undefined,
    limit: number,
  ): Promise<boolean> {
    const now = new Date();
    let key: string;
    let ttl: number;
    if (kind === 'tenant_hour') {
      key = `wc:abuse:${kind}:${tenantId}:${now.toISOString().slice(0, 13)}`;
      ttl = 2 * 3600;
    } else {
      if (!ip) return true;
      key = `wc:abuse:${kind}:${tenantId}:${hashIp(ip)}:${now.toISOString().slice(0, 10)}`;
      ttl = 26 * 3600;
    }
    try {
      const client = await this.queue.client;
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, ttl);
      return count <= limit;
    } catch (err) {
      this.logger.warn(
        `[web-chat] contador ${kind} sin Redis: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  /** Devuelve una unidad (lo contado no llegó a usarse). */
  async giveBack(kind: WebChatAbuseKind, tenantId: string, ip: string | undefined): Promise<void> {
    if (!ip || kind === 'tenant_hour') return;
    const key = `wc:abuse:${kind}:${tenantId}:${hashIp(ip)}:${new Date().toISOString().slice(0, 10)}`;
    try {
      const client = await this.queue.client;
      await client.decr(key);
    } catch {
      // sin Redis no hay nada que devolver
    }
  }
}

/** La IP no se guarda tal cual (ni siquiera en Redis). */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 24);
}
