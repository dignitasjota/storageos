import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';

import { Public } from '../../common/decorators/public.decorator';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';
import { QUEUE_BILLING } from '../queues/queue-names';
import { WORKERS_HEARTBEAT_KEY } from '../queues/workers-heartbeat.cron';

import { AdminGuard } from './admin.guard';

import type { AdminSystemHealthDto, AdminSystemServiceDto } from '@storageos/shared';

/**
 * Status page del super admin: estado en vivo de las dependencias de
 * infraestructura (Postgres, Redis, MinIO y el worker de jobs). Reutiliza la
 * conexión ioredis de BullMQ para el PING + heartbeat, `PrismaAdminService`
 * para Postgres y `FilesService.ping()` para MinIO.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/system-health')
export class AdminSystemController {
  constructor(
    private readonly admin: PrismaAdminService,
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
    private readonly files: FilesService,
  ) {}

  @Get()
  async health(): Promise<AdminSystemHealthDto> {
    const [database, redis, minio, worker] = await Promise.all([
      this.timed('database', 'Base de datos (Postgres)', async () => {
        await this.admin.$queryRaw`SELECT 1`;
        return null;
      }),
      this.timed('redis', 'Redis', async () => {
        const client = await this.queue.client;
        const pong = await client.ping();
        if (pong !== 'PONG') throw new Error('Sin respuesta PONG');
        return null;
      }),
      this.timed('minio', 'Almacenamiento (MinIO)', async () => {
        await this.files.ping();
        return null;
      }),
      this.checkWorker(),
    ]);
    return {
      checkedAt: new Date().toISOString(),
      services: [database, redis, minio, worker],
    };
  }

  private async timed(
    key: string,
    label: string,
    fn: () => Promise<string | null>,
  ): Promise<AdminSystemServiceDto> {
    const start = Date.now();
    try {
      const detail = await fn();
      return { key, label, status: 'up', detail, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        key,
        label,
        status: 'down',
        detail: (err as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }

  private async checkWorker(): Promise<AdminSystemServiceDto> {
    const start = Date.now();
    try {
      const client = await this.queue.client;
      const heartbeat = await client.get(WORKERS_HEARTBEAT_KEY);
      if (!heartbeat) {
        return {
          key: 'worker',
          label: 'Worker (jobs)',
          status: 'down',
          detail: 'Sin heartbeat en los últimos 3 minutos',
          latencyMs: Date.now() - start,
        };
      }
      return {
        key: 'worker',
        label: 'Worker (jobs)',
        status: 'up',
        detail: `Último latido: ${heartbeat}`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        key: 'worker',
        label: 'Worker (jobs)',
        status: 'down',
        detail: (err as Error).message,
        latencyMs: Date.now() - start,
      };
    }
  }
}
