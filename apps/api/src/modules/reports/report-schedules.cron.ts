import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ReportSchedulesService } from './report-schedules.service';

/** Cada cuarto de hora, los informes programados que tocan (en el worker). */
@Injectable()
export class ReportSchedulesCron {
  private readonly logger = new Logger(ReportSchedulesCron.name);

  constructor(private readonly schedules: ReportSchedulesService) {}

  @Cron('*/15 * * * *', { name: 'reports.schedules' })
  async run(): Promise<void> {
    try {
      const sent = await this.schedules.runDue();
      if (sent > 0) this.logger.log(`Informes programados enviados: ${sent}`);
    } catch (err) {
      this.logger.error(`Informes programados: ${err instanceof Error ? err.message : err}`);
    }
  }
}
