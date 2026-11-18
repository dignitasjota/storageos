import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SaasAddonsService } from './saas-addons.service';

/**
 * Cada mañana, antes de preparar remesas y cobros: fija los trasteros de más
 * del plan Basic de las suscripciones que cobran en los próximos 7 días. Corre
 * en el API (ligero) y se reserva para que con varias réplicas no se repita.
 */
@Injectable()
export class ExtraUnitsCron {
  private readonly logger = new Logger(ExtraUnitsCron.name);

  constructor(
    private readonly addons: SaasAddonsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('15 6 * * *', { name: 'extra-units.daily', timeZone: 'Europe/Madrid' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'extra-units.daily'))) return;
      const changed = await this.addons.syncAllExtraUnits();
      if (changed) this.logger.log(`[basic] trasteros de más fijados en ${changed} cuentas`);
    } catch (err) {
      this.logger.error(`[basic] trasteros de más: ${String(err)}`);
    }
  }
}
