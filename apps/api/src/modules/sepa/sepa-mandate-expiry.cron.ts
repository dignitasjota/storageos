import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SepaService } from './sepa.service';

/**
 * Caduca cada día los mandatos SEPA con 36 meses sin ningún adeudo: dejan de
 * contar como forma de pago (correo de la factura, cuenta del inquilino,
 * reservas) aunque nadie abra la remesa. Ligero: corre en el API, una vez al
 * día entre réplicas (`claimDailyCronRun`).
 */
@Injectable()
export class SepaMandateExpiryCron {
  private readonly logger = new Logger(SepaMandateExpiryCron.name);

  constructor(
    private readonly sepa: SepaService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('20 5 * * *', { name: 'sepa.mandate-expiry', timeZone: 'Europe/Madrid' })
  async run(): Promise<number> {
    if (!(await claimDailyCronRun(this.admin, 'sepa.mandate-expiry'))) return 0;
    const expired = await this.sepa.expireMandatesAll();
    if (expired > 0) this.logger.log(`[sepa] ${expired} mandato(s) caducados`);
    return expired;
  }
}
