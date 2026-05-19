import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { QUEUE_BILLING } from '../queues/queues.module';

import { BillingJobsService } from './billing-jobs.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceSeriesController } from './invoice-series.controller';
import { InvoiceSeriesService } from './invoice-series.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PricingRulesService } from './pricing-rules.service';
import { VerifactuService } from './verifactu.service';

@Module({
  imports: [AuthModule, PaymentsModule, BullModule.registerQueue({ name: QUEUE_BILLING })],
  controllers: [InvoicesController, InvoiceSeriesController],
  providers: [
    InvoiceSeriesService,
    InvoicesService,
    InvoicePdfService,
    VerifactuService,
    PricingRulesService,
    BillingJobsService,
  ],
  exports: [InvoicesService, InvoiceSeriesService, PricingRulesService],
})
export class BillingModule {}
