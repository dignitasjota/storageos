import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { RentIncreasesService } from './rent-increases.service';

/**
 * Aplica las subidas de precio cuya fecha ya llegó. Corre a las 00:10 de
 * Madrid, antes de la facturación del día (02:00 UTC), para que la factura del
 * mes salga ya con la cuota nueva. Cada contrato se reserva antes de tocarlo,
 * así que dos ejecuciones a la vez no suben dos veces la misma cuota.
 *
 * Solo se registra con `ENABLE_WORKERS_IN_API=true` (en producción, el worker).
 */
@Injectable()
export class RentIncreaseApplyCron {
  private readonly logger = new Logger(RentIncreaseApplyCron.name);

  constructor(
    private readonly service: RentIncreasesService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('10 0 * * *', { name: 'rent-increases.apply', timeZone: 'Europe/Madrid' })
  async run(): Promise<{ applied: number }> {
    if (!(await claimDailyCronRun(this.admin, 'rent-increases.apply'))) return { applied: 0 };
    const res = await this.service.applyDue();
    if (res.applied > 0) this.logger.log(`[rent-increase] contratos subidos hoy: ${res.applied}`);
    return res;
  }
}
