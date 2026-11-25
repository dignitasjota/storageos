import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SeoGscSyncService } from './seo-gsc-sync.service';

/**
 * Descarga diaria de Search Console de SEO Avanzado (07:00 en España) y, al
 * arrancar el proceso que ejecuta la cola, vuelve a poner en ella lo que
 * quedó a medias.
 */
@Injectable()
export class SeoGscCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeoGscCron.name);

  constructor(
    private readonly sync: SeoGscSyncService,
    private readonly admin: PrismaAdminService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await this.sync.resumePending();
      if (n > 0) this.logger.log(`SEO: ${n} descarga(s) pendiente(s) vuelven a la cola`);
    } catch (err) {
      this.logger.error(`SEO: no se pudo reanudar lo pendiente: ${(err as Error).message}`);
    }
  }

  @Cron('0 7 * * *', { name: 'seo.gsc-daily', timeZone: 'Europe/Madrid' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'seo.gsc-daily'))) return;
      const res = await this.sync.enqueueDailyAll();
      if (res.enqueued > 0) {
        this.logger.log(`SEO: ${res.enqueued}/${res.domains} dominio(s) en la cola`);
      }
    } catch (err) {
      this.logger.error(`Cron de SEO Avanzado falló: ${(err as Error).message}`);
    }
  }
}
