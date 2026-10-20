import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SearchConsoleService } from './search-console.service';

/** Descarga cada día las búsquedas de los tenants con Search Console conectado. */
@Injectable()
export class SearchConsoleCron {
  private readonly logger = new Logger(SearchConsoleCron.name);

  constructor(
    private readonly gsc: SearchConsoleService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('30 6 * * *', { name: 'search-console.daily' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'search-console.daily'))) return;
      const res = await this.gsc.syncAllDue();
      if (res.tenants > 0)
        this.logger.log(`Search Console: ${res.synced}/${res.tenants} tenant(s)`);
    } catch (err) {
      this.logger.error(`Cron de Search Console falló: ${(err as Error).message}`);
    }
  }
}
