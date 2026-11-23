import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { TenantDataExportModule } from '../admin/tenant-data-export.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { OwnersModule } from '../owners/owners.module';

import { AgingGenerator } from './generators/aging.generator';
import { AnalyticsMonthGenerator } from './generators/analytics-month.generator';
import { CollectionsMonthGenerator } from './generators/collections-month.generator';
import { ContractsActiveGenerator } from './generators/contracts-active.generator';
import { EXTRA_REPORT_GENERATORS } from './generators/extra-reports.generators';
import { InvoicesPeriodGenerator } from './generators/invoices-period.generator';
import { MoveOutsPeriodGenerator } from './generators/move-outs-period.generator';
import { OccupancySnapshotGenerator } from './generators/occupancy-snapshot.generator';
import { OwnerStatementGenerator } from './generators/owner-statement.generator';
import { PdfRenderer } from './renderers/pdf-renderer';
import { XlsxRenderer } from './renderers/xlsx-renderer';
import { ReportFileDownloadController } from './report-file-download.controller';
import { ReportSchedulesCron } from './report-schedules.cron';
import { ReportSchedulesService } from './report-schedules.service';
import { ReportsController } from './reports.controller';
import { ReportsProcessor } from './reports.processor';
import { REPORT_GENERATORS, ReportsService } from './reports.service';

const GENERATORS = [
  InvoicesPeriodGenerator,
  ContractsActiveGenerator,
  AgingGenerator,
  OccupancySnapshotGenerator,
  CollectionsMonthGenerator,
  MoveOutsPeriodGenerator,
  OwnerStatementGenerator,
  AnalyticsMonthGenerator,
  ...EXTRA_REPORT_GENERATORS,
];

/**
 * Sub-bloque 14A.1: `ReportsProcessor` solo se registra cuando
 * `ENABLE_WORKERS_IN_API=true`. `ReportsService` (que el controller usa
 * para encolar nuevos runs y consultar progreso) sigue siempre activo.
 */
@Module({
  imports: [AuthModule, OwnersModule, AnalyticsModule, TenantDataExportModule],
  controllers: [ReportsController, ReportFileDownloadController],
  providers: [
    ReportsService,
    ReportSchedulesService,
    PdfRenderer,
    XlsxRenderer,
    ...GENERATORS,
    // Todos los informes, en el orden del catálogo.
    { provide: REPORT_GENERATORS, useFactory: (...g: unknown[]) => g, inject: GENERATORS },
    ...(WORKERS_ENABLED_IN_API ? [ReportsProcessor, ReportSchedulesCron] : []),
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
