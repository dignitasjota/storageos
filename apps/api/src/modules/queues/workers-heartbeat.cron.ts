import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';

import { QUEUE_BILLING } from './queue-names';

export const WORKERS_HEARTBEAT_KEY = 'workers:heartbeat';
/** TTL 3 minutos: si faltan 3 ticks seguidos del cron, el worker esta caido. */
export const WORKERS_HEARTBEAT_TTL_SECONDS = 180;

/**
 * Latido del proceso que ejecuta los workers (crons + processors BullMQ).
 *
 * `restart: unless-stopped` solo cubre crashes; si el event loop del worker
 * se cuelga (Puppeteer, deadlock), los crons dejan de correr EN SILENCIO:
 * no hay facturacion recurrente, ni dunning, ni auto-charge, y nada lo
 * detecta. Este cron escribe `workers:heartbeat` en Redis cada minuto con
 * TTL 3 min; `GET /health/worker` (API) lo lee y devuelve 503 si falta,
 * para que Uptime Kuma alerte.
 *
 * Se registra con el spread `WORKERS_ENABLED_IN_API`, igual que el resto
 * de crons: en produccion lo escribe el proceso `apps/worker`; en dev/test
 * lo escribe el propio API (que es quien ejecuta los workers).
 */
@Injectable()
export class WorkersHeartbeatCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkersHeartbeatCron.name);

  // Cualquier cola sirve: solo queremos su conexion Redis.
  constructor(@InjectQueue(QUEUE_BILLING) private readonly queue: Queue) {}

  /** Primer latido al arrancar: el monitor ve el proceso vivo sin esperar al cron. */
  async onApplicationBootstrap(): Promise<void> {
    await this.beat();
  }

  @Cron('* * * * *', { name: 'workers.heartbeat' })
  async beat(): Promise<void> {
    try {
      const client = await this.queue.client;
      await client.set(
        WORKERS_HEARTBEAT_KEY,
        new Date().toISOString(),
        'EX',
        WORKERS_HEARTBEAT_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.error(`heartbeat fallo: ${(err as Error).message}`);
    }
  }
}
