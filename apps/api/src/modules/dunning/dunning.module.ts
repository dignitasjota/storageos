import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { QUEUE_DUNNING } from '../queues/queues.module';

import { DunningController } from './dunning.controller';
import { DunningService } from './dunning.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: QUEUE_DUNNING })],
  controllers: [DunningController],
  providers: [DunningService],
})
export class DunningModule {}
