import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { ProductUpdatesDigestService } from './product-updates-digest.service';

/**
 * Resumen mensual de «Novedades» por correo: el día 2 de cada mes a las 9:00
 * (hora de Madrid). Corre en el worker; `claimDailyCronRun` y la reserva por
 * usuario y mes evitan envíos dobles entre réplicas.
 */
@Injectable()
export class ProductUpdatesDigestCron {
  private readonly logger = new Logger(ProductUpdatesDigestCron.name);

  constructor(
    private readonly digest: ProductUpdatesDigestService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 9 2 * *', { name: 'product-updates-digest.monthly', timeZone: 'Europe/Madrid' })
  async monthly(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'product-updates-digest.monthly'))) return;
      const res = await this.digest.sendMonthly();
      if (res.sent > 0) {
        this.logger.log(
          `Resumen de novedades de ${res.month} (${res.updates}) enviado a ${res.sent} usuario(s)`,
        );
      }
    } catch (err) {
      this.logger.error(`Resumen de novedades falló: ${(err as Error).message}`);
    }
  }
}
