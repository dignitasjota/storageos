import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { PromotionsModule } from '../promotions/promotions.module';

import { CheckoutPhotosController } from './checkout-photos.controller';
import { CheckoutPhotosService } from './checkout-photos.service';
import { ContractEndingSoonCron } from './contract-ending-soon.cron';
import { ContractPdfController } from './contract-pdf.controller';
import { ContractPdfService } from './contract-pdf.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { PricingService } from './pricing.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [AuthModule, PromotionsModule],
  controllers: [
    ContractsController,
    ReservationsController,
    ContractPdfController,
    CheckoutPhotosController,
  ],
  providers: [
    ContractsService,
    ReservationsService,
    PricingService,
    ContractPdfService,
    CheckoutPhotosService,
    // El cron solo se monta donde corren los workers (worker en prod).
    ...(WORKERS_ENABLED_IN_API ? [ContractEndingSoonCron] : []),
  ],
  exports: [ContractsService],
})
export class ContractsModule {}
