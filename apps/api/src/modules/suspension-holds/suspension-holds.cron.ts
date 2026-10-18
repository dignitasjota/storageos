import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { CommunicationsService } from '../communications/communications.service';
import { AutoChargeService } from '../payments/auto-charge.service';

/**
 * Cuando un tenant suspendido paga su suscripción, sus cobros a inquilinos y
 * los correos que quedaron en espera salen solos (cada hora). Corre en el
 * worker (`ENABLE_WORKERS_IN_API`); los reclamos son atómicos por fila.
 */
@Injectable()
export class SuspensionHoldsCron {
  private readonly logger = new Logger(SuspensionHoldsCron.name);

  constructor(
    private readonly communications: CommunicationsService,
    private readonly autoCharge: AutoChargeService,
  ) {}

  @Cron('40 * * * *', { name: 'suspension-holds.release' })
  async run(): Promise<{ charges: number; emails: number; expired: number }> {
    const charges = await this.autoCharge.releaseHeld();
    const { released, expired } = await this.communications.releaseHeld();
    if (charges + released + expired > 0) {
      this.logger.log(
        `[suspension-holds] ${charges} cobros y ${released} envíos liberados, ${expired} envíos caducados`,
      );
    }
    return { charges, emails: released, expired };
  }
}
