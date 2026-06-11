import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { Queue } from 'bullmq';

import { Public } from '../../common/decorators/public.decorator';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { QUEUE_BILLING } from '../queues/queues.module';

/**
 * Endpoints de health. Se montan como `VERSION_NEUTRAL` para que tanto
 * `/health` como `/v1/health` respondan sin redirect. La infraestructura
 * (Nginx Proxy Manager, Uptime Kuma) apunta aqui y no queremos que un
 * redirect 308 se le indigeste a un health checker simple.
 *
 * - `GET /health` — liveness: el proceso esta vivo y atiende HTTP.
 * - `GET /health/ready` — readiness: ademas comprueba Postgres y Redis.
 *   Es el que debe monitorizar Uptime Kuma: un `ok` aqui significa que la
 *   aplicacion puede servir requests de verdad, no solo que Node responde.
 */
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly admin: PrismaAdminService,
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
  ) {}

  @Get()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    const checks: { database: 'up' | 'down'; redis: 'up' | 'down' } = {
      database: 'down',
      redis: 'down',
    };
    try {
      await this.admin.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      // database queda 'down'
    }
    try {
      // La conexion ioredis de BullMQ ya existe; un PING no crea nada nuevo.
      const client = await this.queue.client;
      if ((await client.ping()) === 'PONG') checks.redis = 'up';
    } catch {
      // redis queda 'down'
    }
    if (checks.database !== 'up' || checks.redis !== 'up') {
      throw new ServiceUnavailableException({
        code: 'not_ready',
        message: 'Dependencias no disponibles',
        details: checks,
      });
    }
    return {
      status: 'ok',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
