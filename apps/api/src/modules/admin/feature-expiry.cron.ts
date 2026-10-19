import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { FeatureExpiryService } from './feature-expiry.service';

/**
 * Cortesías y pruebas gratis que caducan (07:45). Ligero: corre en el API,
 * una sola réplica por día con `claimDailyCronRun`. Entre ejecuciones las
 * caducadas ya no cuentan (`liveOverrideWhere`).
 */
@Injectable()
export class FeatureExpiryCron {
  private readonly logger = new Logger(FeatureExpiryCron.name);

  constructor(
    private readonly expiry: FeatureExpiryService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('45 7 * * *', { name: 'feature-overrides.expiry' })
  async run(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'feature-overrides.expiry'))) return;
      await this.expiry.run();
    } catch (err) {
      this.logger.error(`feature-overrides.expiry fallo: ${(err as Error).message}`);
    }
  }
}
