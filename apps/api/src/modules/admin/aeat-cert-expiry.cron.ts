import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AeatCertExpiryService } from './aeat-cert-expiry.service';

/** Avisos diarios de caducidad de los certificados de la AEAT (ligero: corre en el API). */
@Injectable()
export class AeatCertExpiryCron {
  private readonly logger = new Logger(AeatCertExpiryCron.name);

  constructor(
    private readonly service: AeatCertExpiryService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('30 7 * * *', { name: 'aeat-cert-expiry.daily' })
  async handle(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'aeat-cert-expiry.daily'))) return;
      const sent = await this.service.run();
      if (sent > 0) this.logger.log(`[aeat-cert] avisos enviados: ${sent}`);
    } catch (err) {
      this.logger.error(`[aeat-cert] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
