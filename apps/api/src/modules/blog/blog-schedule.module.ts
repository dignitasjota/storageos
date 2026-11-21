import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';

import { BlogScheduleCron } from './blog-schedule.cron';
import { BlogScheduleService } from './blog-schedule.service';

/**
 * Publicación programada del blog. Módulo aparte (sin la IA ni la web) para
 * que el worker lo cargue ligero; el cron solo se monta donde corren los
 * workers (en el worker en producción).
 */
@Module({
  imports: [AuthModule],
  providers: [BlogScheduleService, ...(WORKERS_ENABLED_IN_API ? [BlogScheduleCron] : [])],
  exports: [BlogScheduleService],
})
export class BlogScheduleModule {}
