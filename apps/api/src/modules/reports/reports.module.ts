import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { OwnersModule } from '../owners/owners.module';

import { AgingGenerator } from './generators/aging.generator';
import { CollectionsMonthGenerator } from './generators/collections-month.generator';
import { ContractsActiveGenerator } from './generators/contracts-active.generator';
import { InvoicesPeriodGenerator } from './generators/invoices-period.generator';
import { MoveOutsPeriodGenerator } from './generators/move-outs-period.generator';
import { OccupancySnapshotGenerator } from './generators/occupancy-snapshot.generator';
import { OwnerStatementGenerator } from './generators/owner-statement.generator';
import { PdfRenderer } from './renderers/pdf-renderer';
import { XlsxRenderer } from './renderers/xlsx-renderer';
import { ReportsController } from './reports.controller';
import { ReportsProcessor } from './reports.processor';
import { ReportsService } from './reports.service';

/**
 * Sub-bloque 14A.1: `ReportsProcessor` solo se registra cuando
 * `ENABLE_WORKERS_IN_API=true`. `ReportsService` (que el controller usa
 * para encolar nuevos runs y consultar progreso) sigue siempre activo.
 */
@Module({
  imports: [AuthModule, OwnersModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    PdfRenderer,
    XlsxRenderer,
    InvoicesPeriodGenerator,
    ContractsActiveGenerator,
    AgingGenerator,
    OccupancySnapshotGenerator,
    CollectionsMonthGenerator,
    MoveOutsPeriodGenerator,
    OwnerStatementGenerator,
    ...(WORKERS_ENABLED_IN_API ? [ReportsProcessor] : []),
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
