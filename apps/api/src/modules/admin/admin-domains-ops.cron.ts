import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminDomainsOpsService } from './admin-domains-ops.service';

/** Vigila cada día los dominios propios activos: DNS, https y caducidad del certificado. */
@Injectable()
export class AdminDomainsOpsCron {
  private readonly logger = new Logger(AdminDomainsOpsCron.name);

  constructor(
    private readonly service: AdminDomainsOpsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('40 6 * * *', { name: 'custom-domains.full-check' })
  async handle(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'custom-domains.full-check'))) return;
      const r = await this.service.checkAll({ byId: null, onlyActive: true });
      if (r.failing > 0) this.logger.warn(`[domains] ${r.failing} de ${r.checked} con problemas`);
    } catch (err) {
      this.logger.error(`[domains] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
