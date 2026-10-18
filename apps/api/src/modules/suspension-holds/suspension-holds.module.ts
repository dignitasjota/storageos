import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { CommunicationsModule } from '../communications/communications.module';
import { PaymentsModule } from '../payments/payments.module';

import { SuspensionHoldsCron } from './suspension-holds.cron';

/** Libera cobros y correos retenidos mientras el tenant estuvo suspendido. */
@Module({
  imports: [CommunicationsModule, PaymentsModule],
  providers: [...(WORKERS_ENABLED_IN_API ? [SuspensionHoldsCron] : [])],
})
export class SuspensionHoldsModule {}
