import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AccountantExportService } from '../billing-saas/accountant-export.service';
import { EmailModule } from '../email/email.module';

import { AccountantReportDownloadController } from './accountant-report-download.controller';
import { AccountantReportCron } from './accountant-report.cron';
import { AccountantReportService } from './accountant-report.service';
import { FiscalPeriodsService } from './fiscal-periods.service';
import { FiscalController } from './fiscal.controller';
import { FiscalService } from './fiscal.service';

/**
 * Informes fiscales (España): libros de facturas emitidas y recibidas,
 * modelos 303 y 347, retenciones (111 y 115), revisión y cierre del trimestre
 * y envío a la asesoría.
 */
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [FiscalController, AccountantReportDownloadController],
  providers: [
    FiscalService,
    FiscalPeriodsService,
    AccountantExportService,
    AccountantReportService,
    AccountantReportCron,
  ],
  exports: [FiscalService],
})
export class FiscalModule {}
