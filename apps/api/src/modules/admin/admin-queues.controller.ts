import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';

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

import { AdminGuard } from './admin.guard';

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
}
