import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { madridToday } from '@storageos/shared';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SistrixSyncService } from './sistrix-sync.service';

/**
 * Tareas de SISTRIX (en el worker):
 * - `seo.sistrix-schedule`, cada hora: reanuda lo que esperaba y encola lo que
 *   toca según la frecuencia de cada fondo (una réplica por hora).
 * - `seo.sistrix-resume`, a las 00:05 de Madrid: vuelve la cuota del MCP.
 * - `seo.sistrix-daily`, a las 06:30: catálogo de herramientas (`tools/list`)
 *   y limpieza del registro y la caché.
 * Al arrancar, lo que quedó a medias vuelve a la cola.
 */
@Injectable()
export class SistrixCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(SistrixCron.name);

  constructor(
    private readonly sync: SistrixSyncService,
    private readonly admin: PrismaAdminService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await this.sync.resumePending();
      if (n > 0) this.logger.log(`SISTRIX: ${n} tanda(s) pendiente(s) vuelven a la cola`);
    } catch (err) {
      this.logger.error(`SISTRIX: no se pudo reanudar lo pendiente: ${(err as Error).message}`);
    }
  }

  @Cron('15 * * * *', { name: 'seo.sistrix-schedule', timeZone: 'Europe/Madrid' })
  async hourly(): Promise<void> {
    try {
      const hour = new Date().toISOString().slice(11, 13);
      if (!(await claimDailyCronRun(this.admin, `seo.sistrix-schedule:${hour}`))) return;
      await this.sync.resumeWaiting();
      const res = await this.sync.scheduleDue();
      if (res.enqueued > 0) this.logger.log(`SISTRIX: ${res.enqueued} tanda(s) en la cola`);
    } catch (err) {
      this.logger.error(`Programador de SISTRIX falló: ${(err as Error).message}`);
    }
  }

  @Cron('5 0 * * *', { name: 'seo.sistrix-resume', timeZone: 'Europe/Madrid' })
  async resume(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, `seo.sistrix-resume:${madridToday()}`))) return;
      const n = await this.sync.resumeWaiting();
      if (n > 0) this.logger.log(`SISTRIX: ${n} tanda(s) en espera vuelven a la cola`);
    } catch (err) {
      this.logger.error(`Reanudación de SISTRIX falló: ${(err as Error).message}`);
    }
  }

  @Cron('30 6 * * *', { name: 'seo.sistrix-daily', timeZone: 'Europe/Madrid' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo.sistrix-daily'))) return;
      await this.sync.dailyTools();
      await this.sync.cleanup();
    } catch (err) {
      this.logger.error(`Tarea diaria de SISTRIX falló: ${(err as Error).message}`);
    }
  }
}
