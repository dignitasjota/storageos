import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { WinbackService } from './winback.service';

/**
 * Cron diario del win-back automático de bajas. Ligero (encola emails, se
 * deduplica con `winback_sends`) → corre en el API con `claimDailyCronRun` para
 * que solo una réplica lo ejecute al día, como los demás digests/dunning.
 */
@Injectable()
export class WinbackCron {
  private readonly logger = new Logger(WinbackCron.name);

  constructor(
    private readonly winback: WinbackService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('0 9 * * *')
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'winback.daily'))) return;
      const res = await this.winback.runDueAll();
      if (res.sent > 0) {
        this.logger.log(`Win-back: ${res.sent} oferta(s) en ${res.tenants} tenant(s)`);
      }
    } catch (err) {
      this.logger.error(`Cron de win-back falló: ${(err as Error).message}`);
    }
  }
}
