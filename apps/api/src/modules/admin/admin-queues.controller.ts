import { InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import { Public } from '../../common/decorators/public.decorator';
import {
  QUEUE_AUTOMATIONS,
  QUEUE_BILLING,
  QUEUE_COMMUNICATIONS,
  QUEUE_DUNNING,
  QUEUE_EMAIL,
  QUEUE_PAYMENTS,
  QUEUE_REPORTS,
  QUEUE_VERIFACTU,
  QUEUE_WEBHOOKS,
} from '../queues/queues.module';

import { AdminAudit } from './admin-audit.decorator';
import { AdminGuard } from './admin.guard';
import { RequireSuperadmin } from './require-superadmin.decorator';

/** Jobs por vuelta al reintentar o limpiar una cola entera. */
const BATCH_SIZE = 1000;

export interface AdminQueueStatusDto {
  name: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  /** Ultimos jobs fallidos (max 10) para diagnostico sin entrar a Redis. */
  recentFailed: Array<{
    id: string;
    name: string;
    failedReason: string | null;
    attemptsMade: number;
    timestamp: string | null;
  }>;
}

/**
 * Visibilidad de las colas BullMQ para el super admin. Los jobs fallidos
 * se retienen 30 dias en Redis (`removeOnFail` en QueuesModule) pero hasta
 * ahora nadie los veia: este endpoint expone counts por cola + los ultimos
 * fallos, sin montar un Bull Board completo.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/queues')
export class AdminQueuesController {
  private readonly queues: Queue[];

  constructor(
    @InjectQueue(QUEUE_BILLING) billing: Queue,
    @InjectQueue(QUEUE_DUNNING) dunning: Queue,
    @InjectQueue(QUEUE_PAYMENTS) payments: Queue,
    @InjectQueue(QUEUE_VERIFACTU) verifactu: Queue,
    @InjectQueue(QUEUE_EMAIL) email: Queue,
    @InjectQueue(QUEUE_COMMUNICATIONS) communications: Queue,
    @InjectQueue(QUEUE_AUTOMATIONS) automations: Queue,
    @InjectQueue(QUEUE_REPORTS) reports: Queue,
    @InjectQueue(QUEUE_WEBHOOKS) webhooks: Queue,
  ) {
    this.queues = [
      billing,
      dunning,
      payments,
      verifactu,
      email,
      communications,
      automations,
      reports,
      webhooks,
    ];
  }

  @Get()
  async list(): Promise<AdminQueueStatusDto[]> {
    return Promise.all(
      this.queues.map(async (queue) => {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        );
        const failedJobs = await queue.getFailed(0, 9);
        return {
          name: queue.name,
          counts: {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            completed: counts.completed ?? 0,
          },
          recentFailed: failedJobs.map((job) => ({
            id: String(job.id ?? ''),
            name: job.name,
            failedReason: job.failedReason ?? null,
            attemptsMade: job.attemptsMade,
            timestamp: job.timestamp ? new Date(job.timestamp).toISOString() : null,
          })),
        };
      }),
    );
  }

  /** Reintenta un job fallido concreto. */
  @RequireSuperadmin()
  @AdminAudit('admin.queue.job_retried')
  @Post(':name/jobs/:id/retry')
  @HttpCode(HttpStatus.OK)
  async retryJob(@Param('name') name: string, @Param('id') id: string): Promise<{ ok: true }> {
    const job = await this.failedJob(name, id);
    await job.retry();
    return { ok: true };
  }

  /** Elimina un job fallido concreto. */
  @RequireSuperadmin()
  @AdminAudit('admin.queue.job_removed')
  @Delete(':name/jobs/:id')
  @HttpCode(HttpStatus.OK)
  async removeJob(@Param('name') name: string, @Param('id') id: string): Promise<{ ok: true }> {
    const job = await this.failedJob(name, id);
    await job.remove();
    return { ok: true };
  }

  /** Reintenta todos los jobs fallidos de una cola. */
  @RequireSuperadmin()
  @AdminAudit('admin.queue.failed_retried')
  @Post(':name/retry-failed')
  @HttpCode(HttpStatus.OK)
  async retryFailed(@Param('name') name: string): Promise<{ retried: number }> {
    const queue = this.byName(name);
    let retried = 0;
    // Cada reintento saca el job de `failed`: se recorre por lotes hasta vaciarla.
    // Si un lote entero no se puede reintentar, se para para no dar vueltas.
    for (;;) {
      const failed = await queue.getFailed(0, BATCH_SIZE - 1);
      if (failed.length === 0) break;
      let done = 0;
      for (const job of failed) {
        try {
          await job.retry();
          done += 1;
        } catch {
          // El job pudo cambiar de estado entre el listado y el retry; lo ignoramos.
        }
      }
      retried += done;
      if (done === 0) break;
    }
    return { retried };
  }

  /** Elimina los jobs fallidos de una cola. */
  @RequireSuperadmin()
  @AdminAudit('admin.queue.failed_cleaned')
  @Post(':name/clean-failed')
  @HttpCode(HttpStatus.OK)
  async cleanFailed(@Param('name') name: string): Promise<{ cleaned: number }> {
    const queue = this.byName(name);
    let cleaned = 0;
    for (;;) {
      const removed = await queue.clean(0, BATCH_SIZE, 'failed');
      cleaned += removed.length;
      if (removed.length < BATCH_SIZE) break;
    }
    return { cleaned };
  }

  private async failedJob(name: string, id: string): Promise<Job> {
    const job = await this.byName(name).getJob(id);
    if (!job || !(await job.isFailed())) {
      throw new NotFoundException({ code: 'job_not_found', message: 'Job no encontrado' });
    }
    return job;
  }

  private byName(name: string): Queue {
    const queue = this.queues.find((q) => q.name === name);
    if (!queue) {
      throw new NotFoundException({ code: 'queue_not_found', message: 'Cola no encontrada' });
    }
    return queue;
  }
}
