import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { TodayWatchService } from './today-watch.service';

@Injectable()
export class TodayWatchCron {
  private readonly logger = new Logger(TodayWatchCron.name);

  constructor(private readonly watch: TodayWatchService) {}

  @Cron('*/5 * * * *', { name: 'today-watch.check' })
  async run(): Promise<void> {
    try {
      await this.watch.check();
    } catch (err) {
      this.logger.error(`today-watch.check falló: ${(err as Error).message}`);
    }
  }
}
