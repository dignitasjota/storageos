import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';

import { QUEUE_BILLING } from './queue-names';

/** % de uso de memoria a partir del cual se avisa. */
const WARN_THRESHOLD_PCT = 80;

/**
 * Vigía de la memoria de Redis (auditoría 2026-07).
 *
 * Redis corre con `maxmemory-policy noeviction` — OBLIGATORIO para BullMQ
 * (desalojar claves pierde jobs) — así que cuando se llena no desaloja:
 * RECHAZA las escrituras y las colas fallan en silencio. Este cron consulta
 * `INFO memory` cada 5 minutos y, si el uso supera el umbral, emite un log
 * `redis_memory_high` que Grafana convierte en alerta (regla Loki sobre el
 * texto del log, como las de CSP/errores).
 *
 * Registrado con el spread `WORKERS_ENABLED_IN_API`: en producción corre en
 * `apps/worker`, en dev/test en el propio API.
 */
@Injectable()
export class RedisMemoryCron {
  private readonly logger = new Logger(RedisMemoryCron.name);

  // Cualquier cola sirve: solo queremos su conexión Redis.
  constructor(@InjectQueue(QUEUE_BILLING) private readonly queue: Queue) {}

  @Cron('*/5 * * * *', { name: 'redis.memory-watch' })
  async check(): Promise<void> {
    try {
      const client = await this.queue.client;
      const info = await client.info('memory');
      const used = this.parseField(info, 'used_memory');
      const max = this.parseField(info, 'maxmemory');
      // Sin maxmemory configurado (dev) no hay techo que vigilar.
      if (!max || max <= 0 || !used) return;
      const pct = Math.round((used / max) * 100);
      if (pct >= WARN_THRESHOLD_PCT) {
        // El texto `redis_memory_high` es el ancla de la alerta de Grafana.
        this.logger.warn(
          `redis_memory_high: Redis al ${pct}% de maxmemory (${used}/${max} bytes) — con noeviction, al llenarse las colas BullMQ fallarán`,
        );
      }
    } catch (err) {
      this.logger.error(`redis.memory-watch falló: ${(err as Error).message}`);
    }
  }

  private parseField(info: string, field: string): number | null {
    const match = info.match(new RegExp(`^${field}:(\\d+)`, 'm'));
    return match?.[1] ? Number(match[1]) : null;
  }
}
