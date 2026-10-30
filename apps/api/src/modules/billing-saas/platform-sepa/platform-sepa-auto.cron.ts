import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../../common/cron-claim';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { PlatformSepaRemittanceService } from './platform-sepa-remittance.service';

/**
 * Remesa SEPA de la plataforma preparada sola (si está activado) y aviso de
 * remesas sin confirmar. Ligero y sin BullMQ: corre en el API, como el escalado.
 */
@Injectable()
export class PlatformSepaAutoCron {
  private readonly logger = new Logger(PlatformSepaAutoCron.name);

  constructor(
    private readonly remittances: PlatformSepaRemittanceService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('30 7 * * *', { name: 'platform-sepa.auto-prepare' })
  async daily(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'platform-sepa.auto-prepare'))) return;
      await this.remittances.autoPrepare();
    } catch (err) {
      this.logger.error(`Remesa automática falló: ${(err as Error).message}`);
    }
  }
}
