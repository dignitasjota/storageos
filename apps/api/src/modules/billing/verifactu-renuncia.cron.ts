import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { VerifactuSettingsService } from './verifactu-settings.service';

/**
 * Baja programada de VERI*FACTU (art. 17 de la Orden HAC/1177/2024): cada día,
 * los negocios cuyo último día ya pasó dejan de enviar si la renuncia llegó a
 * la AEAT; si no, siguen y se les avisa (`applyDueRenuncias`).
 */
@Injectable()
export class VerifactuRenunciaCron {
  private readonly logger = new Logger(VerifactuRenunciaCron.name);

  constructor(
    private readonly settings: VerifactuSettingsService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('20 0 * * *', { name: 'verifactu.renuncia', timeZone: 'Europe/Madrid' })
  async run(): Promise<void> {
    if (!(await claimDailyCronRun(this.admin, 'verifactu.renuncia'))) return;
    const res = await this.settings.applyDueRenuncias();
    if (res.disabled + res.kept > 0) {
      this.logger.log(
        `[verifactu.renuncia] ${res.disabled} baja(s) aplicada(s), ${res.kept} sin comunicar`,
      );
    }
  }
}
