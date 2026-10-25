import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ContractsService } from './contracts.service';

/**
 * Cada mañana prorroga o pasa a baja los contratos que llegaron a su fecha de
 * fin y finaliza los contratos en baja cuya fecha de fin ya pasó (si el
 * tenant no lo ha desactivado). Solo se registra con `ENABLE_WORKERS_IN_API`
 * (en producción corre en el worker).
 */
@Injectable()
export class ContractAutoEndCron {
  private readonly logger = new Logger(ContractAutoEndCron.name);

  constructor(private readonly contracts: ContractsService) {}

  @Cron('30 5 * * *', { name: 'contracts.auto-end' })
  async run(): Promise<void> {
    try {
      const { renewed, ending } = await this.contracts.autoRenewDue();
      if (renewed + ending > 0)
        this.logger.log(`Contratos vencidos: ${renewed} prorrogados, ${ending} pasan a baja`);
      const { ended } = await this.contracts.autoEndDue();
      if (ended > 0) this.logger.log(`Contratos finalizados en su fecha de baja: ${ended}`);
    } catch (err) {
      this.logger.error(`contracts.auto-end falló: ${(err as Error).message}`);
    }
  }
}
