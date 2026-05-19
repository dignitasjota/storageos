import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ContractPdfController } from './contract-pdf.controller';
import { ContractPdfService } from './contract-pdf.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { PricingService } from './pricing.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [AuthModule],
  controllers: [ContractsController, ReservationsController, ContractPdfController],
  providers: [ContractsService, ReservationsService, PricingService, ContractPdfService],
  exports: [ContractsService],
})
export class ContractsModule {}
