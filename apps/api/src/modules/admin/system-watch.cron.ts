import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SystemWatchService } from './system-watch.service';

@Injectable()
export class SystemWatchCron {
  private readonly logger = new Logger(SystemWatchCron.name);

  constructor(private readonly watch: SystemWatchService) {}

  @Cron('*/10 * * * *', { name: 'system-watch.check' })
  async run(): Promise<void> {
    try {
      await this.watch.check();
    } catch (err) {
      this.logger.error(`system-watch.check falló: ${(err as Error).message}`);
    }
  }
}
