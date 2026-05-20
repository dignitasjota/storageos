import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [AuthModule],
  controllers: [TasksController, IncidentsController],
  providers: [TasksService, IncidentsService],
  exports: [TasksService, IncidentsService],
})
export class OperationsModule {}
