import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { QUEUE_WEBHOOKS } from '../queues/queues.module';

/** Peticiones por minuto que admite cada clave de API. */
export const API_KEY_REQUESTS_PER_MINUTE = 120;

export interface ApiKeyRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Segundos hasta que se abre la siguiente ventana. */
  resetSeconds: number;
}

/**
 * Límite de peticiones por clave de API (ventana fija de un minuto en Redis).
 * Va por clave, no por IP: dos integraciones detrás de la misma IP no se
 * frenan entre sí, y una clave no puede saturar el servicio cambiando de IP.
 * Si Redis falla, deja pasar (fail-open): mejor no cortar integraciones.
 */
@Injectable()
export class ApiKeyRateLimitService {
  private readonly logger = new Logger(ApiKeyRateLimitService.name);

  constructor(@InjectQueue(QUEUE_WEBHOOKS) private readonly queue: Queue) {}

  async hit(apiKeyId: string, now = Date.now()): Promise<ApiKeyRateLimitResult> {
    const limit = API_KEY_REQUESTS_PER_MINUTE;
    const minute = Math.floor(now / 60_000);
    const resetSeconds = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
    try {
      const client = await this.queue.client;
      const key = `apikey:rl:${apiKeyId}:${minute}`;
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, 70);
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetSeconds,
      };
    } catch (err) {
      this.logger.warn(`límite de la clave de API sin Redis (se deja pasar): ${String(err)}`);
      return { allowed: true, limit, remaining: limit, resetSeconds };
    }
  }
}
