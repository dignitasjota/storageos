import { Module } from '@nestjs/common';

import { CronMonitorService } from './cron-monitor.service';

/** Registra las ejecuciones de las tareas programadas (API y worker). */
@Module({ providers: [CronMonitorService] })
export class CronMonitorModule {}
