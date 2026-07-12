import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { TenantMonthlyDigestService } from './tenant-monthly-digest.service';

/**
 * Envía el informe mensual del negocio a los operadores el día 1 de cada mes.
 * Ligero (encola emails, sin BullMQ propio) → corre en el API con
 * `claimDailyCronRun` para que solo una réplica lo ejecute. Idempotente por día.
 */
@Injectable()
export class TenantMonthlyDigestCron {
  private readonly logger = new Logger(TenantMonthlyDigestCron.name);

  constructor(
    private readonly digest: TenantMonthlyDigestService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 8 1 * *')
  async monthly(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'tenant-monthly-digest.monthly'))) return;
      const res = await this.digest.sendDueAll();
      if (res.sent > 0) {
        this.logger.log(`Digest mensual enviado a ${res.sent}/${res.tenants} tenant(s)`);
      }
    } catch (err) {
      this.logger.error(`Cron del digest mensual falló: ${(err as Error).message}`);
    }
  }
}
