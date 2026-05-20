import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { AgingGenerator } from './generators/aging.generator';
import { ContractsActiveGenerator } from './generators/contracts-active.generator';
import { InvoicesPeriodGenerator } from './generators/invoices-period.generator';
import { PdfRenderer } from './renderers/pdf-renderer';
import { XlsxRenderer } from './renderers/xlsx-renderer';
import { ReportsController } from './reports.controller';
import { ReportsProcessor } from './reports.processor';
import { ReportsService } from './reports.service';

@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportsProcessor,
    PdfRenderer,
    XlsxRenderer,
    InvoicesPeriodGenerator,
    ContractsActiveGenerator,
    AgingGenerator,
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
