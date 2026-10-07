import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';

/** Tipo del job de la librería `cron` (sin depender de ella directamente). */
type CronJob = ReturnType<SchedulerRegistry['getCronJob']>;

/** Proceso que ejecuta las tareas: el worker lo indica al arrancar. */
const PROCESS_NAME = process.env.APP_PROCESS === 'worker' ? 'worker' : 'api';

/**
 * Vigila TODAS las tareas programadas (`@Cron`) sin tocarlas: al arrancar
 * registra cada una con su expresión y su próxima ejecución, y en cada
 * ejecución anota la hora y la siguiente prevista. Si la prevista pasa sin
 * ejecutarse (proceso caído, tarea bloqueada…), el panel del super admin avisa.
 * Best-effort: un fallo al anotar nunca afecta a la tarea.
 */
@Injectable()
export class CronMonitorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CronMonitorService.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly admin: PrismaAdminService,
  ) {}

  onApplicationBootstrap(): void {
    for (const [name, job] of this.registry.getCronJobs()) {
      void this.record(name, job, false);
      job.addCallback(() => this.record(name, job, true));
    }
  }

  private async record(name: string, job: CronJob, ran: boolean): Promise<void> {
    try {
      const nextRunAt = job.nextDate().toJSDate();
      const expression = String(job.cronTime.source);
      await this.admin.cronHeartbeat.upsert({
        where: { name },
        create: {
          name,
          process: PROCESS_NAME,
          expression,
          nextRunAt,
          ...(ran ? { lastRunAt: new Date() } : {}),
        },
        update: {
          process: PROCESS_NAME,
          expression,
          nextRunAt,
          ...(ran ? { lastRunAt: new Date() } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(
        `[cron-monitor] no se pudo anotar ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
