import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { PromotionsModule } from '../promotions/promotions.module';

import { AnniversaryUpdatesController } from './anniversary-updates.controller';
import { AnniversaryUpdatesService } from './anniversary-updates.service';
import { ContractEndingSoonCron } from './contract-ending-soon.cron';
import { ContractPdfController } from './contract-pdf.controller';
import { ContractPdfService } from './contract-pdf.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { DepositRegistryController } from './deposit-registry.controller';
import { DepositRegistryService } from './deposit-registry.service';
import { InspectionPhotosController } from './inspection-photos.controller';
import { InspectionPhotosService } from './inspection-photos.service';
import { PricingService } from './pricing.service';
import { ReservationExpiryCron } from './reservation-expiry.cron';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [AuthModule, PromotionsModule, BillingModule],
  controllers: [
    AnniversaryUpdatesController,
    DepositRegistryController,
    ContractsController,
    ReservationsController,
    ContractPdfController,
    InspectionPhotosController,
  ],
  providers: [
    AnniversaryUpdatesService,
    DepositRegistryService,
    ContractsService,
    ReservationsService,
    PricingService,
    ContractPdfService,
    InspectionPhotosService,
    // Los crons solo se montan donde corren los workers (worker en prod).
    ...(WORKERS_ENABLED_IN_API ? [ContractEndingSoonCron, ReservationExpiryCron] : []),
  ],
  exports: [ContractsService],
})
export class ContractsModule {}
