import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { RentIncreasesService } from './rent-increases.service';

/**
 * Aplica las tandas ECRI programadas cuya fecha efectiva ya llegó: sube el
 * precio de cada contrato y la siguiente factura recurrente sale al precio
 * nuevo. `applyDue`/`apply` solo comprueban `status:'pending'` con un SELECT
 * previo al UPDATE (sin condición atómica en el WHERE del update) → si el
 * worker escalara a varias réplicas, dos ejecuciones a la vez del mismo
 * cron podrían leer los mismos items `pending` y subir el precio del MISMO
 * contrato DOS veces. `claimDailyCronRun` (mismo patrón que winback/tenant
 * -digest/expenses-recurring) asegura que solo una réplica ejecute el cron
 * cada día, cerrando la carrera al nivel más simple sin tocar la lógica de
 * `apply`.
 *
 * Sub-bloque 14A.1: solo se registra cuando `ENABLE_WORKERS_IN_API=true`
 * (corre en el worker en producción).
 */
@Injectable()
export class RentIncreaseApplyCron {
  private readonly logger = new Logger(RentIncreaseApplyCron.name);

  constructor(
    private readonly service: RentIncreasesService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 6 * * *', { name: 'rent-increases.apply' })
  async run(): Promise<{ applied: number }> {
    if (!(await claimDailyCronRun(this.admin, 'rent-increases.apply'))) return { applied: 0 };
    const res = await this.service.applyDue();
    if (res.applied > 0) this.logger.log(`[rent-increase] tandas aplicadas hoy: ${res.applied}`);
    return res;
  }
}
