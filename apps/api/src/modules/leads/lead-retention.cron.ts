import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { claimDailyCronRun } from '../../common/cron-claim';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { LeadCrmService } from './lead-crm.service';

/**
 * Cada noche borra los datos de los contactos perdidos que llevan más tiempo
 * del que guarda cada empresa sin actividad. Corre en el API: la ejecución del
 * día se reserva, así que varias réplicas no lo repiten.
 */
@Injectable()
export class LeadRetentionCron {
  private readonly logger = new Logger(LeadRetentionCron.name);

  constructor(
    private readonly crm: LeadCrmService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('40 4 * * *', { name: 'leads.retention', timeZone: 'Europe/Madrid' })
  async run(): Promise<void> {
    try {
      if (!(await claimDailyCronRun(this.admin, 'leads.retention'))) return;
      const n = await this.crm.anonymizeStale();
      if (n > 0) this.logger.log(`Contactos perdidos anonimizados: ${n}`);
    } catch (err) {
      this.logger.error(`Retención de contactos falló: ${(err as Error).message}`);
    }
  }
}
