import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { BlogScheduleService } from './blog-schedule.service';

/**
 * Cada 5 minutos publica las entradas del blog programadas. Solo se registra
 * cuando `ENABLE_WORKERS_IN_API=true` (corre en el worker en producción).
 */
@Injectable()
export class BlogScheduleCron {
  constructor(private readonly service: BlogScheduleService) {}

  @Cron('*/5 * * * *', { name: 'blog.publish-scheduled' })
  async run(): Promise<{ published: number }> {
    return this.service.publishDue();
  }
}
