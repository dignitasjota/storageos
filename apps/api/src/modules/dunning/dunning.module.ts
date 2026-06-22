import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { QUEUE_DUNNING } from '../queues/queues.module';

import { DunningController } from './dunning.controller';
import { DunningProcessor } from './dunning.processor';
import { DunningService } from './dunning.service';

/**
 * Sub-bloque 14A.1: `DunningService` solo se usa desde el cron y el
 * worker BullMQ, no desde controllers HTTP. Por eso lo registramos
 * condicionalmente junto con `DunningProcessor`. El `DunningController`
 * (lectura del historial de acciones) sigue activo siempre — usa
 * directamente `PrismaService` sin pasar por `DunningService`.
 */
@Module({
  imports: [
    AuthModule,
    AccessModule,
    // BillingModule: para emitir la factura de recargo por mora (late_fee).
    BillingModule,
    BullModule.registerQueue({ name: QUEUE_DUNNING }),
  ],
  controllers: [DunningController],
  providers: [...(WORKERS_ENABLED_IN_API ? [DunningService, DunningProcessor] : [])],
})
export class DunningModule {}
