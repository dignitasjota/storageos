import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';
import { TaskRulesController } from './task-rules.controller';
import { TaskRulesService } from './task-rules.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  // TaskRulesController antes que TasksController: `tasks/auto-rules` no es un `:id`.
  controllers: [TaskRulesController, TasksController, IncidentsController],
  providers: [TasksService, IncidentsService, TaskRulesService],
  exports: [TasksService, IncidentsService],
})
export class OperationsModule {}
