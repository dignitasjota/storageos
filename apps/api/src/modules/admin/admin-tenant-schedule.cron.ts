import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantLifecycleService } from './admin-tenant-lifecycle.service';

/**
 * Cron diario (00:30, hora de España) que aplica las bajas programadas (fin del
 * periodo pagado) y ejecuta las anonimizaciones cuyo periodo de gracia acaba
 * hoy. Corre en el API (como los demás crons del panel admin) y solo una
 * réplica lo hace (`claimDailyCronRun`).
 */
@Injectable()
export class AdminTenantScheduleCron {
  private readonly logger = new Logger(AdminTenantScheduleCron.name);

  constructor(
    private readonly lifecycle: AdminTenantLifecycleService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('30 0 * * *', { name: 'admin-tenants.scheduled', timeZone: 'Europe/Madrid' })
  async run(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'admin-tenants.scheduled'))) return;
      const cancelled = await this.lifecycle.applyDueCancellations();
      const anonymized = await this.lifecycle.runDueAnonymizations();
      if (cancelled + anonymized > 0) {
        this.logger.log(`admin-tenants.scheduled: bajas=${cancelled}, anonimizados=${anonymized}`);
      }
    } catch (err) {
      this.logger.error(`admin-tenants.scheduled fallo: ${(err as Error).message}`);
    }
  }
}
