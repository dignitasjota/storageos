import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { QUEUE_BILLING, QUEUE_VERIFACTU } from '../queues/queues.module';

import { AEAT_CLIENT } from './aeat-client/aeat-client';
import { RealAeatClient } from './aeat-client/real-aeat.client';
import { StubAeatClient } from './aeat-client/stub-aeat.client';
import { VerifactuXmlBuilder } from './aeat-client/verifactu-xml-builder';
import { BillingJobsService } from './billing-jobs.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { InvoiceSeriesController } from './invoice-series.controller';
import { InvoiceSeriesService } from './invoice-series.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PricingRulesService } from './pricing-rules.service';
import { TenantAeatCredentialsController } from './tenant-aeat-credentials.controller';
import { TenantAeatCredentialsService } from './tenant-aeat-credentials.service';
import { VerifactuAeatController } from './verifactu-aeat.controller';
import { VerifactuProcessor } from './verifactu.processor';
import { VerifactuService } from './verifactu.service';

import type { Env } from '../../config/env.schema';

@Module({
  imports: [
    AuthModule,
    PaymentsModule,
    BullModule.registerQueue({ name: QUEUE_BILLING }, { name: QUEUE_VERIFACTU }),
  ],
  controllers: [
    InvoicesController,
    InvoiceSeriesController,
    TenantAeatCredentialsController,
    VerifactuAeatController,
  ],
  providers: [
    InvoiceSeriesService,
    InvoicesService,
    InvoicePdfService,
    VerifactuService,
    VerifactuProcessor,
    PricingRulesService,
    BillingJobsService,
    TenantAeatCredentialsService,
    VerifactuXmlBuilder,
    StubAeatClient,
    RealAeatClient,
    {
      provide: AEAT_CLIENT,
      useFactory: (config: ConfigService<Env, true>, stub: StubAeatClient, real: RealAeatClient) =>
        config.get('AEAT_MODE', { infer: true }) === 'stub' ? stub : real,
      inject: [ConfigService, StubAeatClient, RealAeatClient],
    },
  ],
  exports: [
    InvoicesService,
    InvoiceSeriesService,
    PricingRulesService,
    TenantAeatCredentialsService,
  ],
})
export class BillingModule {}
