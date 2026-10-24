import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { PlatformRedsysService } from './platform-redsys.service';

/**
 * Cobro automático de las suscripciones con tarjeta guardada en el TPV de la
 * plataforma. Antes del control de impagos de las 08:00, para que un cobro que
 * entra no llegue a marcar la suscripción como pendiente. Sin gatear (ligero,
 * como el dunning del SaaS); con varias réplicas solo una lo ejecuta.
 */
@Injectable()
export class PlatformRedsysCron {
  private readonly logger = new Logger(PlatformRedsysCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly redsys: PlatformRedsysService,
  ) {}

  @Cron('0 6 * * *', { name: 'platform-redsys.auto-charge' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'platform-redsys.auto-charge'))) return;
      const res = await this.redsys.runAutoCharges();
      if (res.charged || res.failed) {
        this.logger.log(
          `Cobro automático Redsys: ${res.charged} cobrados, ${res.failed} rechazados`,
        );
      }
    } catch (err) {
      this.logger.error(`Cobro automático Redsys falló: ${(err as Error).message}`);
    }
  }
}
