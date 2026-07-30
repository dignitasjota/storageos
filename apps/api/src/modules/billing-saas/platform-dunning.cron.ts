import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { PlatformDunningService } from './platform-dunning.service';
import { SaasAddonsService } from './saas-addons.service';

/**
 * Cron diario del dunning del SaaS. Sin gatear por `WORKERS_ENABLED_IN_API`
 * (es ligero y no depende de BullMQ, igual que las alertas de plataforma);
 * corre en el proceso API.
 */
@Injectable()
export class PlatformDunningCron {
  private readonly logger = new Logger(PlatformDunningCron.name);

  constructor(
    private readonly dunning: PlatformDunningService,
    private readonly addons: SaasAddonsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 8 * * *')
  async daily(): Promise<void> {
    try {
      // Con varias réplicas del API, solo una debe ejecutar el dunning del día.
      if (!(await claimDailyCronRun(this.admin, 'platform-dunning.daily'))) return;
      // 1) Enforcement de impagos manuales → past_due (banner al tenant desde el
      //    primer día). Se ejecuta SIEMPRE, aunque el dunning escalado esté off.
      await this.dunning.markLapsedManualPastDue();
      // 2) Escalado del dunning del plan (recordatorios + suspensión), si está activado.
      await this.dunning.run();
      // 3) Auto-suspensión de add-ons manuales impagados (gateada por el dunning).
      await this.addons.suspendLapsedManualAddons();
    } catch (err) {
      this.logger.error(`Dunning cron falló: ${(err as Error).message}`);
    }
  }
}
