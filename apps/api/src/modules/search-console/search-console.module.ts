import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { SearchConsoleClient } from './search-console.client';
import { SearchConsoleController } from './search-console.controller';
import { SearchConsoleCron } from './search-console.cron';
import { SearchConsoleService } from './search-console.service';

@Module({
  controllers: [SearchConsoleController],
  providers: [
    SearchConsoleClient,
    SearchConsoleService,
    ...(WORKERS_ENABLED_IN_API ? [SearchConsoleCron] : []),
  ],
  exports: [SearchConsoleService],
})
export class SearchConsoleModule {}
