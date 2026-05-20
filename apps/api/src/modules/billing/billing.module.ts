import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { QUEUE_BILLING, QUEUE_VERIFACTU } from '../queues/queues.module';

import { AEAT_CLIENT } from './aeat-client/aeat-client';
import { RealAeatClient } from './aeat-client/real-aeat.client';
import { StubAeatClient } from './aeat-client/stub-aeat.client';
import { VerifactuXmlBuilder } from './aeat-client/verifactu-xml-builder';
import { BillingJobsService } from './billing-jobs.service';
import { BillingRecurringProcessor } from './billing-recurring.processor';
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

/**
 * Sub-bloque 14A.1: los Processors (`VerifactuProcessor`,
 * `BillingRecurringProcessor`) se registran solo cuando
 * `ENABLE_WORKERS_IN_API` esta activo (default `true`, override a
 * `false` en `.env.prod` del API). `BillingJobsService` se queda siempre
 * registrado porque el controller HTTP lo necesita para encolar jobs
 * manuales (`POST /billing/jobs/run-recurring`).
 */
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
    ...(WORKERS_ENABLED_IN_API ? [VerifactuProcessor, BillingRecurringProcessor] : []),
  ],
  exports: [
    InvoicesService,
    InvoiceSeriesService,
    PricingRulesService,
    TenantAeatCredentialsService,
  ],
})
export class BillingModule {}
