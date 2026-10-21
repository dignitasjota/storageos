import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AreaPagesModule } from '../area-pages/area-pages.module';
import { QUEUE_EMAIL } from '../queues/queue-names';

import { SearchConsoleClient } from './search-console.client';
import { SearchConsoleController } from './search-console.controller';
import { SearchConsoleCron } from './search-console.cron';
import { SearchConsoleService } from './search-console.service';
import { SeoReportService } from './seo-report.service';

@Module({
  imports: [AreaPagesModule, BullModule.registerQueue({ name: QUEUE_EMAIL })],
  controllers: [SearchConsoleController],
  providers: [
    SearchConsoleClient,
    SearchConsoleService,
    SeoReportService,
    ...(WORKERS_ENABLED_IN_API ? [SearchConsoleCron] : []),
  ],
  exports: [SearchConsoleService],
})
export class SearchConsoleModule {}
