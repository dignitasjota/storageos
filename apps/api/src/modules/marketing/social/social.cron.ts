import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SocialService } from './social.service';

/** Descarga cada día las métricas de Instagram y Facebook de los tenants conectados. */
@Injectable()
export class SocialCron {
  private readonly logger = new Logger(SocialCron.name);

  constructor(
    private readonly social: SocialService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('15 7 * * *', { name: 'social.daily' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'social.daily'))) return;
      const res = await this.social.syncAllDue();
      if (res.tenants > 0)
        this.logger.log(`Redes sociales: ${res.synced}/${res.tenants} tenant(s)`);
    } catch (err) {
      this.logger.error(`Cron de redes sociales falló: ${(err as Error).message}`);
    }
  }
}
