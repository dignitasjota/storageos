import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { BillingModule } from '../billing/billing.module';
import { CommunicationsModule } from '../communications/communications.module';
import { ContractsModule } from '../contracts/contracts.module';
import { ReferralsModule } from '../referrals/referrals.module';

import { BookingExpiryCron } from './booking-expiry.cron';
import { BookingRecoveryCron } from './booking-recovery.cron';
import { BookingRecoveryService } from './booking-recovery.service';
import { BookingService } from './booking.service';
import { ContractSignaturesController } from './contract-signatures.controller';
import { MoveInPublicController } from './move-in-public.controller';
import { SignaturesService } from './signatures.service';

/**
 * Move-in self-service + firma electrónica simple.
 * - Público: disponibilidad/alta por slug + firma por token.
 * - Staff: solicitar firma + ver el registro probatorio.
 */
@Module({
  imports: [
    ContractsModule,
    BillingModule,
    ReferralsModule,
    CommunicationsModule,
    JwtModule.register({}),
  ],
  controllers: [MoveInPublicController, ContractSignaturesController],
  providers: [
    SignaturesService,
    BookingService,
    BookingRecoveryService,
    ...(WORKERS_ENABLED_IN_API ? [BookingExpiryCron, BookingRecoveryCron] : []),
  ],
  exports: [SignaturesService, BookingRecoveryService],
})
export class MoveInModule {}
