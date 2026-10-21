import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { Ga4Service } from './ga4.service';

/** Descarga cada día los datos de GA4 de los tenants conectados. */
@Injectable()
export class Ga4Cron {
  private readonly logger = new Logger(Ga4Cron.name);

  constructor(
    private readonly ga4: Ga4Service,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('45 6 * * *', { name: 'ga4.daily' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'ga4.daily'))) return;
      const res = await this.ga4.syncAllDue();
      if (res.tenants > 0) this.logger.log(`GA4: ${res.synced}/${res.tenants} tenant(s)`);
    } catch (err) {
      this.logger.error(`Cron de GA4 falló: ${(err as Error).message}`);
    }
  }
}
